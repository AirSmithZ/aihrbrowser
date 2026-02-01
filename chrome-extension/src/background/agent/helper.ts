import { type ProviderConfig, type ModelConfig, ProviderTypeEnum } from '@extension/storage';
import { storeRequestLog } from '@src/background/services/requestLog';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatXAI } from '@langchain/xai';
import { ChatGroq } from '@langchain/groq';
import { ChatCerebras } from '@langchain/cerebras';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';

const maxTokens = 1024 * 4;

// Custom ChatLlama class to handle Llama API response format
class ChatLlama extends ChatOpenAI {
  constructor(args: any) {
    super(args);
  }

  // Override the completionWithRetry method to intercept and transform the response
  async completionWithRetry(request: any, options?: any): Promise<any> {
    try {
      // Make the request using the parent's implementation
      const response = await super.completionWithRetry(request, options);
      if (response?.id) storeRequestLog(response.id, response);

      // Check if this is a Llama API response format
      if (response?.completion_message?.content?.text) {
        // Transform Llama API response to OpenAI format
        const transformedResponse = {
          id: response.id || 'llama-response',
          object: 'chat.completion',
          created: Date.now(),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: response.completion_message.content.text,
              },
              finish_reason: response.completion_message.stop_reason || 'stop',
            },
          ],
          usage: {
            prompt_tokens: response.metrics?.find((m: any) => m.metric === 'num_prompt_tokens')?.value || 0,
            completion_tokens: response.metrics?.find((m: any) => m.metric === 'num_completion_tokens')?.value || 0,
            total_tokens: response.metrics?.find((m: any) => m.metric === 'num_total_tokens')?.value || 0,
          },
        };

        return transformedResponse;
      }

      return response;
    } catch (error: any) {
      console.error(`[ChatLlama] Error during API call:`, error);
      throw error;
    }
  }
}

/**
 * Extract assistant text from gateway response when content may be in non-standard fields.
 * Some gateways return message.text, message.parts, or Anthropic-style content blocks.
 */
function extractMessageContentFromRaw(firstChoice: any, message: any): string | null {
  if (!message) return null;
  // Standard OpenAI: message.content (string)
  if (typeof message.content === 'string' && message.content.trim()) return message.content;
  // Common alternates: message.text, message.response
  if (typeof message.text === 'string' && message.text.trim()) return message.text;
  if (typeof message.response === 'string' && message.response.trim()) return message.response;
  // Legacy: choices[0].text
  if (typeof firstChoice?.text === 'string' && firstChoice.text.trim()) return firstChoice.text;
  // Anthropic-style content blocks: message.content = [{ type: "text", text: "..." }]
  if (Array.isArray(message.content) && message.content.length > 0) {
    const parts = message.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('');
    if (parts.trim()) return parts;
  }
  // message.parts (some gateways)
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    const parts = message.parts
      .filter((b: any) => typeof b?.text === 'string')
      .map((b: any) => b.text)
      .join('');
    if (parts.trim()) return parts;
  }
  return null;
}

// Custom Chat model for Claude-style models served via OpenAI-compatible gateways (e.g. api520)
// These providers often return tool_calls with an AgentOutput function whose arguments contain
// the actual JSON we need. This wrapper flattens that into a plain JSON string in message.content
// so that downstream agents can use the existing manual JSON extraction pipeline reliably.
class ChatClaudeToolProxy extends ChatOpenAI {
  constructor(args: any) {
    super(args);
  }

