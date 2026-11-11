import { SandboxError } from "@droveragent/core";
import { Effect } from "effect";

import type { SandboxAdapter } from "./adapter.ts";

/**
 * What a conformance run needs from an adapter under test: the adapter, a
 * writable working directory inside it, and an optional teardown.
 */
export interface SandboxConformanceSubject {
  readonly adapter: SandboxAdapter;
  /** Absolute, canonical directory inside the sandbox the suite may write to. */
  readonly workdir: string;
  /** Called once after each case. */
  readonly cleanup?: () => Promise<void> | void;
}

export interface SandboxConformanceOptions {
  /** The `capabilities.shell` value this adapter must advertise. */
  readonly expectShell: boolean;
}

/** One named contract check. `run` throws (any Error) on violation. */
export interface SandboxConformanceCase {
  readonly name: string;
  readonly run: (subject: SandboxConformanceSubject) => Promise<void>;
}

export interface SandboxConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

export type SandboxConformanceFactory = () =>
  | Promise<SandboxConformanceSubject>
  | SandboxConformanceSubject;

function check(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  check(
    Object.is(actual, expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const sh = (script: string): readonly [string, ReadonlyArray<string>] => [
  "/bin/sh",
  ["-c", script],
];

/**
 * The SandboxAdapter contract as data. Framework-agnostic: register each case
 * with your own test runner, or call {@link runSandboxConformance}.
 */
export function sandboxConformanceCases(
  options: SandboxConformanceOptions,
): ReadonlyArray<SandboxConformanceCase> {
  const cases: SandboxConformanceCase[] = [
    {
      name: "declares a boolean shell capability matching the expectation",
      run: async ({ adapter }) => {
        equal(typeof adapter.capabilities.shell, "boolean", "capabilities.shell type");
        equal(adapter.capabilities.shell, options.expectShell, "capabilities.shell");
        check(adapter.id.length > 0, "id must be a non-empty string");
      },
    },
    {
      name: "run: exit code 0 with stdout captured",
      run: async ({ adapter, workdir }) => {
        const r = await Effect.runPromise(adapter.run(...sh("echo hello"), { cwd: workdir }));
        equal(r.exitCode, 0, "exitCode");
        equal(r.stdout, "hello\n", "stdout");
        equal(r.stderr, "", "stderr");
        check(r.killed !== true, "killed must not be set on a normal exit");
      },
    },
    {
      name: "run: non-zero exit is a result, not an error; stderr is separate",
      run: async ({ adapter, workdir }) => {
        const r = await Effect.runPromise(
          adapter.run(...sh("echo out; echo err >&2; exit 3"), { cwd: workdir }),
        );
        equal(r.exitCode, 3, "exitCode");
        equal(r.stdout, "out\n", "stdout");
        equal(r.stderr, "err\n", "stderr");
      },
    },
    {
      name: "run: env passed per exec is visible and does not leak to the next exec",
      run: async ({ adapter, workdir }) => {
        const script = 'echo "v=${DROVER_CONFORMANCE_VAR:-unset}"';
        const withEnv = await Effect.runPromise(
          adapter.run(...sh(script), { cwd: workdir, env: { DROVER_CONFORMANCE_VAR: "abc" } }),
        );
        equal(withEnv.stdout, "v=abc\n", "stdout with env");
        const without = await Effect.runPromise(adapter.run(...sh(script), { cwd: workdir }));
        equal(without.stdout, "v=unset\n", "stdout without env");
      },
    },
    {
      name: "run: cwd is honoured",
      run: async ({ adapter, workdir }) => {
        const r = await Effect.runPromise(adapter.run(...sh("pwd"), { cwd: workdir }));
        equal(r.exitCode, 0, "exitCode");
        equal(r.stdout.trim(), workdir, "pwd");
      },
    },
    {
      name: "run: timeout resolves with killed:true instead of failing",
      run: async ({ adapter, workdir }) => {
        const started = Date.now();
        const r = await Effect.runPromise(
          adapter.run(...sh("sleep 5"), { cwd: workdir, timeoutMs: 200 }),
        );
        equal(r.killed, true, "killed");
        check(Date.now() - started < 4_000, "timeout was not enforced promptly");
      },
    },
    {
      name: "run: aborting the signal resolves with killed:true",
      run: async ({ adapter, workdir }) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 150);
        try {
          const r = await Effect.runPromise(
            adapter.run(...sh("sleep 5"), { cwd: workdir, signal: ac.signal }),
          );
          equal(r.killed, true, "killed");
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      name: "run: an already-aborted signal resolves with killed:true promptly",
      run: async ({ adapter, workdir }) => {
        const started = Date.now();
        const r = await Effect.runPromise(
          adapter.run(...sh("sleep 5"), { cwd: workdir, signal: AbortSignal.abort() }),
        );
        equal(r.killed, true, "killed");
        check(Date.now() - started < 4_000, "pre-aborted signal was not honoured promptly");
      },
    },
    {
      name: "writeFile then readFile round-trips, including nested new directories",
      run: async ({ adapter, workdir }) => {
        const p = `${workdir}/nested/dir/file.txt`;
        const body = "line one\nunicode: é世\n";
        await Effect.runPromise(adapter.writeFile(p, body));
        equal(await Effect.runPromise(adapter.readFile(p)), body, "readFile");
      },
    },
    {
      name: "writeFile overwrites existing content",
      run: async ({ adapter, workdir }) => {
        const p = `${workdir}/overwrite.txt`;
        await Effect.runPromise(adapter.writeFile(p, "first"));
        await Effect.runPromise(adapter.writeFile(p, "second"));
        equal(await Effect.runPromise(adapter.readFile(p)), "second", "readFile");
      },
    },
    {
      name: "files written by writeFile are visible to run",
      run: async ({ adapter, workdir }) => {
        await Effect.runPromise(adapter.writeFile(`${workdir}/seen.txt`, "from-write\n"));
        const r = await Effect.runPromise(adapter.run(...sh("cat seen.txt"), { cwd: workdir }));
        equal(r.stdout, "from-write\n", "stdout");
      },
    },
    {
      name: "readFile of a missing file fails with a typed SandboxError (op read)",
      run: async ({ adapter, workdir }) => {
        const p = `${workdir}/definitely-missing.txt`;
        const r = await Effect.runPromise(Effect.either(adapter.readFile(p)));
        equal(r._tag, "Left", "result tag");
        if (r._tag === "Left") {
          check(r.left instanceof SandboxError, "error must be a SandboxError");
          equal(r.left._tag, "SandboxError", "error _tag");
          equal(r.left.op, "read", "error op");
          check(r.left.message.length > 0, "error message must be non-empty");
        }
      },
    },
    {
      name: "resolvePath is a pure join: relative against cwd, absolute normalised",
      run: async ({ adapter }) => {
        equal(adapter.resolvePath("a/b.txt", "/base/dir"), "/base/dir/a/b.txt", "relative");
        equal(adapter.resolvePath("/x/y/../z", "/base/dir"), "/x/z", "absolute");
        equal(adapter.resolvePath("../up.txt", "/base/dir"), "/base/up.txt", "parent");
      },
    },
    {
      name: "assertPathAllowed accepts the workdir",
      run: async ({ adapter, workdir }) => {
        const r = await Effect.runPromise(Effect.either(adapter.assertPathAllowed(workdir)));
        equal(r._tag, "Right", "result tag");
      },
    },
    {
      name: "readdir (when provided) lists written entries by name",
      run: async ({ adapter, workdir }) => {
        if (adapter.readdir === undefined) return;
        await Effect.runPromise(adapter.writeFile(`${workdir}/ls/one.txt`, "1"));
        await Effect.runPromise(adapter.writeFile(`${workdir}/ls/two.txt`, "2"));
        const names = await Effect.runPromise(adapter.readdir(`${workdir}/ls`));
        equal([...names].sort().join(","), "one.txt,two.txt", "entries");
      },
    },
  ];
  return cases;
}

/**
 * Run every conformance case against fresh subjects from `factory` and
 * return the per-case outcome. Never throws for a contract violation.
 */
export async function runSandboxConformance(
  factory: SandboxConformanceFactory,
  options: SandboxConformanceOptions,
): Promise<ReadonlyArray<SandboxConformanceResult>> {
  const results: SandboxConformanceResult[] = [];
  for (const c of sandboxConformanceCases(options)) {
    const subject = await factory();
    try {
      await c.run(subject);
      results.push({ name: c.name, ok: true });
    } catch (err) {
      results.push({
        name: c.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await subject.cleanup?.();
    }
  }
  return results;
}
