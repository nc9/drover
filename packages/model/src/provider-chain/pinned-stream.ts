/**
 * Full-options transport for the providers whose pi-ai "simple" stream drops the options the
 * chain pins (#74 review). pi-ai's `streamSimple` rebuilds the options for every provider with
 * `buildBaseOptions` (temperature, maxTokens, signal, apiKey, headers, ...), which has no
 * `azureBaseUrl` and no Bedrock `region` / `bearerToken`. pi-ai then falls back to
 * `process.env` (`AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_RESOURCE_NAME`, `AWS_REGION`), so a
 * chain entry's key could go to the process-wide host or region. For these providers the chain
 * calls pi-ai's full `stream()` with complete options instead, mapping the simple options
 * (base fields, reasoning) the way pi-ai 0.73.1's `streamSimpleAzureOpenAIResponses` /
 * `streamSimpleBedrock` do. Re-check this mapping on a pi-ai bump.
 */
import {
  clampThinkingLevel,
  stream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

/** Providers the chain sends through `pinnedStream` instead of `streamSimple`. */
export const PINNED_PROVIDERS: ReadonlySet<string> = new Set([
  "azure-openai-responses",
  "amazon-bedrock",
]);

/** Options the chain pins for a provider (`ChainCall.extra`), passed to pi-ai's full stream. */
export type PinnedOptions = {
  azureBaseUrl?: string;
  azureApiVersion?: string;
  azureDeploymentName?: string;
  region?: string;
  bearerToken?: string;
};

type Loose = Record<string, unknown>;

/** pi-ai's `buildBaseOptions` (simple-options.js), which pi-ai does not export. */
const baseOptions = (model: Model<Api>, o: SimpleStreamOptions | undefined): Loose => ({
  temperature: o?.temperature,
  maxTokens: o?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
  signal: o?.signal,
  apiKey: o?.apiKey,
  transport: (o as Loose | undefined)?.transport,
  cacheRetention: o?.cacheRetention,
  sessionId: o?.sessionId,
  headers: o?.headers,
  onPayload: o?.onPayload,
  onResponse: (o as Loose | undefined)?.onResponse,
  timeoutMs: (o as Loose | undefined)?.timeoutMs,
  maxRetries: o?.maxRetries,
  maxRetryDelayMs: (o as Loose | undefined)?.maxRetryDelayMs,
  metadata: (o as Loose | undefined)?.metadata,
});

// --- Bedrock reasoning, as pi-ai's streamSimpleBedrock (amazon-bedrock.js) ---------------
const matchCandidates = (id: string, name?: string): string[] =>
  (name ? [id, name] : [id]).flatMap((v) => {
    const lower = v.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
const supportsAdaptiveThinking = (id: string, name?: string): boolean =>
  matchCandidates(id, name).some(
    (s) => s.includes("opus-4-6") || s.includes("opus-4-7") || s.includes("sonnet-4-6"),
  );
const isAnthropicClaude = (model: Model<Api>): boolean => {
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase() ?? "";
  return (
    id.includes("anthropic.claude") ||
    id.includes("anthropic/claude") ||
    name.includes("anthropic.claude") ||
    name.includes("anthropic/claude") ||
    name.includes("claude")
  );
};
const clampReasoning = (effort: string): string => (effort === "xhigh" ? "high" : effort);
const adjustMaxTokensForThinking = (
  baseMaxTokens: number,
  modelMaxTokens: number,
  level: string,
  custom: Record<string, number> | undefined,
): { maxTokens: number; thinkingBudget: number } => {
  const budgets: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    ...custom,
  };
  let thinkingBudget = budgets[clampReasoning(level)] ?? 0;
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - 1024);
  return { maxTokens, thinkingBudget };
};

/** The complete options for pi-ai's full stream of `model`, from simple options plus pins. */
export function pinnedOptions(
  model: Model<Api>,
  o: (SimpleStreamOptions & PinnedOptions) | undefined,
): Loose {
  const base = baseOptions(model, o);
  const pins: Loose = {};
  for (const k of [
    "azureBaseUrl",
    "azureApiVersion",
    "azureDeploymentName",
    "region",
    "bearerToken",
  ] as const)
    if (o?.[k] !== undefined) pins[k] = o[k];
  if (model.provider === "azure-openai-responses") {
    const clamped = o?.reasoning ? clampThinkingLevel(model as never, o.reasoning) : undefined;
    return { ...base, ...pins, reasoningEffort: clamped === "off" ? undefined : clamped };
  }
  // amazon-bedrock
  if (!o?.reasoning) return { ...base, ...pins, reasoning: undefined };
  const thinkingBudgets = (o as Loose).thinkingBudgets as Record<string, number> | undefined;
  if (isAnthropicClaude(model) && !supportsAdaptiveThinking(model.id, model.name)) {
    const adjusted = adjustMaxTokensForThinking(
      (base.maxTokens as number | undefined) ?? 0,
      model.maxTokens,
      o.reasoning,
      thinkingBudgets,
    );
    return {
      ...base,
      ...pins,
      maxTokens: adjusted.maxTokens,
      reasoning: o.reasoning,
      thinkingBudgets: {
        ...thinkingBudgets,
        [clampReasoning(o.reasoning)]: adjusted.thinkingBudget,
      },
    };
  }
  return { ...base, ...pins, reasoning: o.reasoning, thinkingBudgets };
}

/** pi-ai's full `stream()` with the pinned options kept (see the module comment). */
export const pinnedStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions & PinnedOptions,
): AssistantMessageEventStream => stream(model, context, pinnedOptions(model, options) as never);
