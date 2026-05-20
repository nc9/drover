/**
 * Smoke test: render a sample template with builtins and print the
 * cache report. Run with `bun run scripts/smoke-render.ts`.
 */
import { createPromptEngine } from "../src/index.ts";

const engine = createPromptEngine();

const template = `You are {% agent field: "name" %}, working in {% cwd %}.

{% instructions %}

Follow the guidance above. Keep responses concise and grounded in the
project's conventions. This block is static and should stay cacheable.

Today is {% date %}.
`;

const r = await engine.render(
  template,
  {
    agent: { id: "demo", name: "Demo Agent" },
    run: { runId: "run-demo", cwd: "/work/demo" },
    instructions: [
      {
        path: "/work/demo/AGENTS.md",
        dir: "/work/demo",
        relativeDir: "",
        filename: "AGENTS.md",
        content: "Prefer functional style. Write terse commit messages.",
        truncated: false,
      },
    ],
  },
  { autoReorder: true },
);

console.log("=== rendered ===");
console.log(r.text);
console.log("=== cache report ===");
console.log(JSON.stringify(r.cache, null, 2));
