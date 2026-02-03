import { z } from 'zod';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { ActionResult, type AgentOutput, StepMetadata } from '../types';
import type { Action } from '../actions/builder';
import { buildDynamicActionSchema } from '../actions/builder';
import { agentBrainSchema } from '../types';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { calcBranchPathHashSet } from '@src/background/browser/dom/views';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '@src/background/browser/views';
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
    return this.actions[name];
  }

  // Expose all registered action names so we can robustly recover actions
  getActionNames(): string[] {
    return Object.keys(this.actions);
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

        if (response.parsed) {
          return response.parsed;
        }
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from markdown code blocks if parsing failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            return parsed;
          }
        }
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      // Use type assertion to access the properties
      const rawResponse = response.raw as BaseMessage & {
        tool_calls?: Array<{
          args: {
            currentState: typeof agentBrainSchema._type;
            action: z.infer<ReturnType<typeof buildDynamicActionSchema>>;
          };
        }>;
      };

      // sometimes LLM returns an empty content, but with one or more tool calls, so we need to check the tool calls
      if (rawResponse.tool_calls && rawResponse.tool_calls.length > 0) {
        logger.info('Navigator structuredLlm tool call with empty content', rawResponse.tool_calls);
        // only use the first tool call
        const toolCall = rawResponse.tool_calls[0];
        return {
          current_state: toolCall.args.currentState,
          action: [...toolCall.args.action],
        };
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
    const stepStartTime = Date.now();
    let inputTokens = 0;

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

      // Get input token count before LLM call
      inputTokens = messageManager.getTotalTokens();

      // call the model to get the actions to take
      const inputMessages = messageManager.getMessages();
      // logger.info('Navigator input message', inputMessages[inputMessages.length - 1]);
      logger.debug('Navigator input messages', {
        count: inputMessages.length,
        inputTokens,
      });
      
      const llmInvokeStartTime = Date.now();
      const modelOutput = await this.invoke(inputMessages);
      const llmInvokeEndTime = Date.now();
      
      logger.debug('Navigator LLM invoke completed', {
        durationMs: llmInvokeEndTime - llmInvokeStartTime,
        usage: this.getLastLLMUsage(),
      });

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      logger.debug('Navigator model output', {
        hasCurrentState: !!modelOutput.current_state,
        actionCount: Array.isArray(modelOutput.action) ? modelOutput.action.length : 0,
      });
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
      } else if (error instanceof URLNotAllowedError) {
        throw error;
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

        // Create step metadata with LLM usage information
        const stepEndTime = Date.now();
        const stepNumber = this.context.nSteps;
        const llmUsage = this.getLastLLMUsage();
        const llmDurationMs = this.getLastLLMDurationMs();
        const stepMetadata = new StepMetadata(
          stepStartTime,
          stepEndTime,
          inputTokens,
          stepNumber,
          llmUsage,
          llmDurationMs,
        );

        // Log step statistics
        logger.info(`[Navigator] Step ${stepNumber} completed:`, {
          durationSeconds: stepMetadata.durationSeconds.toFixed(2),
          llmDurationSeconds: stepMetadata.llmDurationSeconds.toFixed(2),
          inputTokens: stepMetadata.inputTokens,
          llmUsage: stepMetadata.llmUsage
            ? {
                promptTokens: stepMetadata.llmUsage.promptTokens,
                completionTokens: stepMetadata.llmUsage.completionTokens,
                totalTokens: stepMetadata.llmUsage.totalTokens,
              }
            : 'N/A',
          actionCount: actionResultsCopy.length,
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory, stepMetadata);
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
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // 过滤掉 null、非对象以及空对象（没有任何 action 名称）的项
      actions = response.action.filter((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return Object.keys(item as Record<string, unknown>).length > 0;
      }) as Record<string, unknown>[];
      if (actions.length === 0) {
        logger.warning('No valid actions found in navigator output', response.action);
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
    } else if (response.action && typeof response.action === 'object') {
      // 单个对象时，同样需要确保不是空对象
      const obj = response.action as Record<string, unknown>;
      if (Object.keys(obj).length > 0) {
        actions = [obj];
      } else {
        logger.warning('Navigator output action is an empty object, ignoring', obj);
      }
    } else if (response.action != null) {
      logger.warning('Navigator output action has unexpected type, ignoring', typeof response.action);
    }

    // Normalize/split actions and map aliases (e.g. switch_to_tab -> switch_tab)
    actions = this.normalizeAndSplitActions(actions);

    // 如果到这里依然没有解析出任何可执行的 action，尝试在整个 modelOutput 中智能挖掘
    if (actions.length === 0) {
      const recovered: Record<string, unknown>[] = [];
      const actionNames = this.actionRegistry.getActionNames();
      this.collectActionsFromAnyField(response, actionNames, recovered);
      actions = this.normalizeAndSplitActions(recovered);

      if (actions.length > 0) {
        logger.info('Recovered navigator actions from loose structure', actions);
      }
    }

    return actions;
  }

  private normalizeActionKey(rawKey: string): string {
    return rawKey
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/__+/g, '_');
  }

  /**
   * Resolve "near-synonym" / alias action names from LLM output into canonical local action names.
   * Keep this conservative to avoid accidental wrong actions.
   */
  private resolveActionName(rawKey: string): string | null {
    const key = this.normalizeActionKey(rawKey);
    const actionNames = this.actionRegistry.getActionNames();
    if (actionNames.includes(key)) return key;

    // Explicit aliases (common mismatch between different prompt/schema variants)
    const aliasMap: Record<string, string> = {
      switch_to_tab: 'switch_tab',
      switch_to_tabs: 'switch_tab',
      switch_tab_to: 'switch_tab',
      goto_url: 'go_to_url',
      go_to: 'go_to_url',
      click: 'click_element',
      click_item: 'click_element',
      click_button: 'click_element',
      input: 'input_text',
      type_text: 'input_text',
      enter_text: 'input_text',
      open_new_tab: 'open_tab',
      new_tab: 'open_tab',
      close_current_tab: 'close_tab',
      close_current_tabs: 'close_tab',
      search: 'search_google',
      google_search: 'search_google',
    };

    const aliased = aliasMap[key];
    if (aliased && actionNames.includes(aliased)) return aliased;

    // Heuristic fallbacks for very common variants (only when strongly indicated)
    // Note: we intentionally do NOT "remove _to_" globally because it would break go_to_url.
    const has = (s: string) => key.includes(s);
    const candidates: string[] = [];
    if (has('switch') && has('tab')) candidates.push('switch_tab');
    if ((has('go') || has('goto') || has('navigate')) && has('url')) candidates.push('go_to_url');
    if (has('click')) candidates.push('click_element');
    if ((has('input') || has('type') || has('enter')) && has('text')) candidates.push('input_text');
    if (has('open') && has('tab')) candidates.push('open_tab');
    if (has('close') && has('tab')) candidates.push('close_tab');
    if (has('search') && has('google')) candidates.push('search_google');
    if (has('send') && (has('key') || has('keys'))) candidates.push('send_keys');

    const uniq = [...new Set(candidates)].filter(c => actionNames.includes(c));
    return uniq.length === 1 ? uniq[0] : null;
  }

  /**
   * Some models may output one object containing multiple action keys (because the schema allows it),
   * or use alias keys. This normalizes them into an array of {canonicalActionName: args}.
   */
  private normalizeAndSplitActions(actions: Record<string, unknown>[]): Record<string, unknown>[] {
    const normalized: Record<string, unknown>[] = [];

    for (const actionObj of actions) {
      if (!actionObj || typeof actionObj !== 'object') continue;
      const entries = Object.entries(actionObj);
      for (const [rawKey, rawVal] of entries) {
        if (rawVal === null || rawVal === undefined) continue;
        if (typeof rawVal !== 'object') continue;

        const resolved = this.resolveActionName(rawKey);
        if (!resolved) {
          logger.warning(`Unknown action key from model output: "${rawKey}"`);
          continue;
        }
        normalized.push({ [resolved]: rawVal as Record<string, unknown> });
      }
    }

    return normalized;
  }

  /**
   * 深度遍历任意 JSON 结构，从中提取形如 {actionName: {...}} 的片段，
   * 其中 actionName 必须是当前已注册的 action 名称之一。
   */
  private collectActionsFromAnyField(
    node: unknown,
    actionNames: string[],
    out: Record<string, unknown>[],
  ): void {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectActionsFromAnyField(item, actionNames, out);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      const matchedKeys = keys.filter(k => this.resolveActionName(k) !== null);

      // 如果当前对象本身就长得像一个 action（只包含一个合法 action 名称），直接加入候选
      if (matchedKeys.length === 1) {
        const rawKey = matchedKeys[0];
        const resolvedKey = this.resolveActionName(rawKey);
        if (!resolvedKey) {
          // should not happen due to matchedKeys filter
          return;
        }

        const value = obj[rawKey];
        if (value && typeof value === 'object') {
          out.push({ [resolvedKey]: value as Record<string, unknown> });
        }
      }
    }

    // 继续递归遍历所有子字段，尽量挖掘嵌套结构中的 action 片段
    for (const value of Object.values(obj)) {
      this.collectActionsFromAnyField(value, actionNames, out);
    }
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
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
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
