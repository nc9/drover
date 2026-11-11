/**
 * A Vercel sandbox client backed by the host, for the conformance suite. It EXECUTES:
 * `runCommand` spawns the real command (`/bin/sh -c ...`) in a real temp directory, and
 * `sandbox.fs` is real file I/O there. VM paths are host paths under that directory, so
 * `pwd` and the files the suite writes line up with what the adapter is given.
 *
 * What it mimics from the SDK contract (the structural slices in vercel-sandbox.ts):
 * - commands start detached; `wait()` resolves with the exit code and buffered output;
 *   `kill("SIGKILL")` kills the command's whole process tree, as stopping a VM process does;
 * - only the env passed to the command (plus `PATH`) is visible: nothing from the host;
 * - `fs` is node:fs/promises-shaped: `writeFile` into a missing directory fails with ENOENT.
 *
 * It is not an isolation boundary and is never one in these tests.
 */
import * as fs from "node:fs/promises";

import type {
  VercelCommandHandle,
  VercelSandboxClient,
  VercelSandboxHandle,
} from "../src/vercel-sandbox.ts";

export interface HostBackedVercel {
  client: VercelSandboxClient;
  /** Commands the fake started, for assertions. */
  commands: string[];
}

export function hostBackedVercelClient(): HostBackedVercel {
  const commands: string[] = [];

  const runCommand: VercelSandboxHandle["runCommand"] = async (params) => {
    commands.push([params.cmd, ...(params.args ?? [])].join(" "));
    const proc = Bun.spawn([params.cmd, ...(params.args ?? [])], {
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...params.env },
      stdout: "pipe",
      stderr: "pipe",
      // Own process group, so kill() takes the whole tree down like a VM process stop.
      detached: true,
    });
    const out = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const handle: VercelCommandHandle = {
      wait: async () => {
        const [stdout, stderr, exitCode] = await out;
        return { exitCode, stdout: async () => stdout, stderr: async () => stderr };
      },
      kill: async () => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      },
    };
    return handle;
  };

  const sandbox: VercelSandboxHandle = {
    runCommand,
    fs: {
      readFile: (p, encoding) => fs.readFile(p, encoding),
      writeFile: (p, data) => fs.writeFile(p, data),
      readdir: (p) => fs.readdir(p),
      mkdir: async (p, opts) => {
        await fs.mkdir(p, opts);
      },
    },
    stop: async () => undefined,
  };

  return { client: { getOrCreate: async () => sandbox }, commands };
}