  // Override the completionWithRetry method to intercept and transform the response
  async completionWithRetry(request: any, options?: any): Promise<any> {
    try {
      const response = await super.completionWithRetry(request, options);
      if (response?.id) storeRequestLog(response.id, response);

      console.log('[ChatClaudeToolProxy] Raw response received, checking for tool_calls...');
      console.log('[ChatClaudeToolProxy] Response structure:', {
        hasChoices: !!response?.choices,
        choicesLength: response?.choices?.length,
        finishReason: response?.choices?.[0]?.finish_reason,
      });

      try {
        const firstChoice = response?.choices?.[0];
        const message = firstChoice?.message;
        
        console.log('[ChatClaudeToolProxy] Message structure:', {
          hasMessage: !!message,
          hasToolCalls: !!message?.tool_calls,
          toolCallsLength: message?.tool_calls?.length,
          contentPreview: typeof message?.content === 'string' ? message.content.slice(0, 100) : 'not a string',
        });

        // OpenAI-compatible tool call format: message.tool_calls[0].function.arguments
        const rawToolCalls = message?.tool_calls;

        if (rawToolCalls && Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
          console.log('[ChatClaudeToolProxy] Found tool_calls, processing...');
          const firstToolCall = rawToolCalls[0];
          const fn = firstToolCall?.function;
          const argsRaw = fn?.arguments;

          console.log('[ChatClaudeToolProxy] Tool call structure:', {
            hasFunction: !!fn,
            hasArguments: !!argsRaw,
            argumentsType: typeof argsRaw,
            argumentsLength: typeof argsRaw === 'string' ? argsRaw.length : 0,
            argumentsPreview: typeof argsRaw === 'string' ? argsRaw.slice(0, 200) : 'not a string',
          });

          if (typeof argsRaw === 'string') {
            // Parse the JSON string inside arguments to validate it
            let parsedArgs;
            try {
              parsedArgs = JSON.parse(argsRaw);
              console.log('[ChatClaudeToolProxy] Successfully parsed arguments JSON');
            } catch (parseError) {
              console.warn('[ChatClaudeToolProxy] Failed to parse tool_calls arguments as JSON:', parseError);
              console.warn('[ChatClaudeToolProxy] Arguments that failed:', argsRaw.slice(0, 500));
              return response; // Return original if JSON parsing fails
            }

            // Transform the response: replace tool_calls with plain JSON content
            // IMPORTANT: We need to completely remove tool_calls, not just set to undefined
            const transformedMessage: any = {
              role: 'assistant',
              // Put the parsed JSON back as a string so downstream can parse it
              content: JSON.stringify(parsedArgs),
            };
            // Explicitly do NOT include tool_calls field

            const transformed = {
              ...response,
              choices: [
                {
                  ...firstChoice,
                  message: transformedMessage,
                  // Change finish_reason from 'tool_calls' to 'stop'
                  finish_reason: 'stop',
                },
              ],
            };

            console.log('[ChatClaudeToolProxy] Successfully transformed tool_calls to JSON content');
            console.log('[ChatClaudeToolProxy] Transformed message content preview:', transformedMessage.content.slice(0, 200));
            return transformed;
          } else {
            console.warn('[ChatClaudeToolProxy] tool_calls found but arguments is not a string:', typeof argsRaw);
          }
        } else {
          console.log('[ChatClaudeToolProxy] No tool_calls found in response, returning original');
        }

        // Fallback: gateway returned message with no content and no tool_calls; try non-standard fields
        const hasContent =
          typeof message?.content === 'string' && message.content.trim().length > 0;
        const hasToolCalls =
          Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
        if (!hasContent && !hasToolCalls && firstChoice && message) {
          const extracted = extractMessageContentFromRaw(firstChoice, message);
          if (extracted) {
            const transformedMessage: any = { role: 'assistant', content: extracted };
            const transformed = {
              ...response,
              choices: [{ ...firstChoice, message: transformedMessage }],
            };
            console.log('[ChatClaudeToolProxy] Filled message.content from non-standard field, length:', extracted.length);
            return transformed;
          }
        }
      } catch (innerError) {
        console.error('[ChatClaudeToolProxy] Failed to transform tool_calls response, falling back to original:', innerError);
        // Fall through to return the original response
      }

      return response;
    } catch (error: any) {
      console.error('[ChatClaudeToolProxy] Error during API call:', error);
      throw error;
    }
  }
}

