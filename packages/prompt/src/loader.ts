import * as fs from "node:fs/promises";

/**
 * Read a prompt template from disk. The convention is a double extension
 * — `system.md.liquid` — where `.liquid` marks the template language and
 * `.md` the output format. A plain `.md` file with no `{% %}`/`{{ }}`
 * tags is a valid template too: it renders verbatim.
 */
export async function loadPromptFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}
