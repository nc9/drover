import type { HarnessEvent, RunResult } from "@drover/core";

export interface RunsetSummary {
  id: string;
  ts: string;
  scenarios: Array<{
    id: string;
    status: string;
    turns: number;
    costUsd: number;
  }>;
}

export interface RunsetDetail {
  id: string;
  reportMd: string;
  scenarios: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    status: RunResult["status"];
    turns: number;
    durationMs: number;
    tokens: { input: number; output: number };
    costUsd: number;
    toolCalls: ReadonlyArray<string>;
    error?: { tag: string; message: string };
  }>;
}

export interface ScenarioResult {
  id: string;
  name: string;
  category: string;
  description: string;
  startedAt: string;
  durationMs: number;
  status: RunResult["status"];
  output?: unknown;
  finalText: string;
  turns: number;
  tokens: { input: number; output: number };
  costUsd: number;
  toolCalls: ReadonlyArray<string>;
  events: ReadonlyArray<HarnessEvent>;
  trace: ReadonlyArray<unknown>;
  error?: { tag: string; message: string };
  cwd?: string;
}