// O series models or GPT-5 models that support reasoning
function isOpenAIReasoningModel(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('openai/')) {
    modelNameWithoutProvider = modelName.substring(7);
  }
  return (
    modelNameWithoutProvider.startsWith('o') ||
    (modelNameWithoutProvider.startsWith('gpt-5') && !modelNameWithoutProvider.startsWith('gpt-5-chat'))
  );
}

// Function to check if a model is an Anthropic Opus model
function isAnthropicOpusModel(modelName: string): boolean {
  // Extract the model name without provider prefix if present
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return modelNameWithoutProvider.startsWith('claude-opus');
}

// check if a model is sonnet-4-5 or haiku-4-5
function isAnthropic4_5Model(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelName.startsWith('anthropic/')) {
    modelNameWithoutProvider = modelName.substring(10);
  }
  return (
    modelNameWithoutProvider.startsWith('claude-sonnet-4-5') || modelNameWithoutProvider.startsWith('claude-haiku-4-5')
  );
}

function createOpenAIChatModel(
  providerConfig: ProviderConfig,
  modelConfig: ModelConfig,
  // Add optional extra fetch options for headers etc.
  extraFetchOptions: { headers?: Record<string, string> } | undefined,
): BaseChatModel {
  const args: {
    model: string;
    apiKey?: string;
    // Configuration should align with ClientOptions from @langchain/openai
    configuration?: Record<string, unknown>;
    modelKwargs?: {
      max_completion_tokens: number;
      reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    };
    topP?: number;
    temperature?: number;
    maxTokens?: number;
  } = {
    model: modelConfig.modelName,
    apiKey: providerConfig.apiKey,
  };

  const configuration: Record<string, unknown> = {};
  if (providerConfig.baseUrl) {
    configuration.baseURL = providerConfig.baseUrl;
  }
  if (extraFetchOptions?.headers) {
    configuration.defaultHeaders = extraFetchOptions.headers;
  }
  args.configuration = configuration;

  // custom provider may have no api key
  if (providerConfig.apiKey) {
    args.apiKey = providerConfig.apiKey;
  }

  // O series models have different parameters
  if (isOpenAIReasoningModel(modelConfig.modelName)) {
    args.modelKwargs = {
      max_completion_tokens: maxTokens,
    };

    // Add reasoning_effort parameter for o-series models if specified
    if (modelConfig.reasoningEffort) {
      // if it's gpt-5.1, we need to convert minimal to none, it doesn't support minimal
      if (modelConfig.modelName.includes('gpt-5.1') && modelConfig.reasoningEffort === 'minimal') {
        args.modelKwargs.reasoning_effort = 'none';
      } else {
        args.modelKwargs.reasoning_effort = modelConfig.reasoningEffort;
      }
    }
  } else {
    args.topP = (modelConfig.parameters?.topP ?? 0.1) as number;
    args.temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
    args.maxTokens = maxTokens;
  }

  // Heuristic: for Claude-style models served via custom OpenAI-compatible gateways,
  // use ChatClaudeToolProxy so that tool_calls.AgentOutput arguments are flattened into content.
  const lowerModelName = modelConfig.modelName.toLowerCase();
  const isClaudeLikeModel =
    lowerModelName.includes('claude') ||
    lowerModelName.includes('sonnet-4-5') ||
    lowerModelName.includes('haiku-4-5');
  const isCustomGateway =
    typeof providerConfig.baseUrl === 'string' &&
    (providerConfig.baseUrl.includes('api520.pro') || providerConfig.baseUrl.includes('claude') || providerConfig.baseUrl.includes('anthropic'));

  console.log('[createOpenAIChatModel] Model selection:', {
    modelName: modelConfig.modelName,
    lowerModelName,
    isClaudeLikeModel,
    baseUrl: providerConfig.baseUrl,
    isCustomGateway,
    willUseProxy: isClaudeLikeModel || isCustomGateway,
  });

  if (isClaudeLikeModel || isCustomGateway) {
    console.log('[createOpenAIChatModel] Using ChatClaudeToolProxy for model:', modelConfig.modelName);
    return new ChatClaudeToolProxy(args);
  }

  // Use wrapper that stores API response + console logs by request id
  console.log('[createOpenAIChatModel] Using standard ChatOpenAI for model:', modelConfig.modelName);
  return new ChatOpenAIWithRequestLog(args);
}

