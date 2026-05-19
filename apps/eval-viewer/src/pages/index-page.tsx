import { api, useFetch, type RunsetSummary } from "../lib/api.ts";
import { href, navigate } from "../lib/route.ts";
import { cn, formatUsd, relativeTime } from "../lib/format.ts";

export function IndexPage(): React.ReactElement {
  const { data, loading, error } = useFetch<RunsetSummary[]>(api.runsets());

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">drover · evals</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {data?.length ?? 0} runsets · click into a runset to browse scenarios.
          </p>
        </div>
        <button
          type="button"
          onClick={(): void => navigate({ name: "storage" })}
          className="text-xs font-mono px-3 py-1.5 border border-zinc-700 rounded hover:border-zinc-500 text-zinc-300 hover:text-zinc-100"
        >
          storage runs →
        </button>
      </header>

      {loading && <div className="text-sm text-zinc-500">loading…</div>}
      {error && <div className="text-sm text-red-400 font-mono">error: {error}</div>}

      <div className="space-y-4">
        {data?.map((r) => (
          <RunsetCard key={r.id} runset={r} />
        ))}
      </div>
    </div>
  );
}

function RunsetCard({ runset }: { runset: RunsetSummary }): React.ReactElement {
  const total = runset.scenarios.length;
  const ok = runset.scenarios.filter((s) => s.status === "success").length;
  const cost = runset.scenarios.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  return (
    <div className="border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors">
      <button
        type="button"
        onClick={(): void => navigate({ name: "runset", runset: runset.id })}
        className="w-full text-left px-4 py-3 flex items-center gap-4"
      >
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-zinc-400 truncate">{runset.id}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{relativeTime(runset.ts)}</div>
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          <span className={cn(ok === total ? "text-emerald-400" : "text-amber-400")}>
            {ok}/{total} ok
          </span>
          <span className="font-mono">{formatUsd(cost)}</span>
        </div>
      </button>
      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
        {runset.scenarios.map((s) => (
          <a
            key={s.id}
            href={href({ name: "scenario", runset: runset.id, scenario: s.id })}
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-mono border transition-colors",
              s.status === "success"
                ? "border-emerald-900/60 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/60"
                : "border-red-900/60 bg-red-950/30 text-red-300 hover:bg-red-950/60",
            )}
          >
            {s.id}
          </a>
        ))}
      </div>
    </div>
  );
}
