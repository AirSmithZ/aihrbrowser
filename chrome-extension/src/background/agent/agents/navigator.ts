import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { agentBrainSchema } from '../types';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import { t } from '@extension/i18n';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ChatModelServiceUnavailableError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  isServiceUnavailableError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { extractUsage, logLLMUsage } from '../llm-usage-log';
import { extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { calcBranchPathHashSet } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory } from '@src/background/browser/views';
import { convertZodToJsonSchema, repairJsonString } from '@src/background/utils';
import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { AgentStepRecord } from '../history';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';

const logger = createLogger('NavigatorAgent');

interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}

/** Model may return these names; map to registered action names. */
const ACTION_NAME_ALIASES: Record<string, string> = {
  switch_to_tab: 'switch_tab',
};

export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    const resolved = ACTION_NAME_ALIASES[name] ?? name;
    return this.actions[resolved];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

export interface NavigatorResult {
  done: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;

    // The zod object is too complex to be used directly, so we need to convert it to json schema first for the model to use
    this.jsonSchema = convertZodToJsonSchema(this.modelOutputSchema, 'NavigatorAgentOutput', true);
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    const startMs = Date.now();

    // Use structured output
    if (this.withStructuredOutput) {
      const structuredLlm = this.chatLLM.withStructuredOutput(this.jsonSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        const elapsedMs = Date.now() - startMs;
        const usage = response?.raw ? extractUsage(response.raw) : null;
        logLLMUsage(this.id, this.modelName, usage, elapsedMs);

        if (response.parsed) {
          return response.parsed;
        }
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from raw response manually if possible
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (response?.raw) {
          // First try to parse from content string
          if (response.raw.content && typeof response.raw.content === 'string') {
            const parsed = this.manuallyParseResponse(response.raw.content);
            if (parsed) {
              logger.debug(`[${this.modelName}] Successfully parsed JSON from raw content after structured output failure`);
              return parsed;
            }
          }
          
          // Also check for tool_calls in raw response (for Claude-style providers)
          const rawMessage = response.raw as any;
          if (rawMessage.tool_calls && Array.isArray(rawMessage.tool_calls) && rawMessage.tool_calls.length > 0) {
            const firstToolCall = rawMessage.tool_calls[0];
            
            // Handle different tool_call structures
            let parsedArgs: any = null;
            
            // Structure 1: LangChain processed format { name: string, args: object }
            if (firstToolCall?.args && typeof firstToolCall.args === 'object' && !Array.isArray(firstToolCall.args)) {
              parsedArgs = firstToolCall.args;
            }
            // Structure 2: OpenAI format { function: { name: string, arguments: string } }
            else if (firstToolCall?.function?.arguments && typeof firstToolCall.function.arguments === 'string') {
              try {
                parsedArgs = JSON.parse(firstToolCall.function.arguments);
              } catch (parseError) {
                logger.warning(`[${this.modelName}] Failed to parse function.arguments:`, parseError);
              }
            }
            
            if (parsedArgs && typeof parsedArgs === 'object') {
              // Fix: Handle double-escaped JSON strings (with repair + fallback for current_state)
              if (parsedArgs.current_state && typeof parsedArgs.current_state === 'string') {
                const raw = parsedArgs.current_state;
                try {
                  parsedArgs.current_state = JSON.parse(raw);
                } catch {
                  try {
                    parsedArgs.current_state = JSON.parse(repairJsonString(raw));
                  } catch {
                    parsedArgs.current_state = {
                      evaluation_previous_goal: '',
                      memory: raw.slice(0, 2000),
                      next_goal: '',
                    };
                  }
                }
              }
              if (parsedArgs.action && typeof parsedArgs.action === 'string') {
                const rawAction = parsedArgs.action;
                try {
                  parsedArgs.action = JSON.parse(rawAction);
                } catch {
                  try {
                    parsedArgs.action = JSON.parse(repairJsonString(rawAction));
                  } catch {
                    // keep as-is
                  }
                }
              }
              
              try {
                const validated = this.validateModelOutput(parsedArgs);
                if (validated) {
                  logger.debug(`[${this.modelName}] Successfully parsed JSON from tool_calls arguments after structured output failure`);
                  return validated;
                }
              } catch (parseError) {
                logger.warning(`[${this.modelName}] Failed to validate tool_calls arguments:`, parseError);
              }
            }
          }
        }
        
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      // Use type assertion to access the properties
      const rawResponse = response.raw as BaseMessage & {
        tool_calls?: Array<{
          name?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
          args?: any; // Can be object (LangChain processed) or string
          arguments?: string;
          type?: string;
          id?: string;
        }>;
      };

      // sometimes LLM returns an empty content, but with one or more tool calls, so we need to check the tool calls
      if (rawResponse.tool_calls && rawResponse.tool_calls.length > 0) {
        const toolCall = rawResponse.tool_calls[0];
        logger.debug('Navigator found tool_calls in raw response:', JSON.stringify(toolCall, null, 2));
        
        let parsedArgs: any = null;
        
        // Handle LangChain's processed tool_calls format (args is already an object)
        if (toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)) {
          logger.info('Navigator: Found LangChain processed tool_call.args (object)');
          parsedArgs = toolCall.args;
        }
        // Handle OpenAI-compatible tool_calls format (function.arguments is a JSON string)
        else if (toolCall.function?.arguments && typeof toolCall.function.arguments === 'string') {
          logger.info('Navigator: Found OpenAI format tool_call.function.arguments (string)');
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch (parseError) {
            logger.warning('Navigator failed to parse tool_calls.function.arguments:', parseError);
          }
        }
        // Handle args as string
        else if (toolCall.args && typeof toolCall.args === 'string') {
          logger.info('Navigator: Found tool_call.args (string)');
          try {
            parsedArgs = JSON.parse(toolCall.args);
          } catch (parseError) {
            logger.warning('Navigator failed to parse tool_call.args string:', parseError);
          }
        }
        // Handle direct arguments field
        else if (toolCall.arguments && typeof toolCall.arguments === 'string') {
          logger.info('Navigator: Found tool_call.arguments (string)');
          try {
            parsedArgs = JSON.parse(toolCall.arguments);
          } catch (parseError) {
            logger.warning('Navigator failed to parse tool_call.arguments:', parseError);
          }
        }

        if (parsedArgs && typeof parsedArgs === 'object') {
          try {
            // Fix: Handle double-escaped JSON strings in current_state field (repair + fallback)
            if (parsedArgs.current_state && typeof parsedArgs.current_state === 'string') {
              const raw = parsedArgs.current_state;
              try {
                logger.debug('Navigator: current_state is a string, parsing it as JSON');
                parsedArgs.current_state = JSON.parse(raw);
                logger.debug('Navigator: Successfully parsed current_state from string to object');
              } catch (parseError) {
                try {
                  parsedArgs.current_state = JSON.parse(repairJsonString(raw));
                  logger.debug('Navigator: Parsed current_state after repairJsonString');
                } catch (repairError) {
                  logger.warning('Navigator: Failed to parse current_state (parse + repair):', parseError);
                  parsedArgs.current_state = {
                    evaluation_previous_goal: '',
                    memory: raw.slice(0, 2000),
                    next_goal: '',
                  };
                }
              }
            }

            // Fix: Handle action field that might be a JSON string instead of an array
            if (parsedArgs.action && typeof parsedArgs.action === 'string') {
              const rawAction = parsedArgs.action;
              try {
                logger.debug('Navigator: action is a string, parsing it as JSON');
                parsedArgs.action = JSON.parse(rawAction);
                logger.debug('Navigator: Successfully parsed action from string to array');
              } catch (parseError) {
                try {
                  parsedArgs.action = JSON.parse(repairJsonString(rawAction));
                  logger.debug('Navigator: Parsed action after repairJsonString');
                } catch (repairError) {
                  logger.warning('Navigator: Failed to parse action (parse + repair):', parseError);
                }
              }
            }

            const validated = this.validateModelOutput(parsedArgs);
            if (validated) {
              logger.info('Navigator successfully extracted and validated JSON from tool_calls');
              return validated;
            } else {
              logger.warning('Navigator: validateModelOutput returned undefined');
            }
          } catch (validationError) {
            logger.warning('Navigator failed to validate parsed tool_calls arguments:', validationError);
            logger.warning('Navigator: Parsed args that failed validation:', JSON.stringify(parsedArgs, null, 2));
          }
        } else {
          logger.warning('Navigator: tool_calls found but could not extract valid arguments. Tool call structure:', JSON.stringify(toolCall, null, 2));
        }
      }
      throw new ResponseParseError('Could not parse navigator response');
    }