/** Thin wrapper to store raw API response and console logs by response.id */
class ChatOpenAIWithRequestLog extends ChatOpenAI {
  async completionWithRetry(request: any, options?: any): Promise<any> {
    const response = await super.completionWithRetry(request, options);
    if (response?.id) storeRequestLog(response.id, response);
    return response;
  }
}

// Function to extract instance name from Azure endpoint URL
function extractInstanceNameFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const hostnameParts = parsedUrl.hostname.split('.');
    // Expecting format like instance-name.openai.azure.com
    if (hostnameParts.length >= 4 && hostnameParts[1] === 'openai' && hostnameParts[2] === 'azure') {
      return hostnameParts[0];
    }
  } catch (e) {
    console.error('Error parsing Azure endpoint URL:', e);
  }
  return null;
}

// Function to check if a provider ID is an Azure provider
function isAzureProvider(providerId: string): boolean {
  return providerId === ProviderTypeEnum.AzureOpenAI || providerId.startsWith(`${ProviderTypeEnum.AzureOpenAI}_`);
}

// Function to create an Azure OpenAI chat model
function createAzureChatModel(providerConfig: ProviderConfig, modelConfig: ModelConfig): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Validate necessary fields first
  if (
    !providerConfig.baseUrl ||
    !providerConfig.azureDeploymentNames ||
    providerConfig.azureDeploymentNames.length === 0 ||
    !providerConfig.azureApiVersion ||
    !providerConfig.apiKey
  ) {
    throw new Error(
      'Azure configuration is incomplete. Endpoint, Deployment Name, API Version, and API Key are required. Please check settings.',
    );
  }

  // Instead of always using the first deployment name, use the model name from modelConfig
  // which contains the actual model selected in the UI
  const deploymentName = modelConfig.modelName;

  // Validate that the selected model exists in the configured deployments
  if (!providerConfig.azureDeploymentNames.includes(deploymentName)) {
    console.warn(
      `[createChatModel] Selected deployment "${deploymentName}" not found in available deployments. ` +
        `Available: ${JSON.stringify(providerConfig.azureDeploymentNames)}. Using the model anyway.`,
    );
  }

  // Extract instance name from the endpoint URL
  const instanceName = extractInstanceNameFromUrl(providerConfig.baseUrl);
  if (!instanceName) {
    throw new Error(
      `Could not extract Instance Name from Azure Endpoint URL: ${providerConfig.baseUrl}. Expected format like https://<your-instance-name>.openai.azure.com/`,
    );
  }

  // Check if the Azure deployment is using an "o" series model (GPT-4o, etc.)
  const isOSeriesModel = isOpenAIReasoningModel(deploymentName);

  // Use AzureChatOpenAI with specific parameters
  const args = {
    azureOpenAIApiInstanceName: instanceName, // Derived from endpoint
    azureOpenAIApiDeploymentName: deploymentName,
    azureOpenAIApiKey: providerConfig.apiKey,
    azureOpenAIApiVersion: providerConfig.azureApiVersion,
    // For Azure, the model name should be the deployment name itself
    model: deploymentName, // Set model = deployment name to fix Azure requests
    // For O series models, use modelKwargs instead of temperature/topP
    ...(isOSeriesModel
      ? {
          modelKwargs: {
            max_completion_tokens: maxTokens,
            // Add reasoning_effort parameter for Azure o-series models if specified
            ...(modelConfig.reasoningEffort ? { reasoning_effort: modelConfig.reasoningEffort } : {}),
          },
        }
      : {
          temperature,
          topP,
          maxTokens,
        }),
    // DO NOT pass baseUrl or configuration here
  };
  // console.log('[createChatModel] Azure args passed to AzureChatOpenAI:', args);
  return new AzureChatOpenAI(args);
}

