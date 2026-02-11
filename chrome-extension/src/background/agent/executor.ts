import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import { DownloadManager } from '../services/downloadManager';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );
    // Attach download manager (requires "downloads" permission)
    context.downloadManager = new DownloadManager();

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        // === 下载检测兜底逻辑（轮询 chrome.downloads）===
        // 如果此时上下文中还没有正在追踪的下载任务，但当前 tab 在最近 10s 内有过下载，
        // 就通过 DownloadManager.findLatestDownloadSince 主动「接管」这个下载。
        if (!context.downloadState?.inProgress && context.downloadManager) {
          try {
            const currentPage = await context.browserContext.getCurrentPage();
            const sinceMs = Date.now() - 10_000; // look back 10 seconds
            const snapshot = await context.downloadManager.findLatestDownloadSince({
              sinceMs,
              tabId: currentPage.tabId,
            });
            if (snapshot && snapshot.state !== 'complete') {
              logger.info('[Executor] 兜底检测到下载任务，准备接管', snapshot);
              context.downloadState = {
                inProgress: true,
                downloadId: snapshot.downloadId,
                startedAtMs: Date.now(),
              };
              await context.emitEvent(
                Actors.NAVIGATOR,
                ExecutionState.ACT_START,
                `Download detected (fallback, id=${snapshot.downloadId})`,
              );
            }
          } catch (error) {
            logger.info(
              `Failed to run download fallback detection: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // === 下载进行中：阻塞其余 Agent 工作，直到下载结束 ===
        if (context.downloadState?.inProgress && context.downloadManager) {
          const { downloadId } = context.downloadState;
          await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `Downloading... (id=${downloadId})`);

          let lastDownloadState: string | undefined;
          const result = await context.downloadManager.waitForCompletion(downloadId, {
            signal: context.controller.signal,
            onProgress: async snapshot => {
              const { state, percent, bytesReceived, totalBytes, filename } = snapshot;
              if (!state) {
                return;
              }

              // Only emit when the download state actually changes
              if (state === lastDownloadState) {
                return;
              }
              lastDownloadState = state;

              let progressDetail = '';
              if (percent !== null && percent !== undefined) {
                progressDetail = `${percent}%`;
              } else if (
                bytesReceived !== undefined &&
                totalBytes !== undefined &&
                totalBytes > 0
              ) {
                progressDetail = `${bytesReceived}/${totalBytes}`;
              } else if (bytesReceived !== undefined) {
                progressDetail = `${bytesReceived}`;
              }

              const fileText = filename ? ` ${filename.split('/').pop()}` : '';

              // Map chrome.downloads state to execution state
              let execState: ExecutionState = ExecutionState.ACT_START;
              if (state === 'complete') {
                execState = ExecutionState.ACT_OK;
              } else if (state === 'interrupted') {
                execState = ExecutionState.ACT_FAIL;
              }

              const stateLabel = state;
              const message = progressDetail
                ? `Download ${stateLabel}: ${progressDetail}${fileText}`
                : `Download ${stateLabel}${fileText}`;

              await context.emitEvent(Actors.NAVIGATOR, execState, message);
            },
          });

          logger.info('[Executor] 下载等待结束', result);
          context.downloadState.inProgress = false;

          if (result.success) {
            await context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_START,
              `Download completed: ${result.filename ?? `id=${result.downloadId}`}`,
            );
          } else {
            await context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_FAIL,
              `Download failed (${result.state}): ${result.error ?? ''}`.trim(),
            );
          }

          // === 下载结果写入记忆，让 Planner 能感知本次下载状态 ===
          // 这里不直接判断「整体任务是否完成」，而是把“本次下载结果”作为 ActionResult
          // 写入 context.actionResults，后续 Navigator 在 addStateMessageToMemory 时会把它
          // 转成一条 HumanMessage，供 Planner 阅读和决策。
          const downloadSummaryParts: string[] = [];
          downloadSummaryParts.push(
            result.success ? '下载完成' : `下载未完成，状态: ${result.state}${result.error ? `，错误: ${result.error}` : ''}`,
          );
          if (result.filename) {
            downloadSummaryParts.push(`文件: ${result.filename}`);
          }
          if (result.url) {
            downloadSummaryParts.push(`来源 URL: ${result.url}`);
          }
          const downloadSummary = downloadSummaryParts.join('；');

          context.actionResults.push(
            new ActionResult({
              extractedContent: `[下载结果] ${downloadSummary}`,
              includeInMemory: true,
            }),
          );

          // 下载任务结束后，直接告知planner当前任务下载完成执行agent，就不需要再走navigator，节约执行时间
          logger.info('[Executor] 下载任务完成，直接运行planner，跳过navigator');
          latestPlanOutput = await this.runPlanner();
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }

          // Continue loop after download handling (don't run navigator in same iteration)
          // 下载任务完成后，直接跳过navigator，继续下一轮循环
          continue;
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      // 打印整次任务的 LLM token 和时间开销，便于统计成本
      const stats = this.context.llmStats;
      if (stats) {
        // 统计总调用次数
        const totalLLMCalls = Object.values(stats.byAgent).reduce((sum, s) => sum + s.calls, 0);

        // 按 GLM-4.7 官方单价计算本次任务成本（单位：美元）
        // 参考价格：输入 $0.40 / 1M tokens，输出 $1.50 / 1M tokens
        const GLM47_INPUT_PRICE_PER_M = 0.4;
        const GLM47_OUTPUT_PRICE_PER_M = 1.5;
        const glm47CostUSD =
          (stats.totalPromptTokens / 1_000_000) * GLM47_INPUT_PRICE_PER_M +
          (stats.totalCompletionTokens / 1_000_000) * GLM47_OUTPUT_PRICE_PER_M;

        logger.info(
          '[Executor] Task LLM cost statistics',
          JSON.stringify(
            {
              taskId: this.context.taskId,
              // 总 token & 时长
              totalPromptTokens: stats.totalPromptTokens,
              totalCompletionTokens: stats.totalCompletionTokens,
              totalTokens: stats.totalTokens,
              totalDurationMs: stats.totalDurationMs,
              totalDurationSeconds: (stats.totalDurationMs / 1000).toFixed(2),
              // 调用次数统计
              totalLLMCalls,
              // 基于 GLM-4.7 单价的本次任务成本估算
              glm47Pricing: {
                inputPricePerMTokensUSD: GLM47_INPUT_PRICE_PER_M,
                outputPricePerMTokensUSD: GLM47_OUTPUT_PRICE_PER_M,
                estimatedCostUSD: Number(glm47CostUSD.toFixed(6)),
              },
              // 分 agent 统计
              byAgent: Object.fromEntries(
                Object.entries(stats.byAgent).map(([agentId, s]) => [
                  agentId,
                  {
                    calls: s.calls,
                    promptTokens: s.promptTokens,
                    completionTokens: s.completionTokens,
                    totalTokens: s.totalTokens,
                    totalDurationMs: s.totalDurationMs,
                    totalDurationSeconds: (s.totalDurationMs / 1000).toFixed(2),
                  },
                ]),
              ),
            },
            null,
            2,
          ),
        );
      }

      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
