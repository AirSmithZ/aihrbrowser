import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { z } from 'zod';
import type { AgentOutput } from '../types';
import { HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isForbiddenError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { filterExternalContent } from '../messages/utils';
const logger = createLogger('PlannerAgent');

// Define Zod schema for planner output
export const plannerOutputSchema = z.object({
  observation: z.string(),
  challenges: z.string(),
  done: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
  next_steps: z.string(),
  final_answer: z.string(),
  reasoning: z.string(),
  web_task: z.union([
    z.boolean(),
    z.string().transform(val => {
      if (val.toLowerCase() === 'true') return true;
      if (val.toLowerCase() === 'false') return false;
      throw new Error('Invalid boolean string');
    }),
  ]),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

/**
 * Navigator-shaped object: some gateways return Navigator format (action + current_state)
 * for all agents. When Planner receives this, we map it to PlannerOutput so execution can continue.
 */
interface NavigatorShapedArgs {
  action?: unknown[];
  current_state?: {
    evaluation_previous_goal?: string;
    memory?: string;
    next_goal?: string;
  };
}

function isNavigatorShaped(obj: unknown): obj is NavigatorShapedArgs {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    Array.isArray(o.action) &&
    !!o.current_state &&
    typeof o.current_state === 'object'
  );
}

/**
 * Map Navigator-shaped tool_call args to PlannerOutput. Used when gateway returns
 * Navigator format for Planner (e.g. single tool schema for all agents).
 */
export function mapNavigatorShapeToPlannerOutput(parsedArgs: NavigatorShapedArgs): PlannerOutput {
  const state = parsedArgs.current_state ?? {};
  const memory = typeof state.memory === 'string' ? state.memory : '';
  const nextGoal = typeof state.next_goal === 'string' ? state.next_goal : '';
  const evalPrev = typeof state.evaluation_previous_goal === 'string' ? state.evaluation_previous_goal : '';
  const observation = [evalPrev, nextGoal].filter(Boolean).join(' ') || memory.slice(0, 500) || '当前状态已更新';
  const actionDesc =
    Array.isArray(parsedArgs.action) && parsedArgs.action.length > 0
      ? JSON.stringify(parsedArgs.action)
      : '';
  const next_steps = nextGoal || (actionDesc ? `执行动作: ${actionDesc}` : '继续执行当前计划');
  return {
    observation,
    challenges: '',
    done: false,
    next_steps,
    final_answer: '',
    reasoning: '网关返回了 Navigator 格式，已转换为计划步骤继续执行。',
    web_task: true,
  };
}

export class PlannerAgent extends BaseAgent<typeof plannerOutputSchema, PlannerOutput> {
  constructor(options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    super(plannerOutputSchema, options, { ...extraOptions, id: 'planner' });
  }

  /**
   * When gateway returns Navigator-shaped output for Planner, map it to PlannerOutput
   * so we don't fail with schema validation.
   */
  tryMapNavigatorShapeToOutput(
    parsedArgs: Record<string, unknown>,
  ): PlannerOutput | undefined {
    if (!isNavigatorShaped(parsedArgs)) return undefined;
    logger.debug('[PlannerAgent] Mapping Navigator-shaped response to PlannerOutput');
    return mapNavigatorShapeToPlannerOutput(parsedArgs as NavigatorShapedArgs);
  }

  async execute(): Promise<AgentOutput<PlannerOutput>> {
    try {
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...');
      // get all messages from the message manager, state message should be the last one
      const messages = this.context.messageManager.getMessages();
      // Use full message history except the first one
      const plannerMessages = [this.prompt.getSystemMessage(), ...messages.slice(1)];

      // Remove images from last message if vision is not enabled for planner but vision is enabled
      if (!this.context.options.useVisionForPlanner && this.context.options.useVision) {
        const lastStateMessage = plannerMessages[plannerMessages.length - 1];
        let newMsg = '';

        if (Array.isArray(lastStateMessage.content)) {
          for (const msg of lastStateMessage.content) {
            if (msg.type === 'text') {
              newMsg += msg.text;
            }
            // Skip image_url messages
          }
        } else {
          newMsg = lastStateMessage.content;
        }

        plannerMessages[plannerMessages.length - 1] = new HumanMessage(newMsg);
      }

      const modelOutput = await this.invoke(plannerMessages);
      if (!modelOutput) {
        throw new Error('Failed to validate planner output');
      }

      // clean the model output
      const observation = filterExternalContent(modelOutput.observation);
      const final_answer = filterExternalContent(modelOutput.final_answer);
      const next_steps = filterExternalContent(modelOutput.next_steps);
      const challenges = filterExternalContent(modelOutput.challenges);
      const reasoning = filterExternalContent(modelOutput.reasoning);

      const cleanedPlan: PlannerOutput = {
        ...modelOutput,
        observation,
        challenges,
        reasoning,
        final_answer,
        next_steps,
      };

      // If task is done, emit the final answer; otherwise emit next steps
      const eventMessage = cleanedPlan.done ? cleanedPlan.final_answer : cleanedPlan.next_steps;
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, eventMessage);
      logger.info('Planner output', JSON.stringify(cleanedPlan, null, 2));

      return {
        id: this.id,
        result: cleanedPlan,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      }

      logger.error(`Planning failed: ${errorMessage}`);
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_FAIL, `Planning failed: ${errorMessage}`);
      return {
        id: this.id,
        error: errorMessage,
      };
    }
  }
}
