import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readme = read("README.md");

const between = (text: string, name: string) => {
  const m = text.match(new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!m?.[1]) throw new Error(`missing ${name} markers`);
  return m[1];
};

describe("README", () => {
  test("quickstart block matches the typechecked example file", () => {
    const block = between(readme, "quickstart").match(/```ts\n([\s\S]*?)```/)?.[1];
    // The example imports the umbrella from source; the README imports the published name.
    const example = read("packages/droveragent/examples/quickstart.ts").replace(
      '"../src/index.ts"',
      '"@droveragent/all"',
    );
    expect(block).toBe(example);
  });

  test("package table lists exactly the packages in packages/*/package.json", () => {
    const listed = [...between(readme, "packages").matchAll(/^\| `([^`]+)`\s+\|/gm)].map(
      (m) => m[1],
    );
    const actual = readdirSync(join(root, "packages"))
      .filter((d) => existsSync(join(root, "packages", d, "package.json")))
      .map((d) => JSON.parse(read(`packages/${d}/package.json`)).name as string);
    expect(listed.toSorted()).toEqual(actual.toSorted());
  });

  test("relative links resolve", () => {
    const links = [...readme.matchAll(/\]\(((?!https?:|#)[^)]+)\)/g)].map((m) => m[1] as string);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(join(root, l))).toBe(true);
  });
});

describe("licence metadata", () => {
  const dirs = readdirSync(join(root, "packages")).filter((d) =>
    existsSync(join(root, "packages", d, "package.json")),
  );

  test("LICENSE text", () => {
    const text = read("LICENSE");
    expect(text).toContain("MIT License");
    expect(text).toContain("Copyright (c) 2026 Nik Cubrilovic");
  });

  test("every package declares MIT, repository, homepage, bugs and ships LICENSE", () => {
    for (const d of dirs) {
      const j = JSON.parse(read(`packages/${d}/package.json`));
      expect(j.license).toBe("MIT");
      // npm provenance (scripts/release.ts verify) needs exactly this url
      expect(j.repository.url).toBe("git+https://github.com/nc9/drover.git");
      expect(j.repository.directory).toBe(`packages/${d}`);
      expect(j.homepage).toBeTruthy();
      expect(j.bugs.url).toBeTruthy();
      expect(j.files).toContain("LICENSE");
      expect(read(`packages/${d}/LICENSE`)).toBe(read("LICENSE"));
    }
  });
});

describe("templates", () => {
  test("feature template has an Acceptance Criteria checklist", () => {
    expect(read(".github/ISSUE_TEMPLATE/feature_request.md")).toMatch(
      /## Acceptance Criteria\n\n- \[ \]/,
    );
  });
});

describe("docs", () => {
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === "node_modules" || e.name === "dist"
          ? []
          : walk(`${dir}/${e.name}`)
        : /\.(mdx?|json)$/.test(e.name)
          ? [`${dir}/${e.name}`]
          : [],
    );

  test("no stale @drover/* package names (the npm scope is @droveragent)", () => {
    const stale = [...walk("docs"), "README.md", "CONTRIBUTING.md"].filter((f) =>
      read(f).includes("@drover/"),
    );
    expect(stale).toEqual([]);
  });
});
