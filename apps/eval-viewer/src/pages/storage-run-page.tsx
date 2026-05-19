import { api, useFetch, type StorageRunDetail } from "../lib/api.ts";
import { navigate } from "../lib/route.ts";
import { cn, formatMs, formatTokens, formatUsd } from "../lib/format.ts";
import { EventTimeline } from "../components/event-timeline.tsx";
import type { HarnessEvent } from "@drover/core";

export function StorageRunPage({ runId }: { runId: string }): React.ReactElement {
  const { data, loading, error } = useFetch<StorageRunDetail>(api.storageRun(runId));

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
        <button
          type="button"
          onClick={(): void => navigate({ name: "storage" })}
          className="text-zinc-500 hover:text-zinc-300 font-mono"
        >
          storage
        </button>
        <span className="text-zinc-700">/</span>
        <span className="font-mono text-zinc-300">{runId}</span>
      </header>

      {loading && <div className="text-sm text-zinc-500">loading…</div>}
      {error && <div className="text-sm text-red-400 font-mono">error: {error}</div>}

      {data && (
        <div className="space-y-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
              {data.run.agentId}
            </h1>
            <div className="text-[11px] font-mono text-zinc-600 mt-1">
              run {data.run.id} · started {new Date(data.run.startedAt).toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-6 gap-3 text-xs font-mono">
            <Tile
              label="status"
              value={data.run.status}
              tone={
                data.run.status === "success"
                  ? "ok"
                  : data.run.status === "paused"
                    ? "warn"
                    : "warn"
              }
            />
            <Tile
              label="tokens"
              value={`${formatTokens(data.run.tokensIn)}/${formatTokens(data.run.tokensOut)}`}
            />
            <Tile label="cost" value={formatUsd(data.run.costUsd)} />
            <Tile
              label="duration"
              value={data.run.endedAt ? formatMs(data.run.endedAt - data.run.startedAt) : "—"}
            />
            <Tile label="events" value={String(data.events.length)} />
            <Tile
              label="checkpoint"
              value={data.checkpoint ? `seq ${data.checkpoint.seq}` : "—"}
            />
          </div>

          <Section title="Output">
            {data.run.error ? (
              <div className="border border-red-900/60 bg-red-950/30 rounded px-3 py-2 text-sm">
                <div className="font-mono text-red-300 text-xs uppercase tracking-wider">
                  {data.run.error.tag}
                </div>
                <div className="mt-1 text-red-100 font-mono text-xs">
                  {data.run.error.message}
                </div>
              </div>
            ) : data.run.output !== undefined ? (
              <pre className="text-[11px] mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[420px] overflow-auto text-zinc-200">
                {JSON.stringify(data.run.output, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-zinc-500">no output yet</div>
            )}
          </Section>

          <Section title="Conversation">
            <div className="border border-zinc-800 rounded overflow-hidden">
              <EventTimeline events={data.events as ReadonlyArray<HarnessEvent>} />
            </div>
          </Section>

          {data.run.parentRunId && (
            <Section title="Lineage">
              <div className="text-sm text-zinc-300">
                Spawned by{" "}
                <button
                  type="button"
                  onClick={(): void =>
                    navigate({ name: "storage-run", runId: data.run.parentRunId! })
                  }
                  className="font-mono text-sky-400 hover:text-sky-300"
                >
                  {data.run.parentRunId}
                </button>
              </div>
            </Section>
          )}
        </div>
      )}
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
    <div className="border border-zinc-800 rounded px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div
        className={cn(
          "text-sm font-semibold mt-0.5 truncate",
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider font-mono text-zinc-400 mb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}
