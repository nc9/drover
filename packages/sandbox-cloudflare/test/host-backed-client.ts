/**
 * A Cloudflare sandbox client backed by the host, for the conformance suite. It EXECUTES:
 * `exec` spawns the real command (`/bin/sh -c ...`) in a real temp directory, and the file
 * methods are real file I/O there. Container paths are host paths under that directory.
 *
 * What it mimics from the SDK contract (the structural slices in cloudflare-sandbox.ts):
 * - `exec` starts a process; `output()` resolves once it exits with stdout, stderr and the exit
 *   code; `kill(9)` kills the whole process tree;
 * - only the env passed to the exec (plus `PATH`) is visible: nothing from the host;
 * - `readFile` of a missing file and `writeFile` into a missing directory reject (ENOENT);
 *   `listFiles` and `mkdir` report `{ success }`;
 * - the egress controls exist and record what the adapter set (deny-all by default).
 *
 * It is not an isolation boundary and is never one in these tests.
 */
import * as fs from "node:fs/promises";

import type {
  CloudflareProcessHandle,
  CloudflareSandboxClient,
  CloudflareSandboxHandle,
} from "../src/cloudflare-sandbox.ts";

export interface HostBackedCloudflare {
  client: CloudflareSandboxClient;
  /** Egress lists the adapter applied. */
  egress: { allowed?: string[]; denied?: string[] };
}

export function hostBackedCloudflareClient(): HostBackedCloudflare {
  const egress: HostBackedCloudflare["egress"] = {};
  let n = 0;

  const exec: CloudflareSandboxHandle["exec"] = async (command, options) => {
    const proc = Bun.spawn([...command], {
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options?.env },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const out = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const handle: CloudflareProcessHandle = {
      id: `proc-${++n}`,
      output: async () => {
        const [stdout, stderr, exitCode] = await out;
        return { stdout, stderr, exitCode, timedOut: false, truncated: false };
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

  const sandbox: CloudflareSandboxHandle = {
    exec,
    readFile: async (p) => ({ success: true, content: await fs.readFile(p, "utf8") }),
    writeFile: async (p, content) => {
      await fs.writeFile(p, content);
      return { success: true };
    },
    listFiles: async (p) => ({
      success: true,
      files: (await fs.readdir(p)).map((name) => ({ name })),
    }),
    mkdir: async (p, opts) => {
      await fs.mkdir(p, opts);
      return { success: true };
    },
    setAllowedHosts: async (hosts) => {
      egress.allowed = hosts;
    },
    setDeniedHosts: async (hosts) => {
      egress.denied = hosts;
    },
  };

  return { client: { getSandbox: () => sandbox }, egress };
}
