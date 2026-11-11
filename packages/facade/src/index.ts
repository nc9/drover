/**
 * Default entry: the full facade, with a just-bash sandbox when none is given.
 * Node/Bun only. For Workers and other bundler targets use
 * `@droveragent/facade/core` (same API, `sandbox` required, no just-bash).
 */
import * as path from "node:path";

import type { TSchema } from "@sinclair/typebox";
import type { AgentInput, AgentSpec } from "@droveragent/core";
import type { SandboxAdapter } from "@droveragent/sandbox";
import { createJustBashSandbox } from "@droveragent/sandbox-just-bash";

import {
  resumeAgent as coreResumeAgent,
  runAgent as coreRunAgent,
  type ResumeOptionsBase,
  type RunHandle,
  type RunOptionsBase,
} from "./core.ts";

export interface RunOptions extends RunOptionsBase {
  /**
   * Override the sandbox adapter. Defaults to a just-bash virtual sandbox
   * with the run cwd mounted read-write — isolated (no host network, no
   * filesystem access outside the mount) and safe for `bash` by default.
   */
  sandbox?: SandboxAdapter;
}

export interface ResumeOptions extends ResumeOptionsBase {
  /** Same default as {@link RunOptions.sandbox}. */
  sandbox?: SandboxAdapter;
}

type WithHostDefaults<O extends { cwd?: string; env?: Record<string, string> }> = O & {
  cwd: string;
  env: Record<string, string>;
  sandbox: SandboxAdapter;
};

const withHostDefaults = <
  O extends { cwd?: string; env?: Record<string, string>; sandbox?: SandboxAdapter },
>(
  options: O | undefined,
): WithHostDefaults<O> => {
  // Resolve to an absolute path: a relative `options.cwd` (e.g. ".") is a
  // valid host directory but an invalid just-bash mount target.
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const env =
    options?.env ??
    (Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>);
  const sandbox =
    options?.sandbox ??
    createJustBashSandbox({
      mounts: [{ source: cwd, target: cwd, mode: "readwrite" }],
      cwd,
    });
  return { ...(options as O), cwd, env, sandbox };
};

export function runAgent<S extends AgentSpec<TSchema, TSchema>>(
  spec: S,
  input: AgentInput<S>,
  options?: RunOptions,
): RunHandle<S> {
  return coreRunAgent(spec, input, withHostDefaults(options));
}

export function resumeAgent<S extends AgentSpec<TSchema, TSchema>>(
  spec: S,
  runId: string,
  options: ResumeOptions,
): RunHandle<S> {
  return coreResumeAgent(spec, runId, withHostDefaults(options));
}

export type { ResumeOptionsBase, RunHandle, RunOptionsBase } from "./core.ts";
export type {
  AgentSpec,
  AgentInput,
  AgentOutput,
  HarnessEvent,
  RunResult,
} from "@droveragent/core";
export {
  staticRegistry,
  withProviderCost,
  type AgentRegistry,
  type PreResolvedModel,
} from "@droveragent/harness";
export {
  createProviderChain,
  FAILOVER,
  type ProviderChain,
  type ProviderChainOptions,
} from "@droveragent/model";
export { createDisabledSandbox, type CoreSandbox } from "./core.ts";
