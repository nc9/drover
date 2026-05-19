#!/usr/bin/env bun
/**
 * Smoke test: load every SKILL.md under the given roots (defaults to
 * the user's three canonical skill dirs) using `scanSkillDirs` in
 * lenient mode, and print a report.
 *
 * Run: bun packages/skills/scripts/smoke-load.ts [root...]
 */

import * as path from "node:path";
import * as os from "node:os";

import { scanSkillDirs, listSkillResources, parseAllowedTools, type SkillIssue } from "../src/index.ts";

const DEFAULT_ROOTS = [
  path.join(os.homedir(), "Projects/skills"),
  path.join(os.homedir(), ".claude/skills"),
  path.join(os.homedir(), ".agents/skills"),
];

async function main(): Promise<void> {
  const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS;
  console.log(`Scanning ${roots.length} root(s):`);
  for (const r of roots) console.log(`  ${r}`);
  console.log();

  const issues: Array<{ file: string; list: ReadonlyArray<SkillIssue> }> = [];
  const skills = await scanSkillDirs(roots, {
    mode: "lenient",
    onIssue: (file, list) => issues.push({ file, list }),
  });

  let withScripts = 0;
  let withRefs = 0;
  let withAssets = 0;
  let withLicense = 0;
  let withCompat = 0;
  let withMeta = 0;
  let withAllowedTools = 0;
  const toolUsage = new Map<string, number>();

  for (const s of skills) {
    const r = await listSkillResources(s);
    if (r.scripts.length > 0) withScripts++;
    if (r.references.length > 0) withRefs++;
    if (r.assets.length > 0) withAssets++;
    if (s.license) withLicense++;
    if (s.compatibility) withCompat++;
    if (Object.keys(s.metadata).length > 0) withMeta++;
    if (s.allowedTools) {
      withAllowedTools++;
      for (const t of parseAllowedTools(s.allowedTools)) {
        toolUsage.set(t, (toolUsage.get(t) ?? 0) + 1);
      }
    }
  }

  console.log(`Loaded ${skills.length} skill(s).`);
  console.log();
  console.log("Spec field coverage:");
  console.log(`  license:        ${pct(withLicense, skills.length)}`);
  console.log(`  compatibility:  ${pct(withCompat, skills.length)}`);
  console.log(`  metadata:       ${pct(withMeta, skills.length)}`);
  console.log(`  allowed-tools:  ${pct(withAllowedTools, skills.length)}`);
  console.log();
  console.log("Resources:");
  console.log(`  scripts/:       ${pct(withScripts, skills.length)}`);
  console.log(`  references/:    ${pct(withRefs, skills.length)}`);
  console.log(`  assets/:        ${pct(withAssets, skills.length)}`);

  if (toolUsage.size > 0) {
    console.log();
    console.log("Top allowed-tools tokens:");
    const sorted = [...toolUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [tok, n] of sorted) console.log(`  ${n.toString().padStart(3)}  ${tok}`);
  }

  if (issues.length > 0) {
    console.log();
    console.log(`Warnings: ${issues.length} skill(s) had spec violations`);
    for (const { file, list } of issues) {
      console.log(`  ${file}`);
      for (const i of list) console.log(`    ${i.field}: ${i.message}`);
    }
  } else {
    console.log();
    console.log("No spec violations.");
  }

  process.exit(0);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0 (0%)";
  return `${n} (${Math.round((n / total) * 100)}%)`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
