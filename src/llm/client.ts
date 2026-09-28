import OpenAI from 'openai';
import { config } from '../config.js';

// One LLM provider for the whole app: the chat agent and the transaction classifier use
// the same key and endpoint. AGENT_LLM_KEY + AGENT_BASE_URL point at an OpenAI-compatible
// gateway (e.g. Bankr's LLM gateway); without them, OPENAI_API_KEY and OpenAI directly.

type ClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

// Whether calls go through a gateway rather than OpenAI directly
export function usesGateway(): boolean {
  return Boolean(config.AGENT_BASE_URL);
}

// Client options for the configured provider, or null when no key is set
export function llmClientOptions(extra: Pick<ClientOptions, 'timeout' | 'maxRetries'> = {}): ClientOptions | null {
  const apiKey = config.AGENT_LLM_KEY ?? config.OPENAI_API_KEY;
  if (!apiKey) return null;
  const opts: ClientOptions = { apiKey, ...extra };
  if (config.AGENT_BASE_URL) {
    opts.baseURL = config.AGENT_BASE_URL;
    // Bankr (and some other gateways) use X-API-Key in addition to Bearer
    opts.defaultHeaders = { 'X-API-Key': apiKey };
  }
  return opts;
}

// The classifier's model: CLASSIFIER_MODEL when set; on a gateway the agent's model, since
// that is the one known to be served there; otherwise gpt-4o-mini on OpenAI.
export function classifierModel(): string {
  return config.CLASSIFIER_MODEL ?? (usesGateway() ? config.AGENT_MODEL : 'gpt-4o-mini');
}

// USD per million tokens [input, output] for models with a published price. Checked in
// order, so a more specific name comes before its prefix. A model not listed is logged
// with its tokens at $0 and shows up as unpriced in the AI cost figures.
const PRICES_PER_MTOK: Array<[prefix: string, input: number, output: number]> = [
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
];

// The dearest listed price. The classifier's daily spend cap counts an unpriced model's
// tokens at this rate, so the cap still bounds spend on a model Luca has no price for.
export const CAP_PRICE_PER_MTOK = { input: 2.5, output: 10 };

export function llmCallCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES_PER_MTOK.find(([prefix]) => model.startsWith(prefix));
  if (!price) return 0;
  return (inputTokens * price[1] + outputTokens * price[2]) / 1_000_000;
}
