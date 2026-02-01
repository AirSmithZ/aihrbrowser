import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { extractUsage, logLLMUsage } from '../llm-usage-log';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { isAbortedError, ResponseParseError } from './errors';
import { repairJsonString } from '@src/background/utils';
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

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    const lowerName = this.modelName.toLowerCase();
    // GLM (e.g. GLM-4.7) often returns JSON/custom formats in message.content instead of tool_calls;
    // use manual extraction so we parse content (including <tool_call>AgentOutput and ```json blocks).
    if (lowerName.includes('glm') || lowerName.includes('glm-4')) {
      logger.debug(
        `[${this.modelName}] Detected GLM-style model, disabling structured output and using manual JSON extraction`,
      );
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    // Claude 系列模型通过部分网关返回的 structured output / json_schema 支持并不稳定，
    // 更可靠的方式是依赖我们自定义的 ChatClaudeToolProxy + 手动 JSON 抽取逻辑。
    // 因此如果模型名里包含 claude/sonnet-4-5/haiku-4-5，则关闭 structured output。
    if (lowerName.includes('claude') || lowerName.includes('sonnet-4-5') || lowerName.includes('haiku-4-5')) {
      logger.debug(
        `[${this.modelName}] Detected Claude-style model, disabling structured output and using manual JSON extraction`,
      );
      return false;
    }

    // 其它模型保持 structured output 打开
    return true;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    const startMs = Date.now();

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
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        const elapsedMs = Date.now() - startMs;
        const usage = response?.raw ? extractUsage(response.raw) : null;
        logLLMUsage(this.id, this.modelName, usage, elapsedMs);

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
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
        
        // Check if we have raw response content to parse
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
                    // keep as-is; validation may fail
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
        
        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    try {
      const response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });

      const elapsedMs = Date.now() - startMs;
      const usage = extractUsage(response);
      logLLMUsage(this.id, this.modelName, usage, elapsedMs);

      // Debug: Log response structure
      logger.debug(`[${this.modelName}] Response type: ${response.constructor.name}`);
      logger.debug(`[${this.modelName}] Response has tool_calls: ${!!(response as any).tool_calls}`);
      logger.debug(`[${this.modelName}] Response content type: ${typeof response.content}`);
      logger.debug(`[${this.modelName}] Response content preview: ${typeof response.content === 'string' ? response.content.slice(0, 200) : 'not a string'}`);

      // First, check if response has tool_calls (for Claude-style providers via OpenAI-compatible gateways)
      // LangChain's AIMessage may have tool_calls even if ChatClaudeToolProxy tried to transform it
      const responseAny = response as any;
      
      // Check multiple possible locations for tool_calls
      let toolCalls = responseAny.tool_calls;
      if (!toolCalls && responseAny.additional_kwargs?.tool_calls) {
        toolCalls = responseAny.additional_kwargs.tool_calls;
      }

      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        logger.debug(`[${this.modelName}] Found ${toolCalls.length} tool_calls in response`);
        const firstToolCall = toolCalls[0];
        logger.debug(`[${this.modelName}] First tool_call structure:`, JSON.stringify(firstToolCall, null, 2));
        
        // Handle different tool_call structures
        let parsedArgs: any = null;
        
        // Structure 1: LangChain processed format { name: string, args: object, type: string, id: string }
        if (firstToolCall?.args && typeof firstToolCall.args === 'object' && !Array.isArray(firstToolCall.args)) {
          logger.debug(`[${this.modelName}] Found LangChain processed tool_call.args (object)`);
          parsedArgs = firstToolCall.args;
        }
        // Structure 2: OpenAI format { function: { name: string, arguments: string } }
        else if (firstToolCall?.function?.arguments && typeof firstToolCall.function.arguments === 'string') {
          logger.debug(`[${this.modelName}] Found OpenAI format tool_call.function.arguments (string)`);
          try {
            parsedArgs = JSON.parse(firstToolCall.function.arguments);
          } catch (parseError) {
            logger.warning(`[${this.modelName}] Failed to parse function.arguments:`, parseError);
          }
        }
        // Structure 3: { args: string } (string format)
        else if (firstToolCall?.args && typeof firstToolCall.args === 'string') {
          logger.debug(`[${this.modelName}] Found tool_call.args (string)`);
          try {
            parsedArgs = JSON.parse(firstToolCall.args);
          } catch (parseError) {
            logger.warning(`[${this.modelName}] Failed to parse args string:`, parseError);
          }
        }
        // Structure 4: Direct arguments field (string)
        else if (firstToolCall?.arguments && typeof firstToolCall.arguments === 'string') {
          logger.debug(`[${this.modelName}] Found tool_call.arguments (string)`);
          try {
            parsedArgs = JSON.parse(firstToolCall.arguments);
          } catch (parseError) {
            logger.warning(`[${this.modelName}] Failed to parse arguments string:`, parseError);
          }
        }

        if (parsedArgs && typeof parsedArgs === 'object') {
          try {
            // Fix: Handle double-escaped JSON strings in current_state field (for Navigator)
            // Some providers return current_state as a JSON string instead of an object
            if (parsedArgs.current_state && typeof parsedArgs.current_state === 'string') {
              const rawCurrentState = parsedArgs.current_state;
              try {
                logger.debug(`[${this.modelName}] current_state is a string, parsing it as JSON`);
                parsedArgs.current_state = JSON.parse(rawCurrentState);
                logger.debug(`[${this.modelName}] Successfully parsed current_state from string to object`);
              } catch (parseError) {
                try {
                  const repaired = repairJsonString(rawCurrentState);
                  parsedArgs.current_state = JSON.parse(repaired);
                  logger.debug(`[${this.modelName}] Parsed current_state after repairJsonString`);
                } catch (repairError) {
                  logger.warning(`[${this.modelName}] Failed to parse current_state string (parse + repair):`, parseError);
                  // Fallback: satisfy agentBrainSchema so validation passes and agent can continue
                  parsedArgs.current_state = {
                    evaluation_previous_goal: '',
                    memory: rawCurrentState.slice(0, 2000),
                    next_goal: '',
                  };
                  logger.debug(`[${this.modelName}] Using fallback current_state object`);
                }
              }
            }

            // Fix: Handle action field that might be a JSON string instead of an array
            if (parsedArgs.action && typeof parsedArgs.action === 'string') {
              const rawAction = parsedArgs.action;
              try {
                logger.debug(`[${this.modelName}] action is a string, parsing it as JSON`);
                parsedArgs.action = JSON.parse(rawAction);
                logger.debug(`[${this.modelName}] Successfully parsed action from string to array`);
              } catch (parseError) {
                try {
                  parsedArgs.action = JSON.parse(repairJsonString(rawAction));
                  logger.debug(`[${this.modelName}] Parsed action after repairJsonString`);
                } catch (repairError) {
                  logger.warning(`[${this.modelName}] Failed to parse action string (parse + repair):`, parseError);
                  // Keep the string as is, validation will catch the error
                }
              }
            }

            logger.debug(`[${this.modelName}] Validating parsed tool_call arguments`);
            const validated = this.validateModelOutput(parsedArgs);
            if (validated) {
              logger.debug(`[${this.modelName}] Successfully parsed and validated JSON from tool_calls`);
              return validated;
            }
          } catch (validationError) {
            logger.warning(`[${this.modelName}] Failed to validate tool_calls arguments:`, validationError);
            logger.warning(`[${this.modelName}] Parsed args that failed validation:`, JSON.stringify(parsedArgs, null, 2));
            // Fall through to try content parsing
          }
        } else {
          logger.warning(`[${this.modelName}] tool_calls found but could not extract valid arguments. Tool call structure:`, JSON.stringify(firstToolCall, null, 2));
        }
      } else {
        logger.debug(`[${this.modelName}] No tool_calls found in response`);
      }

      // Second, try to parse from content string
      if (typeof response.content === 'string' && response.content.trim()) {
        const parsed = this.manuallyParseResponse(response.content);
        if (parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed JSON from response.content`);
          return parsed;
        }
      }

      // If content is an array (multi-modal), try to extract text content
      if (Array.isArray(response.content)) {
        const textContent = response.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n');
        if (textContent) {
          const parsed = this.manuallyParseResponse(textContent);
          if (parsed) {
            logger.debug(`[${this.modelName}] Successfully parsed JSON from multi-modal content`);
            return parsed;
          }
        }
      }

      // Build a clear error when message has no usable content (common with bad gateway mapping)
      const hasContent =
        (typeof response.content === 'string' && response.content.length > 0) || Array.isArray(response.content);
      const hasToolCalls =
        Array.isArray(responseAny.tool_calls) && responseAny.tool_calls.length > 0;
      if (!hasContent && !hasToolCalls) {
        logger.error(`[${this.modelName}] API returned message with no content and no tool_calls`, {
          contentType: typeof response.content,
          contentLength: typeof response.content === 'string' ? response.content.length : 0,
        });
        throw new ResponseParseError(
          'Could not parse response: API returned message with no content and no tool_calls. ' +
            'Ensure your API gateway returns either message.content (JSON string) or message.tool_calls in OpenAI format.',
        );
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata (uses safeParse so callers can try relaxed fallback)
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    const result = this.modelOutputSchema.safeParse(data);
    if (result.success) return result.data as this['ModelOutput'];
    logger.warning('validateModelOutput failed', result.error.message);
    return undefined;
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);
    logger.debug(`[${this.modelName}] manuallyParseResponse - content length: ${cleanedContent.length}, preview: ${cleanedContent.slice(0, 200)}`);
    try {
      const extractedJson = extractJsonFromModelOutput(cleanedContent);
      logger.debug(`[${this.modelName}] Successfully extracted JSON from content`);
      return this.validateModelOutput(extractedJson);
    } catch (error) {
      logger.warning(`[${this.modelName}] manuallyParseResponse failed:`, error);
      logger.warning(`[${this.modelName}] Content that failed to parse:`, cleanedContent.slice(0, 500));
      return undefined;
    }
  }
}
