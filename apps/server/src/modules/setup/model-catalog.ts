import type { LlmProviderId } from '@superagent/shared';
import type { PricedModel } from './llm-gateway.js';

/** Platform prices and input bounds for models eligible for verification from Settings. */
export function setupModelPrice(provider: LlmProviderId, model: string): PricedModel | undefined {
  if (provider !== 'openai' || model !== 'gpt-5-mini') return undefined;
  // OpenAI's uncached text input/output prices and context window.
  // https://developers.openai.com/api/docs/models/gpt-5-mini
  return {
    inputPerMTokMicroUsd: 250_000,
    outputPerMTokMicroUsd: 2_000_000,
    fullyBoundable: true,
    maxInputTokens: 400_000,
  };
}
