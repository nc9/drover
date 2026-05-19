import { useEffect, useState } from "react";
import type { RunsetSummary, RunsetDetail, ScenarioResult } from "../types.ts";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export function useFetch<T>(url: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    getJson<T>(url)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return (): void => {
      alive = false;
    };
  }, [url]);
  return { data, loading, error };
}

export const api = {
  runsets: (): string => `/api/runsets`,
  runset: (id: string): string => `/api/runsets/${encodeURIComponent(id)}`,
  scenario: (runset: string, scenario: string): string =>
    `/api/runsets/${encodeURIComponent(runset)}/${encodeURIComponent(scenario)}`,
  storageRuns: (limit?: number): string =>
    `/api/storage/runs${limit ? `?limit=${limit}` : ""}`,
  storageRun: (id: string): string => `/api/storage/runs/${encodeURIComponent(id)}`,
};

/** Shape of /api/storage/runs response. */
export interface StorageRunsResponse {
  runs: Array<{
    id: string;
    agentId: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    parentRunId?: string;
  }>;
}

/** Shape of /api/storage/runs/:id response. */
export interface StorageRunDetail {
  run: StorageRunsResponse["runs"][number] & {
    input: unknown;
    output?: unknown;
    error?: { tag: string; message: string };
    specHash: string;
  };
  events: ReadonlyArray<unknown>;
  checkpoint: { seq: number; usage: { inputTokens: number; outputTokens: number } } | null;
}

export type { RunsetSummary, RunsetDetail, ScenarioResult };
