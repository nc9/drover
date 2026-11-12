import { Type } from "@sinclair/typebox";
import { defineAgent, runAgent } from "../src/index.ts";

const echo = defineAgent({
  id: "echo",
  systemPrompt: "Reply with a JSON object matching the outputSchema. No prose.",
  inputSchema: Type.Object({ word: Type.String() }),
  outputSchema: Type.Object({ upper: Type.String(), length: Type.Integer() }),
  model: "cheap",
  tools: [],
  quota: { maxTurns: 2 },
});

const handle = runAgent(echo, { word: "drover" });

for await (const event of handle.events) {
  if (event.kind === "assistant_text") console.log(event.text);
}

const result = await handle.result;
console.log(result.status, result.output, result.usage);