// create a chat model based on the agent name, the model name and provider
export function createChatModel(providerConfig: ProviderConfig, modelConfig: ModelConfig): BaseChatModel {
  const temperature = (modelConfig.parameters?.temperature ?? 0.1) as number;
  const topP = (modelConfig.parameters?.topP ?? 0.1) as number;

  // Check if the provider is an Azure provider with a custom ID (e.g. azure_openai_2)
  const isAzure = isAzureProvider(modelConfig.provider);

  // If this is any type of Azure provider, handle it with the dedicated function
  if (isAzure) {
    return createAzureChatModel(providerConfig, modelConfig);
  }

  switch (modelConfig.provider) {
    case ProviderTypeEnum.OpenAI: {
      // Call helper without extra options
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
    case ProviderTypeEnum.Anthropic: {
      // For Opus models, only support temperature, not topP
      // For 4.5 models, only support either temperature or topP, not both, so we only use temperature to align with Opus
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        maxTokens,
        temperature,
        clientOptions: {},
      };
      return new ChatAnthropic(args);
    }
    case ProviderTypeEnum.DeepSeek: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
      };
      return new ChatDeepSeek(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Gemini: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
      };
      return new ChatGoogleGenerativeAI(args);
    }
    case ProviderTypeEnum.Grok: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
        configuration: {},
      };
      return new ChatXAI(args) as BaseChatModel;
    }
    case ProviderTypeEnum.Groq: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatGroq(args);
    }
    case ProviderTypeEnum.Cerebras: {
      const args = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        temperature,
        topP,
        maxTokens,
      };
      return new ChatCerebras(args);
    }
    case ProviderTypeEnum.Ollama: {
      const args: {
        model: string;
        apiKey?: string;
        baseUrl: string;
        modelKwargs?: { max_completion_tokens: number };
        topP?: number;
        temperature?: number;
        maxTokens?: number;
        numCtx: number;
      } = {
        model: modelConfig.modelName,
        // required but ignored by ollama
        apiKey: providerConfig.apiKey === '' ? 'ollama' : providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl ?? 'http://localhost:11434',
        topP,
        temperature,
        maxTokens,
        // ollama usually has a very small context window, so we need to set a large number for agent to work
        // It was set to 128000 in the original code, but it will cause ollama reload the models frequently if you have multiple models working together
        // not sure why, but setting it to 64000 seems to work fine
        // TODO: configure the context window size in model config
        numCtx: 64000,
      };
      return new ChatOllama(args);
    }
    case ProviderTypeEnum.OpenRouter: {
      // Call the helper function, passing OpenRouter headers via the third argument
      console.log('[createChatModel] Calling createOpenAIChatModel for OpenRouter');
      return createOpenAIChatModel(providerConfig, modelConfig, {
        headers: {
          'HTTP-Referer': 'https://aihr.ai',
          'X-Title': 'AIHR',
        },
      });
    }
    case ProviderTypeEnum.Llama: {
      // Llama API has a different response format, use custom ChatLlama class
      const args: {
        model: string;
        apiKey?: string;
        configuration?: Record<string, unknown>;
        topP?: number;
        temperature?: number;
        maxTokens?: number;
      } = {
        model: modelConfig.modelName,
        apiKey: providerConfig.apiKey,
        topP: (modelConfig.parameters?.topP ?? 0.1) as number,
        temperature: (modelConfig.parameters?.temperature ?? 0.1) as number,
        maxTokens,
      };

      const configuration: Record<string, unknown> = {};
      if (providerConfig.baseUrl) {
        configuration.baseURL = providerConfig.baseUrl;
      }
      args.configuration = configuration;

      return new ChatLlama(args);
    }
    default: {
      // by default, we think it's a openai-compatible provider
      // Pass undefined for extraFetchOptions for default/custom cases
      return createOpenAIChatModel(providerConfig, modelConfig, undefined);
    }
  }
}
