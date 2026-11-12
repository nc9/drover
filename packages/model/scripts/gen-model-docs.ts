/**
 * Regenerates the alias table and the pi-ai provider list in docs/reference/model.mdx
 * from the installed pi-ai registry. Run from packages/model: `bun scripts/gen-model-docs.ts`.
 */
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { DEFAULT_ALIASES } from "../src/aliases.ts";

const fmt = (n: number): string => n.toFixed(2);
const rows = Object.entries(DEFAULT_ALIASES).reduce<Map<string, string[]>>((acc, [name, e]) => {
  const k = `${e.provider}/${e.modelId}`;
  acc.set(k, [...(acc.get(k) ?? []), name]);
  return acc;
}, new Map());
const table = [...rows].map(([target, names]) => {
  const [provider, ...rest] = target.split("/");
  const m = getModel(provider as never, rest.join("/") as never) as unknown as {
    cost: { input: number; output: number };
  };
  return [
    names.map((n) => `\`${n}\``).join(" / "),
    `\`${target}\``,
    `${fmt(m.cost.input)} / ${fmt(m.cost.output)}`,
  ];
});
const header = ["alias", "resolves to", "$/Mtok in/out"];
const w = [0, 1, 2].map((i) => Math.max(header[i]!.length, ...table.map((r) => r[i]!.length)));
const line = (r: string[]): string => `| ${r.map((c, i) => c.padEnd(w[i]!)).join(" | ")} |`;
console.log(
  [
    line(header),
    `| ${w.map((n) => "-".repeat(n)).join(" | ")} |`,
    ...table.map(line),
  ].join("\n"),
);
console.log("");
const providers = [...getProviders()].sort();
console.log(
  `${providers.length} providers, ${providers.reduce((n, p) => n + getModels(p as never).length, 0)} models:\n`,
);
console.log(providers.map((p) => `\`${p}\` (${getModels(p as never).length})`).join(", "));
