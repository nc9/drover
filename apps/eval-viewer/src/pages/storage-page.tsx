import { api, useFetch, type StorageRunsResponse } from "../lib/api.ts";
import { href, navigate } from "../lib/route.ts";
import { cn, formatMs, formatTokens, formatUsd, relativeTime } from "../lib/format.ts";

export function StoragePage(): React.ReactElement {
  const { data, loading, error } = useFetch<StorageRunsResponse>(api.storageRuns(200));

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <header className="mb-4 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={(): void => navigate({ name: "index" })}
          className="text-zinc-500 hover:text-zinc-300 font-mono"
        >
          all runsets
        </button>
        <span className="text-zinc-700">/</span>
        <span className="font-mono text-zinc-300">storage</span>
      </header>

      <h1 className="text-xl font-semibold tracking-tight mb-1">Storage-backed runs</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Runs persisted via the libsql storage adapter (anywhere drover is
        wired with `storage`, not just the eval suite). Configure with{" "}
        <code className="mono text-xs bg-zinc-900 px-1 py-0.5 rounded">
          DROVER_STORAGE_URL
        </code>
        .
      </p>

      {loading && <div className="text-sm text-zinc-500">loading…</div>}
      {error && (
        <div className="text-sm text-red-400 font-mono">
          error: {error}
          {error.includes("503") && (
            <div className="mt-2 text-zinc-500">
              No DROVER_STORAGE_URL set. Start the viewer with{" "}
              <code className="mono">DROVER_STORAGE_URL=file:./path/to.db bun dev</code>.
            </div>
          )}
        </div>
      )}

      {data && data.runs.length === 0 && (
        <div className="text-sm text-zinc-500">No runs in storage yet.</div>
      )}

      {data && data.runs.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 font-mono border-b border-zinc-800">
              <th className="px-3 py-2 font-medium">run id</th>
              <th className="px-3 py-2 font-medium">agent</th>
              <th className="px-3 py-2 font-medium">status</th>
              <th className="px-3 py-2 font-medium text-right">tokens</th>
              <th className="px-3 py-2 font-medium text-right">cost</th>
              <th className="px-3 py-2 font-medium text-right">duration</th>
              <th className="px-3 py-2 font-medium text-right">started</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr
                key={r.id}
                className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer"
                onClick={(): void => navigate({ name: "storage-run", runId: r.id })}
              >
                <td className="px-3 py-2.5">
                  <a
                    href={href({ name: "storage-run", runId: r.id })}
                    className="font-mono text-zinc-200 hover:text-sky-300"
                    onClick={(e): void => e.stopPropagation()}
                  >
                    {r.id}
                  </a>
                  {r.parentRunId && (
                    <div className="text-[10px] font-mono text-zinc-600 mt-0.5">
                      child of {r.parentRunId}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-zinc-300">{r.agentId}</td>
                <td className="px-3 py-2.5">
                  <span
                    className={cn(
                      "text-[11px] px-1.5 py-0.5 rounded font-mono",
                      r.status === "success"
                        ? "bg-emerald-950/60 text-emerald-300"
                        : r.status === "paused"
                          ? "bg-amber-950/60 text-amber-300"
                          : "bg-red-950/60 text-red-300",
                    )}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                  {formatTokens(r.tokensIn)}/{formatTokens(r.tokensOut)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                  {formatUsd(r.costUsd)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-zinc-400">
                  {r.endedAt ? formatMs(r.endedAt - r.startedAt) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-zinc-500">
                  {relativeTime(new Date(r.startedAt).toISOString())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
