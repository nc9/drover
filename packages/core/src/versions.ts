/**
 * The Drover packages loaded in this process and their versions, e.g.
 * `{ "@droveragent/core": "0.3.0", "@droveragent/harness": "0.3.0+local.1a2b3c4" }`.
 *
 * Every package registers itself when its main entry is loaded. A release build reports the
 * plain package version; a build from a working tree reports `<version>+local.<git sha>`
 * (`+local` without git); code run unbuilt from source reports `source`. When two copies of
 * one package are loaded (a linked build next to an installed one), its value lists both,
 * comma-separated: that is the mix-up to look for.
 */
export function droverVersions(): Record<string, string> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Set<string>> | undefined>;
  const registry = holder[Symbol.for("droveragent.versions")] ?? new Map<string, Set<string>>();
  const out: Record<string, string> = {};
  for (const name of [...registry.keys()].toSorted()) {
    out[name] = [...(registry.get(name) ?? [])].join(", ");
  }
  return out;
}