    // Fallback to parent class manual JSON extraction for models without structured output support
    return super.invoke(inputMessages);
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];

    try {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');

      const messageManager = this.context.messageManager;
      // add the browser state message
      await this.addStateMessageToMemory();
      const currentState = await this.context.browserContext.getCachedState();
      browserStateHistory = new BrowserStateHistory(currentState);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);

      const modelOutput = await this.invoke(inputMessages);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      modelOutput.action = actions;
      modelOutputString = JSON.stringify(modelOutput);

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      // take the actions
      actionResults = await this.doMultiAction(actions);
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      this.context.actionResults = actionResults;

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (isServiceUnavailableError(error)) {
        throw new ChatModelServiceUnavailableError(t('exec_errors_serviceUnavailable'), error);
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(errorString);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, errorString);
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(`Action result: ${r.extractedContent}`);
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(`Action error: ${lastLine}`);
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    this.context.stateMessageAdded = true;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Relaxed fallback when strict schema validation fails: normalize current_state and action
   * so that fixActions/doMultiAction can still execute (e.g. GLM returns valid shape but schema differs).
   */
  private tryRelaxedNavigatorOutput(parsed: Record<string, unknown>): this['ModelOutput'] | undefined {
    const cs = parsed.current_state;
    const actionRaw = parsed.action;
    if (!cs || typeof cs !== 'object' || !Array.isArray(actionRaw) || actionRaw.length === 0) return undefined;
    const state = cs as Record<string, unknown>;
    const evaluation_previous_goal =
      typeof state.evaluation_previous_goal === 'string' ? state.evaluation_previous_goal : '';
    const memory = typeof state.memory === 'string' ? state.memory : '';
    const next_goal = typeof state.next_goal === 'string' ? state.next_goal : '';
    const action: Record<string, unknown>[] = [];
    for (const item of actionRaw) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item as object).filter(k => (item as Record<string, unknown>)[k] != null);
        if (keys.length === 1) action.push({ [keys[0]]: (item as Record<string, unknown>)[keys[0]] });
      }
    }
    if (action.length === 0) return undefined;
    const normalized = {
      current_state: { evaluation_previous_goal, memory, next_goal },
      action,
    };
    const validated = this.validateModelOutput(normalized);
    if (validated) return validated;
    return normalized as this['ModelOutput'];
  }

  protected override manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const out = super.manuallyParseResponse(content);
    if (out) return out;
    try {
      const cleaned = removeThinkTags(content);
      const extracted = extractJsonFromModelOutput(cleaned);
      return this.tryRelaxedNavigatorOutput(extracted);
    } catch {
      return undefined;
    }
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // skip null and items that are not single-key objects (avoids "Action undefined not exists")
      actions = response.action.filter((item: unknown) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        const keys = Object.keys(item as object).filter(k => (item as Record<string, unknown>)[k] != null);
        return keys.length === 1 && !!keys[0];
      }) as Record<string, unknown>[];
      if (actions.length === 0) {
        logger.warning('No valid actions found', response.action);
      }
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      // if the action is neither an array nor a string, it should be an object
      actions = [response.action];
    }
    return actions;
  }

  private async doMultiAction(actions: Record<string, unknown>[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    logger.info('Actions', actions);

    const browserContext = this.context.browserContext;
    const browserState = await browserContext.getState(this.context.options.useVision);
    const cachedPathHashes = await calcBranchPathHashSet(browserState);

    await browserContext.removeHighlight();

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        if (actionName === undefined || actionName === '') {
          logger.warning('Skipping action with no name', { action, index: i });
          results.push(
            new ActionResult({ error: 'Action has no name', isDone: false, includeInMemory: true }),
          );
          continue;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        if (i > 0 && indexArg !== null) {
          const newState = await browserContext.getState(this.context.options.useVision);
          const newPathHashes = await calcBranchPathHashSet(newState);
          // next action requires index but there are new elements on the page
          if (!newPathHashes.isSubsetOf(cachedPathHashes)) {
            const msg = `Something new appeared after action ${i} / ${actions.length}`;
            logger.info(msg);
            results.push(
              new ActionResult({
                extractedContent: msg,
                includeInMemory: true,
              }),
            );
            break;
          }
        }

        const result = await actionInstance.call(actionArgs);
        if (result === undefined) {
          throw new Error(`Action ${actionName} returned undefined`);
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = browserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.info('Interacted element', interactedElement);
            logger.info('Result', result);
          }
        }
        results.push(result);

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // TODO: wait for 1 second for now, need to optimize this to avoid unnecessary waiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage);
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
      }
    }
    return results;
  }

  /**
   * Parse and validate model output from history item
   */
  private parseHistoryModelOutput(historyItem: AgentStepRecord): {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  } {
    if (!historyItem.modelOutput) {
      throw new Error('No model output found in history item');
    }

    let parsedOutput: ParsedModelOutput;
    try {
      parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
    } catch (error) {
      throw new Error(`Could not parse modelOutput: ${error}`);
    }

    // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

    const goal = parsedOutput?.current_state?.next_goal || '';
    const actionsToReplay = parsedOutput?.action;

    // Validate that there are actions to replay
    if (
      !parsedOutput || // No model output string at all
      !actionsToReplay || // 'action' field is missing or null after parsing
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
    ) {
      throw new Error('No action to replay');
    }

    return { parsedOutput, goal, actionsToReplay };
  }

  /**
   * Execute actions from history with element index updates
   */
  private async executeHistoryActions(
    parsedOutput: ParsedModelOutput,
    historyItem: AgentStepRecord,
    delay: number,
  ): Promise<ActionResult[]> {
    const state = await this.context.browserContext.getState(this.context.options.useVision);
    if (!state) {
      throw new Error('Invalid browser state');
    }

    const updatedActions: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < parsedOutput.action!.length; i++) {
      const result = historyItem.result[i];
      if (!result) {
        break;
      }
      const interactedElement = result.interactedElement;
      const currentAction = parsedOutput.action![i];

      // Skip null actions
      if (currentAction === null) {
        updatedActions.push(null);
        continue;
      }

      // If there's no interacted element, just use the action as is
      if (!interactedElement) {
        updatedActions.push(currentAction);
        continue;
      }

      const updatedAction = await this.updateActionIndices(interactedElement, currentAction, state);
      updatedActions.push(updatedAction);

      if (updatedAction === null) {
        throw new Error(`Could not find matching element ${i} in current page`);
      }
    }

    logger.debug('updatedActions', updatedActions);

    // Filter out null values and cast to the expected type
    const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
    const result = await this.doMultiAction(validActions);

    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delay));
    return result;
  }

  async executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ): Promise<ActionResult[]> {
    const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
    const results: ActionResult[] = [];

    // Parse and validate model output
    let parsedData: {
      parsedOutput: ParsedModelOutput;
      goal: string;
      actionsToReplay: (Record<string, unknown> | null)[] | null;
    };
    try {
      parsedData = this.parseHistoryModelOutput(historyItem);
    } catch (error) {
      const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      replayLogger.warning(errorMsg);
      return [
        new ActionResult({
          error: errorMsg,
          includeInMemory: false,
        }),
      ];
    }

    const { parsedOutput, goal, actionsToReplay } = parsedData;
    replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
    replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

    // Try to execute the step with retries
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history actions
        const stepResults = await this.executeHistoryActions(parsedOutput, historyItem, delay);
        results.push(...stepResults);
        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (retryCount >= maxRetries) {
          const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
          replayLogger.error(failMsg);

          results.push(
            new ActionResult({
              error: failMsg,
              includeInMemory: true,
            }),
          );

          if (!skipFailures) {
            throw new Error(failMsg);
          }
        } else {
          replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return results;
  }

  async updateActionIndices(
    historicalElement: DOMHistoryElement,
    action: Record<string, unknown>,
    currentState: BrowserState,
  ): Promise<Record<string, unknown> | null> {
    // If no historical element or no element tree in current state, return the action unchanged
    if (!historicalElement || !currentState.elementTree) {
      return action;
    }

    // Find the current element in the tree based on the historical element
    const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
      historicalElement,
      currentState.elementTree,
    );

    // If no current element found or it doesn't have a highlight index, return null
    if (!currentElement || currentElement.highlightIndex === null) {
      return null;
    }

    // Get action name and args
    const actionName = Object.keys(action)[0];
    const actionArgs = action[actionName] as Record<string, unknown>;

    // Get the action instance to access the index
    const actionInstance = this.actionRegistry.getAction(actionName);
    if (!actionInstance) {
      return action;
    }

    // Get the index argument from the action
    const oldIndex = actionInstance.getIndexArg(actionArgs);

    // If the index has changed, update it
    if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
      // Create a new action object with the updated index
      const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

      // Update the index in the action arguments
      actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
      return updatedAction;
    }

    return action;
  }
}
