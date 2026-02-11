import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput, LLMUsage } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { isAbortedError, ResponseParseError } from './errors';
import { ProviderTypeEnum } from '@extension/storage';

const logger = createLogger('agent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  protected lastLLMUsage?: LLMUsage;
  protected lastLLMDurationMs?: number;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethod = this.setToolCallingMethod(extraOptions?.toolCallingMethod);
    this.callOptions = extraOptions?.callOptions;
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(): string {
    if ('modelName' in this.chatLLM) {
      return this.chatLLM.modelName as string;
    }
    if ('model_name' in this.chatLLM) {
      return this.chatLLM.model_name as string;
    }
    if ('model' in this.chatLLM) {
      return this.chatLLM.model as string;
    }
    return 'Unknown';
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Check if model is 智谱 GLM (Zhipu); returns JSON in message.content wrapped in ```json
  private isGlmModel(modelName: string): boolean {
    return modelName.includes('GLM-') || modelName.toLowerCase().includes('glm-');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // 智谱 GLM returns JSON in content with ```json code block, not tool_calls
    if (this.isGlmModel(this.modelName)) {
      logger.debug(`[${this.modelName}] GLM returns JSON in content, using manual JSON extraction`);
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    this.lastLLMUsage = undefined;
    this.lastLLMDurationMs = undefined;
    // 尝试用消息管理器估算本次调用的输入 token 数，作为没有返回 usage 时的兜底
    let estimatedPromptTokens = 0;
    try {
      const mm = (this.context as AgentContext | undefined)?.messageManager as
        | { getTotalTokens?: () => number }
        | undefined;
      if (mm?.getTotalTokens) {
        estimatedPromptTokens = mm.getTotalTokens() ?? 0;
      }
    } catch {
      estimatedPromptTokens = 0;
    }

    // Use structured output
    if (this.withStructuredOutput) {
      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        const llmStartTime = Date.now();
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });
        this.lastLLMDurationMs = Date.now() - llmStartTime;

        // Extract usage information from response
        this.extractUsageFromResponse(response);

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
          usage: this.lastLLMUsage,
          durationMs: this.lastLLMDurationMs,
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          // 如果模型没有返回 usage，就用估算的输入 token 兜底
          if (!this.lastLLMUsage && estimatedPromptTokens > 0) {
            this.lastLLMUsage = {
              promptTokens: estimatedPromptTokens,
              completionTokens: 0,
              totalTokens: estimatedPromptTokens,
            };
          }
          this.recordLLMUsage();
          this.logLLMStats();
          return response.parsed;
        }
        logger.error('Failed to parse response', response);
        throw new Error('Could not parse response with structured output');
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from raw response manually if possible
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            if (!this.lastLLMUsage && estimatedPromptTokens > 0) {
              this.lastLLMUsage = {
                promptTokens: estimatedPromptTokens,
                completionTokens: 0,
                totalTokens: estimatedPromptTokens,
              };
            }
            this.recordLLMUsage();
            this.logLLMStats();
            return parsed;
          }
        }
        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    try {
      const llmStartTime = Date.now();
      const response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });
      this.lastLLMDurationMs = Date.now() - llmStartTime;

      // Extract usage information from response
      this.extractUsageFromResponse(response);

      logger.debug(`[${this.modelName}] LLM response received (manual extraction mode):`, {
        usage: this.lastLLMUsage,
        durationMs: this.lastLLMDurationMs,
      });

      const contentString = this.normalizeResponseContentToString(response.content);
      if (contentString) {
        const parsed = this.manuallyParseResponse(contentString);
        if (parsed) {
          if (!this.lastLLMUsage && estimatedPromptTokens > 0) {
            this.lastLLMUsage = {
              promptTokens: estimatedPromptTokens,
              completionTokens: 0,
              totalTokens: estimatedPromptTokens,
            };
          }
          this.recordLLMUsage();
          this.logLLMStats();
          return parsed;
        }
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  /**
   * Extract usage information from LLM response
   */
  private extractUsageFromResponse(response: unknown): void {
    try {
      // Try to extract usage from various response formats
      const responseAny = response as Record<string, unknown>;

      // LangChain structured output format
      if (responseAny.raw && typeof responseAny.raw === 'object') {
        const raw = responseAny.raw as Record<string, unknown>;
        if (raw.response_metadata && typeof raw.response_metadata === 'object') {
          const metadata = raw.response_metadata as Record<string, unknown>;
          // Prefer token_usage (OpenAI-style LangChain metadata), but also support usage (some providers)
          const tokenUsage = (metadata.token_usage || metadata.usage) as Record<string, unknown> | undefined;
          if (tokenUsage && typeof tokenUsage === 'object') {
            this.lastLLMUsage = {
              promptTokens: Number(tokenUsage.prompt_tokens) || 0,
              completionTokens: Number(tokenUsage.completion_tokens) || 0,
              totalTokens: Number(tokenUsage.total_tokens) || 0,
            };
            return;
          }
        }
      }

      // Direct response format (some providers)
      if (responseAny.response_metadata && typeof responseAny.response_metadata === 'object') {
        const metadata = responseAny.response_metadata as Record<string, unknown>;
        const tokenUsage = (metadata.token_usage || metadata.usage) as Record<string, unknown> | undefined;
        if (tokenUsage && typeof tokenUsage === 'object') {
          this.lastLLMUsage = {
            promptTokens: Number(tokenUsage.prompt_tokens) || 0,
            completionTokens: Number(tokenUsage.completion_tokens) || 0,
            totalTokens: Number(tokenUsage.total_tokens) || 0,
          };
          return;
        }
      }

      // Check for usage in response itself
      if (responseAny.usage && typeof responseAny.usage === 'object') {
        const usage = responseAny.usage as Record<string, unknown>;
        this.lastLLMUsage = {
          promptTokens: Number(usage.prompt_tokens) || 0,
          completionTokens: Number(usage.completion_tokens) || 0,
          totalTokens: Number(usage.total_tokens) || 0,
        };
        return;
      }
    } catch (error) {
      logger.debug(`[${this.modelName}] Failed to extract usage info:`, error);
    }
  }

  /**
   * Record current call's LLM usage into task-level statistics on the context.
   * This is called after each successful LLM invocation (both structured & manual modes).
   */
  private recordLLMUsage(): void {
    if (!this.context || !this.lastLLMUsage) return;

    const duration = this.lastLLMDurationMs ?? 0;
    const stats = this.context.llmStats;

    // Update global totals
    stats.totalPromptTokens += this.lastLLMUsage.promptTokens;
    stats.totalCompletionTokens += this.lastLLMUsage.completionTokens;
    stats.totalTokens += this.lastLLMUsage.totalTokens;
    stats.totalDurationMs += duration;

    // Update per-agent breakdown
    const agentId = this.id || 'unknown';
    if (!stats.byAgent[agentId]) {
      stats.byAgent[agentId] = {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalDurationMs: 0,
      };
    }
    const agentStats = stats.byAgent[agentId];
    agentStats.calls += 1;
    agentStats.promptTokens += this.lastLLMUsage.promptTokens;
    agentStats.completionTokens += this.lastLLMUsage.completionTokens;
    agentStats.totalTokens += this.lastLLMUsage.totalTokens;
    agentStats.totalDurationMs += duration;
  }

  /**
   * Log LLM statistics (tokens, duration, cost estimate)
   */
  private logLLMStats(): void {
    if (!this.lastLLMUsage && !this.lastLLMDurationMs) {
      return;
    }

    const stats: Record<string, unknown> = {
      agentId: this.id,
      modelName: this.modelName,
      provider: this.provider,
    };

    if (this.lastLLMUsage) {
      stats.promptTokens = this.lastLLMUsage.promptTokens;
      stats.completionTokens = this.lastLLMUsage.completionTokens;
      stats.totalTokens = this.lastLLMUsage.totalTokens;
    }

    if (this.lastLLMDurationMs) {
      stats.durationMs = this.lastLLMDurationMs;
      stats.durationSeconds = (this.lastLLMDurationMs / 1000).toFixed(2);
    }

    logger.info(`[${this.modelName}] LLM call statistics:`, stats);
  }

  /**
   * Get the last LLM usage information
   */
  getLastLLMUsage(): LLMUsage | undefined {
    return this.lastLLMUsage;
  }

  /**
   * Get the last LLM call duration in milliseconds
   */
  getLastLLMDurationMs(): number | undefined {
    return this.lastLLMDurationMs;
  }

  /**
   * Normalize LLM response content to a single string.
   * Some APIs (e.g. 智谱 GLM) return content as array with separate reasoning_content or multiple parts.
   */
  private normalizeResponseContentToString(content: unknown): string | null {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      // Prefer the part that looks like JSON or tool_call (code block, starts with {, or <tool_call>)
      let jsonLike = '';
      let fallback = '';
      for (const part of content) {
        const text =
          typeof part === 'string' ? part : typeof part === 'object' && part && 'text' in part ? String((part as { text: string }).text) : '';
        if (!text) continue;
        fallback = fallback ? fallback + '\n' + text : text;
        if (text.includes('<plan>') || text.includes('<tool_call>') || text.includes('```') || text.trim().startsWith('{')) {
          jsonLike = text;
        }
      }
      return jsonLike || fallback || null;
    }
    return null;
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      // 解析失败在很多模型/提供商上是预期情况（例如返回了错误结构的 JSON 或普通文本），
      // 这里避免把完整 ZodError 打成 error 级别刷屏，只简要记录一条 warning。
      const message = error instanceof Error ? error.message : String(error);
      logger.warning('validateModelOutput failed, falling back to manual parse', message);
      throw new ResponseParseError('Could not validate model output');
    }
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);
    
    // Determine if we should skip <plan> tags based on agent type
    // Navigator agent should skip <plan> to avoid extracting wrong format
    const skipPlanTags = this.id === 'navigator';
    
    // Get required keys from schema for validation
    const requiredKeys: string[] = [];
    try {
      if (this.modelOutputSchema && 'shape' in this.modelOutputSchema) {
        // Try to introspect schema shape for Navigator agent (which uses ZodObject)
        const schemaAsObject = this.modelOutputSchema as unknown as z.ZodObject<z.ZodRawShape>;
        if (schemaAsObject && typeof schemaAsObject.shape === 'object') {
          requiredKeys.push(...Object.keys(schemaAsObject.shape));
        }
      }
    } catch {
      // Schema introspection failed, continue without required keys
    }

    logger.debug(`[${this.modelName}] Starting manual JSON extraction`, {
      agentId: this.id,
      skipPlanTags,
      requiredKeys,
      contentPreview: cleanedContent.slice(0, 200) + (cleanedContent.length > 200 ? '...' : ''),
    });

    // Try multiple extraction strategies
    const extractionStrategies = [
      {
        name: 'extractJsonFromModelOutput with options',
        extract: () =>
          extractJsonFromModelOutput(cleanedContent, {
            skipPlanTags,
            requiredKeys: requiredKeys.length > 0 ? requiredKeys : undefined,
          }),
      },
      {
        name: 'extractJsonFromModelOutput without validation',
        extract: () => extractJsonFromModelOutput(cleanedContent, { skipPlanTags }),
      },
      {
        name: 'direct JSON parse',
        extract: () => {
          // Try to find JSON object directly
          const jsonStart = cleanedContent.indexOf('{');
          const jsonEnd = cleanedContent.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd > jsonStart) {
            return JSON.parse(cleanedContent.slice(jsonStart, jsonEnd + 1));
          }
          throw new Error('No JSON object found');
        },
      },
    ];

    for (const strategy of extractionStrategies) {
      try {
        logger.debug(`[${this.modelName}] Trying extraction strategy: ${strategy.name}`);
        const extractedJson = strategy.extract();
        
        logger.debug(`[${this.modelName}] Extraction succeeded`, {
          strategy: strategy.name,
          extractedKeys: Object.keys(extractedJson),
          hasRequiredKeys: requiredKeys.length === 0 || requiredKeys.every(k => k in extractedJson),
        });

        const validated = this.validateModelOutput(extractedJson);
        if (validated) {
          logger.debug(`[${this.modelName}] Validation succeeded with strategy: ${strategy.name}`);
          return validated;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.debug(`[${this.modelName}] Strategy "${strategy.name}" failed: ${errorMsg}`);
        // Continue to next strategy
      }
    }

    logger.warning(`[${this.modelName}] All extraction strategies failed`, {
      agentId: this.id,
      contentPreview: cleanedContent.slice(0, 500) + (cleanedContent.length > 500 ? '...' : ''),
    });
    return undefined;
  }
}
