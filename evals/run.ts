#!/usr/bin/env bun
// Eval runner. Walks ALL_SCENARIOS, runs each agent against OpenRouter,
// writes per-scenario JSON + a markdown report under eval-results/<runset>/.
//
// Usage:
//   bun run.ts                   # run all
//   bun run.ts write-article fix-code-bug   # subset

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { runAgent, staticRegistry } from "@droveragent/facade";
import { createMcpRuntime, type McpRuntime, type McpServerConfig } from "@droveragent/mcp";
import { createMemoryQueue, createRunApi, createWorkerPool } from "@droveragent/runtime";
import { createNoneSandbox } from "@droveragent/sandbox";
import { stepTracerPlugin } from "@droveragent/plugins";
import { createSkillRegistry, scanSkillDirs } from "@droveragent/skills";
import { createLibsqlStorage } from "@droveragent/storage";
import type { HarnessEvent, RunResult, AgentSpec } from "@droveragent/core";

import { ALL_SCENARIOS, SUBAGENT_REGISTRY, type Scenario } from "./scenarios/index.ts";
import { RUNTIME_QUEUE_SCENARIO, runtimeAgent } from "./scenarios/runtime-queue.ts";
import { MEMORY_SELF_LEARN_SCENARIO, memoryAgent } from "./scenarios/memory-self-learn.ts";
import { createInMemoryMemory } from "@droveragent/memory";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RESULTS_ROOT = path.join(ROOT, "eval-results");
const FIXTURES_ROOT = path.join(ROOT, "fixtures");

// MCP servers spawned per-runner. `bun <fixture>/server.ts` boots an
// stdio MCP server. The runtime stays alive across scenarios that share
// the same server.
const MCP_FIXTURE_CONFIGS: ReadonlyArray<McpServerConfig> = [
  {
    id: "fixture",
    transport: "stdio",
    command: "bun",
    args: [path.join(FIXTURES_ROOT, "mcp-stdio/server.ts")],
  },
];

