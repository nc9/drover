import { useState } from "react";
import { api, useFetch, type ScenarioResult } from "../lib/api.ts";
import { navigate } from "../lib/route.ts";
import { cn, formatMs, formatTokens, formatUsd } from "../lib/format.ts";
import { EventTimeline } from "../components/event-timeline.tsx";

export function ScenarioPage({
  runset,
  scenario,
}: {
  runset: string;
  scenario: string;
}): React.ReactElement {
  const { data, loading, error } = useFetch<ScenarioResult>(api.scenario(runset, scenario));
  const [showRaw, setShowRaw] = useState(false);

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
          onClick={(): void => navigate({ name: "runset", runset })}
          className="text-zinc-500 hover:text-zinc-300 font-mono"
        >
          {runset}
        </button>
        <span className="text-zinc-700">/</span>
        <span className="font-mono text-zinc-300">{scenario}</span>
      </header>

      {loading && <div className="text-sm text-zinc-500">loading…</div>}
      {error && <div className="text-sm text-red-400 font-mono">error: {error}</div>}

      {data && (
        <div className="space-y-5">
          <ScenarioHeader r={data} />
          <Section title="Output">
            {data.error ? (
              <div className="border border-red-900/60 bg-red-950/30 rounded px-3 py-2 text-sm">
                <div className="font-mono text-red-300 text-xs uppercase tracking-wider">
                  {data.error.tag}
                </div>
                <div className="mt-1 text-red-100 font-mono text-xs">{data.error.message}</div>
              </div>
            ) : data.output !== undefined ? (
              <pre className="text-[11px] mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[420px] overflow-auto text-zinc-200">
                {JSON.stringify(data.output, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-zinc-500">no structured output</div>
            )}
          </Section>

          <Section
            title="Conversation"
            right={
              <button
                type="button"
                onClick={(): void => setShowRaw((v) => !v)}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 font-mono"
              >
                {showRaw ? "hide raw events" : "show raw events"}
              </button>
            }
          >
            <div className="border border-zinc-800 rounded overflow-hidden">
              <EventTimeline events={data.events} />
            </div>
            {showRaw && (
              <pre className="mt-3 text-[10px] mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[480px] overflow-auto text-zinc-500">
                {JSON.stringify(data.events, null, 2)}
              </pre>
            )}
          </Section>

          {data.trace.length > 0 && (
            <Section title={`Trace steps (${data.trace.length})`}>
              <pre className="text-[10px] mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[280px] overflow-auto text-zinc-400">
                {JSON.stringify(data.trace, null, 2)}
              </pre>
            </Section>
          )}

          {data.finalText && !data.output && (
            <Section title="Final text (unparsed)">
              <pre className="text-xs mono whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-3 max-h-[320px] overflow-auto text-zinc-300">
                {data.finalText}
              </pre>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function ScenarioHeader({ r }: { r: ScenarioResult }): React.ReactElement {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">{r.name}</h1>
        <div className="text-sm text-zinc-500 mt-1">{r.description}</div>
        <div className="text-[11px] font-mono text-zinc-600 mt-1">
          {r.id} · {r.category} · started {new Date(r.startedAt).toLocaleString()}
        </div>
      </div>
      <div className="grid grid-cols-6 gap-3 text-xs font-mono">
        <Tile label="status" value={r.status} tone={r.status === "success" ? "ok" : "warn"} />
        <Tile label="turns" value={String(r.turns)} />
        <Tile label="tokens" value={`${formatTokens(r.tokens.input)}/${formatTokens(r.tokens.output)}`} />
        <Tile label="cost" value={formatUsd(r.costUsd)} />
        <Tile label="duration" value={formatMs(r.durationMs)} />
        <Tile label="tools" value={String(r.toolCalls.length)} />
      </div>
      {r.toolCalls.length > 0 && (
        <div className="text-[11px] font-mono text-zinc-500">
          calls: {r.toolCalls.join(" → ")}
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
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[11px] uppercase tracking-wider font-mono text-zinc-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
