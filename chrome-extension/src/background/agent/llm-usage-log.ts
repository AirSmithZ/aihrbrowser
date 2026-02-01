import { createLogger } from '@src/background/log';

const logger = createLogger('LLM');

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Extract token usage from LangChain AIMessage or raw API response.
 * Supports usage_metadata (Anthropic-style), response_metadata.usage (OpenAI-style), and additional_kwargs.
 */
export function extractUsage(message: unknown): LLMUsage | null {
  if (message == null || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  // LangChain AIMessage: usage_metadata { input_tokens, output_tokens }
  const usageMeta = m.usage_metadata as Record<string, unknown> | undefined;
  if (usageMeta && typeof usageMeta === 'object') {
    const input = Number(usageMeta.input_tokens ?? usageMeta.prompt_tokens);
    const output = Number(usageMeta.output_tokens ?? usageMeta.completion_tokens);
    if (!Number.isNaN(input) || !Number.isNaN(output)) {
      const total = Number(usageMeta.total_tokens) || input + output;
      return {
        promptTokens: input || 0,
        completionTokens: output || 0,
        totalTokens: total || 0,
      };
    }
  }

  // response_metadata.usage (OpenAI-style)
  const meta = m.response_metadata as Record<string, unknown> | undefined;
  const usage = meta?.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === 'object') {
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens);
    const total = Number(usage.total_tokens);
    if (!Number.isNaN(prompt) || !Number.isNaN(completion)) {
      return {
        promptTokens: prompt || 0,
        completionTokens: completion || 0,
        totalTokens: Number.isNaN(total) ? prompt + completion : total,
      };
    }
  }

  // additional_kwargs.usage
  const kwargs = m.additional_kwargs as Record<string, unknown> | undefined;
  const kwargsUsage = kwargs?.usage as Record<string, unknown> | undefined;
  if (kwargsUsage && typeof kwargsUsage === 'object') {
    const prompt = Number(kwargsUsage.prompt_tokens ?? kwargsUsage.input_tokens);
    const completion = Number(kwargsUsage.completion_tokens ?? kwargsUsage.output_tokens);
    const total = Number(kwargsUsage.total_tokens);
    if (!Number.isNaN(prompt) || !Number.isNaN(completion)) {
      return {
        promptTokens: prompt || 0,
        completionTokens: completion || 0,
        totalTokens: Number.isNaN(total) ? prompt + completion : total,
      };
    }
  }

  return null;
}

/**
 * Log one line: agent, model, elapsed time and token usage for cost visibility.
 * Format: 耗时 X.XXs，消耗 token: prompt=N, completion=M, total=T
 */
export function logLLMUsage(
  agentId: string,
  modelName: string,
  usage: LLMUsage | null,
  elapsedMs: number,
): void {
  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
    logger.info(
      `[${agentId}] model=${modelName} 耗时 ${elapsedSec}s，消耗 token: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}`,
    );
  } else {
    logger.info(`[${agentId}] model=${modelName} 耗时 ${elapsedSec}s (no usage metadata)`);
  }
}