interface ScenarioRun {
  id: string;
  name: string;
  category: string;
  description: string;
  startedAt: string;
  durationMs: number;
  status: RunResult["status"];
  output: unknown;
  finalText: string;
  turns: number;
  tokens: { input: number; output: number };
  costUsd: number;
  toolCalls: string[];
  events: HarnessEvent[];
  trace: ReadonlyArray<unknown>;
  error?: { tag: string; message: string };
  cwd?: string;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function runScenario(
  scenario: Scenario,
  runsetDir: string,
  mcpRuntime: McpRuntime | null,
): Promise<ScenarioRun> {
  console.log(`▶ ${scenario.id}  (${scenario.name})`);
  const startedAt = new Date();
  const scenarioDir = path.join(runsetDir, scenario.id);
  await fs.mkdir(scenarioDir, { recursive: true });

  let cwd: string | undefined;
  if (scenario.fixtureDir) {
    const fixtureSrc = path.join(FIXTURES_ROOT, scenario.fixtureDir);
    cwd = path.join(scenarioDir, "workdir");
    await copyDir(fixtureSrc, cwd);
  }

  // Eval runner opts into shell when the scenario uses `bash` — production
  // agents should think harder about whether they want this on.
  const needsShell = scenario.spec.tools.includes("bash");
  const sandbox = cwd
    ? createNoneSandbox({ allowedRoots: [cwd], allowShell: needsShell })
    : createNoneSandbox({ allowShell: needsShell });
  const tracer = stepTracerPlugin();

  // If the spec declares skills and the fixture has a `skills/` dir,
  // build a registry from it. Lets scenarios ship their own skill
  // libraries without polluting a shared global one.
  let skills: ReturnType<typeof createSkillRegistry> | undefined;
  if (scenario.spec.skills && scenario.spec.skills.length > 0 && cwd) {
    const skillsDir = path.join(cwd, "skills");
    const specs = await scanSkillDirs([skillsDir]);
    if (specs.length > 0) skills = createSkillRegistry(specs);
  }

  const handle = runAgent(scenario.spec, scenario.input, {
    ...(cwd ? { cwd } : {}),
    sandbox,
    plugins: [tracer.plugin],
    agentRegistry: staticRegistry(SUBAGENT_REGISTRY as Record<string, AgentSpec>),
    ...(skills ? { skills } : {}),
    ...(mcpRuntime && scenario.spec.mcpServers && scenario.spec.mcpServers.length > 0
      ? { mcpRuntime }
      : {}),
  });

  const events: HarnessEvent[] = [];
  const eventsConsumer = (async (): Promise<void> => {
    for await (const e of handle.events) {
      events.push(e);
      if (e.kind === "tool_call_start") {
        const args = JSON.stringify(e.input).slice(0, 140);
        console.log(`    🔧 ${e.toolName} ${args}`);
      } else if (e.kind === "tool_call_end" && e.result.isError) {
        console.log(`    ⚠ ${e.toolName} errored: ${e.result.content.slice(0, 200)}`);
      } else if (e.kind === "output_retry") {
        console.log(`    ↻ output retry #${e.attempt}: ${e.reason}`);
      } else if (e.kind === "error") {
        console.log(`    ✗ ${e.tag}: ${e.message}`);
      }
    }
  })();

  const result = await handle.result;
  await eventsConsumer;

  const durationMs = Date.now() - startedAt.getTime();
  const tokens = { input: result.usage.inputTokens, output: result.usage.outputTokens };
  const costUsd = result.usage.costUsd ?? 0;
  const symbol = result.status === "success" ? "✓" : "✗";
  console.log(
    `  ${symbol} ${result.status}  turns=${result.turns}  ${(durationMs / 1000).toFixed(1)}s  ${tokens.input}/${tokens.output}tok  $${costUsd.toFixed(5)}`,
  );

  const out: ScenarioRun = {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    description: scenario.description,
    startedAt: startedAt.toISOString(),
    durationMs,
    status: result.status,
    output: result.output,
    finalText: result.finalText,
    turns: result.turns,
    tokens,
    costUsd,
    toolCalls: [...result.toolCalls],
    events,
    trace: [...tracer.steps],
    ...(result.error ? { error: result.error } : {}),
    ...(cwd ? { cwd } : {}),
  };

  await fs.writeFile(
    path.join(scenarioDir, "result.json"),
    JSON.stringify(out, null, 2),
  );
  return out;
}

async function runMemorySelfLearnScenario(runsetDir: string): Promise<ScenarioRun> {
  const s = MEMORY_SELF_LEARN_SCENARIO;
  console.log(`▶ ${s.id}  (${s.name})`);
  const startedAt = new Date();
  const scenarioDir = path.join(runsetDir, s.id);
  await fs.mkdir(scenarioDir, { recursive: true });

  // Pre-seed the adapter with one global fact the agent should surface.
  const memory = createInMemoryMemory();
  await (
    await import("effect")
  ).Effect.runPromise(memory.put(s.seed));

  const tracer = stepTracerPlugin();
  const handle = runAgent(
    s.agent,
    { question: s.question },
    {
      memory,
      plugins: [tracer.plugin],
    },
  );

  const events: HarnessEvent[] = [];
  for await (const e of handle.events) {
    events.push(e);
    if (e.kind === "tool_call_start") {
      console.log(`    🔧 ${e.toolName} ${JSON.stringify(e.input).slice(0, 140)}`);
    } else if (e.kind === "memory_written") {
      console.log(`    📝 memory_written ${e.entry.scope}/${e.entry.kind} "${e.entry.summary}"`);
    } else if (e.kind === "memory_recalled") {
      console.log(`    🔎 memory_recalled q="${e.query ?? ""}" hits=${e.hits.length}`);
    }
  }

  const result = await handle.result;
  const durationMs = Date.now() - startedAt.getTime();
  const tokens = { input: result.usage.inputTokens, output: result.usage.outputTokens };
  const symbol = result.status === "success" ? "✓" : "✗";
  console.log(
    `  ${symbol} ${result.status}  turns=${result.turns}  ${(durationMs / 1000).toFixed(1)}s  ${tokens.input}/${tokens.output}tok  $${(result.usage.costUsd ?? 0).toFixed(5)}`,
  );

  const out: ScenarioRun = {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    startedAt: startedAt.toISOString(),
    durationMs,
    status: result.status,
    output: result.output,
    finalText: result.finalText,
    turns: result.turns,
    tokens,
    costUsd: result.usage.costUsd ?? 0,
    toolCalls: [...result.toolCalls],
    events,
    trace: [...tracer.steps],
    ...(result.error ? { error: result.error } : {}),
  };
  await fs.writeFile(path.join(scenarioDir, "result.json"), JSON.stringify(out, null, 2));
  return out;
}

async function runRuntimeQueueScenario(runsetDir: string): Promise<ScenarioRun> {
  const s = RUNTIME_QUEUE_SCENARIO;
  console.log(`▶ ${s.id}  (${s.name})`);
  const startedAt = new Date();
  const scenarioDir = path.join(runsetDir, s.id);
  await fs.mkdir(scenarioDir, { recursive: true });

  const queue = createMemoryQueue();
  const storage = await createLibsqlStorage({ url: ":memory:" });
  const registry = staticRegistry({ [s.agent.id]: s.agent as unknown as AgentSpec });
  const sandboxFor = (): ReturnType<typeof createNoneSandbox> => createNoneSandbox();

  const pool = createWorkerPool(
    { queue, storage, registry, sandboxFor },
    { concurrency: s.concurrency },
  );
  const api = createRunApi({ queue, storage, registry, sandboxFor });
  pool.start();

  const jobIds: string[] = [];
  for (let i = 0; i < s.jobCount; i++) {
    const id = `runtime-job-${i}`;
    jobIds.push(id);
    await api.enqueue({ id, agentId: s.agent.id, input: { n: i } });
  }
  console.log(`    enqueued ${jobIds.length} jobs, concurrency=${s.concurrency}`);

  const finals = await Promise.all(
    jobIds.map((id) => api.waitFor(id, { timeoutMs: 120_000 })),
  );
  await pool.stop();

  const stats = pool.stats();
  const okCount = finals.filter((f) => f.job.status === "done").length;
  const status: RunResult["status"] = okCount === s.jobCount ? "success" : "error";
  const durationMs = Date.now() - startedAt.getTime();
  console.log(
    `  ${status === "success" ? "✓" : "✗"} ${status}  ${okCount}/${s.jobCount} done  processed=${stats.processed} failed=${stats.failed}  ${(durationMs / 1000).toFixed(1)}s`,
  );

  const tokens = finals.reduce(
    (acc, f) => ({
      input: acc.input + (f.run?.tokensIn ?? 0),
      output: acc.output + (f.run?.tokensOut ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const costUsd = finals.reduce((s, f) => s + (f.run?.costUsd ?? 0), 0);

  const out: ScenarioRun = {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    startedAt: startedAt.toISOString(),
    durationMs,
    status,
    output: finals.map((f) => ({
      jobId: f.job.id,
      queueStatus: f.job.status,
      runStatus: f.run?.status,
      output: f.run?.output,
    })),
    finalText: "",
    turns: finals.reduce((acc, f) => acc + (f.run?.id ? 1 : 0), 0),
    tokens,
    costUsd,
    toolCalls: [],
    events: [],
    trace: [],
  };
  await fs.writeFile(path.join(scenarioDir, "result.json"), JSON.stringify(out, null, 2));
  return out;
}

function renderReport(runs: ScenarioRun[]): string {
  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
  const totalTokens = runs.reduce((s, r) => s + r.tokens.input + r.tokens.output, 0);
  const ok = runs.filter((r) => r.status === "success").length;
  const lines: string[] = [];
  lines.push(`# Drover eval run`);
  lines.push("");
  lines.push(`- Scenarios: ${runs.length}`);
  lines.push(`- Succeeded (schema-valid): ${ok}/${runs.length}`);
  lines.push(`- Total tokens: ${totalTokens.toLocaleString()}`);
  lines.push(`- Total cost: $${totalCost.toFixed(5)}`);
  lines.push("");
  lines.push("| Scenario | Category | Status | Turns | Tokens (in/out) | Cost | Duration |");
  lines.push("|---|---|---|---:|---:|---:|---:|");
  for (const r of runs) {
    lines.push(
      `| ${r.id} | ${r.category} | ${r.status === "success" ? "✓" : "✗ " + r.status} | ${r.turns} | ${r.tokens.input}/${r.tokens.output} | $${r.costUsd.toFixed(5)} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");
  for (const r of runs) {
    lines.push(`## ${r.id} — ${r.name}`);
    lines.push("");
    lines.push(`*${r.description}*`);
    lines.push("");
    if (r.error) lines.push(`**Error:** \`${r.error.tag}\` — ${r.error.message}\n`);
    if (r.toolCalls.length > 0) lines.push(`**Tools used:** ${r.toolCalls.join(", ")}\n`);
    lines.push(`### Output`);
    lines.push("```json");
    lines.push(JSON.stringify(r.output ?? r.finalText, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const filter = new Set(argv);
  const scenarios = ALL_SCENARIOS.filter((s) => filter.size === 0 || filter.has(s.id));
  const wantsRuntime = filter.size === 0 || filter.has(RUNTIME_QUEUE_SCENARIO.id);
  const wantsMemory = filter.size === 0 || filter.has(MEMORY_SELF_LEARN_SCENARIO.id);
  if (scenarios.length === 0 && !wantsRuntime && !wantsMemory) {
    console.error(`no scenarios match: ${argv.join(", ")}`);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runsetDir = path.join(RESULTS_ROOT, stamp);
  await fs.mkdir(runsetDir, { recursive: true });
  console.log(`results → ${runsetDir}\n`);

  // Spin up MCP fixtures iff at least one scenario in this run needs them.
  // Saves ~150ms of bun-spawn time on suites that don't touch MCP.
  const needsMcp = scenarios.some(
    (s) => s.spec.mcpServers && s.spec.mcpServers.length > 0,
  );
  let mcpRuntime: McpRuntime | null = null;
  if (needsMcp) {
    console.log(`booting MCP fixtures: ${MCP_FIXTURE_CONFIGS.map((c) => c.id).join(", ")}`);
    mcpRuntime = await createMcpRuntime(MCP_FIXTURE_CONFIGS);
    for (const info of mcpRuntime.servers()) {
      console.log(`  ${info.id} (${info.transport}) → ${info.toolCount} tools`);
    }
    console.log();
  }

  const runs: ScenarioRun[] = [];

  // Runtime-queue scenario uses a custom code path (queue + worker
  // pool + RunApi), not the standard runAgent surface.
  if (wantsRuntime) {
    try {
      runs.push(await runRuntimeQueueScenario(runsetDir));
    } catch (err) {
      console.error(`  fatal: ${(err as Error).message}`);
    }
  }

  if (wantsMemory) {
    try {
      runs.push(await runMemorySelfLearnScenario(runsetDir));
    } catch (err) {
      console.error(`  fatal: ${(err as Error).message}`);
    }
  }

  for (const s of scenarios) {
    try {
      runs.push(await runScenario(s, runsetDir, mcpRuntime));
    } catch (err) {
      console.error(`  fatal: ${(err as Error).message}`);
      runs.push({
        id: s.id,
        name: s.name,
        category: s.category,
        description: s.description,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: "error",
        output: undefined,
        finalText: "",
        turns: 0,
        tokens: { input: 0, output: 0 },
        costUsd: 0,
        toolCalls: [],
        events: [],
        trace: [],
        error: { tag: "Fatal", message: (err as Error).message },
      });
    }
  }

  const report = renderReport(runs);
  await fs.writeFile(path.join(runsetDir, "report.md"), report);

  console.log(`\n=== summary ===`);
  console.log(report.split("\n").slice(0, 14).join("\n"));
  console.log(`\nFull report: ${path.join(runsetDir, "report.md")}`);

  if (mcpRuntime) await mcpRuntime.close();
}

await main();
