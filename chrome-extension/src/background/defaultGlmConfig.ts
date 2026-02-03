import { AgentNameEnum, ProviderTypeEnum, type ModelConfig, type ProviderConfig } from '@extension/storage';

/** Default provider id for 智谱 GLM (Zhipu AI) when no providers are configured */
export const DEFAULT_GLM_PROVIDER_ID = 'zhipu_glm';

/** Default 智谱 GLM provider config (OpenAI-compatible API) used when user has not configured any provider */
export const DEFAULT_GLM_PROVIDER_CONFIG: ProviderConfig = {
  name: '智谱 GLM',
  type: ProviderTypeEnum.CustomOpenAI,
  apiKey: 'aa11bd8615da42929bb135e684377340.FGgoUc67pORLxLCQ',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  modelNames: ['GLM-4.7'],
  createdAt: Date.now(),
};

/** Default model config for Navigator/Planner when user has not configured agent models */
export const DEFAULT_GLM_NAVIGATOR_MODEL: ModelConfig = {
  provider: DEFAULT_GLM_PROVIDER_ID,
  modelName: 'GLM-4.7',
  parameters: { temperature: 0.3, topP: 0.85 },
};

export const DEFAULT_GLM_PLANNER_MODEL: ModelConfig = {
  provider: DEFAULT_GLM_PROVIDER_ID,
  modelName: 'GLM-4.7',
  parameters: { temperature: 0.7, topP: 0.9 },
};

export function getDefaultAgentModels(): Record<AgentNameEnum, ModelConfig> {
  return {
    [AgentNameEnum.Navigator]: DEFAULT_GLM_NAVIGATOR_MODEL,
    [AgentNameEnum.Planner]: DEFAULT_GLM_PLANNER_MODEL,
  };
}
