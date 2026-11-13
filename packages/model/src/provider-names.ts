/** The pre-1.0.3 pi-ai name of the Azure provider, accepted as a deprecated alias for `azure`. */
export const DEPRECATED_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "azure-openai-responses": "azure",
};

/** The current pi-ai provider name for `name` (the deprecated Azure name maps to `azure`). */
export const canonicalProvider = (name: string): string =>
  Object.hasOwn(DEPRECATED_PROVIDER_ALIASES, name) ? DEPRECATED_PROVIDER_ALIASES[name]! : name;
