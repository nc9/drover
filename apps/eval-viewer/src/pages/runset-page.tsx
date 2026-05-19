import { api, useFetch, type RunsetDetail } from "../lib/api.ts";
import { href, navigate } from "../lib/route.ts";
import { cn, formatMs, formatTokens, formatUsd } from "../lib/format.ts";

export function RunsetPage({ runset }: { runset: string }): React.ReactElement {
  const { data, loading, error } = useFetch<RunsetDetail>(api.runset(runset));

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={(): void => navigate({ name: "index" })}
          className="text-xs text-zinc-500 hover:text-zinc-300 font-mono"
        >
          ← all runsets
        </button>
        <h1 className="font-mono text-sm text-zinc-300">{runset}</h1>
      </header>

      {loading && <div className="text-sm text-zinc-500">loading…</div>}
      {error && <div className="text-sm text-red-400 font-mono">error: {error}</div>}

      {data && (
        <>
          <Totals scenarios={data.scenarios} />
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 font-mono border-b border-zinc-800">
                <th className="px-3 py-2 font-medium">scenario</th>
                <th className="px-3 py-2 font-medium">category</th>
                <th className="px-3 py-2 font-medium">status</th>
                <th className="px-3 py-2 font-medium text-right">turns</th>
                <th className="px-3 py-2 font-medium text-right">tokens</th>
                <th className="px-3 py-2 font-medium text-right">cost</th>
                <th className="px-3 py-2 font-medium text-right">time</th>
              </tr>
            </thead>
            <tbody>
              {data.scenarios.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer"
                  onClick={(): void => navigate({ name: "scenario", runset, scenario: s.id })}
                >
                  <td className="px-3 py-2.5">
                    <a
                      href={href({ name: "scenario", runset, scenario: s.id })}
                      className="font-mono text-zinc-200 hover:text-sky-300"
                      onClick={(e): void => e.stopPropagation()}
                    >
                      {s.id}
                    </a>
                    <div className="text-[11px] text-zinc-500 mt-0.5 max-w-md truncate">
                      {s.description}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-zinc-500 font-mono">{s.category}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "text-[11px] px-1.5 py-0.5 rounded font-mono",
                        s.status === "success"
                          ? "bg-emerald-950/60 text-emerald-300"
                          : "bg-red-950/60 text-red-300",
                      )}
                    >
                      {s.status === "success" ? "✓" : "✗"} {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-zinc-400">{s.turns}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                    {formatTokens(s.tokens.input)}/{formatTokens(s.tokens.output)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                    {formatUsd(s.costUsd)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                    {formatMs(s.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Totals({
  scenarios,
}: {
  scenarios: RunsetDetail["scenarios"];
}): React.ReactElement {
  const total = scenarios.length;
  const ok = scenarios.filter((s) => s.status === "success").length;
  const tokens = scenarios.reduce((s, x) => s + x.tokens.input + x.tokens.output, 0);
  const cost = scenarios.reduce((s, x) => s + x.costUsd, 0);
  const duration = scenarios.reduce((s, x) => s + x.durationMs, 0);
  return (
    <div className="mb-4 grid grid-cols-4 gap-3 text-xs font-mono">
      <Tile label="scenarios" value={`${ok}/${total}`} tone={ok === total ? "ok" : "warn"} />
      <Tile label="tokens" value={formatTokens(tokens)} />
      <Tile label="cost" value={formatUsd(cost)} />
      <Tile label="wall time" value={formatMs(duration)} />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}): React.ReactElement {
  return (
    <div className="border border-zinc-800 rounded px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div
        className={cn(
          "text-base font-semibold mt-0.5",
          tone === "ok" && "text-emerald-400",
          tone === "warn" && "text-amber-400",
          !tone && "text-zinc-200",
        )}
      >
        {value}
      </div>
    </div>
  );
}
