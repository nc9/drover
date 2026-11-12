/**
 * The system prompt as a transcript message.
 *
 * pi 1.x ignores `AgentContext.systemPrompt`: the prompt (and the tool
 * declarations) reach the model only as a leading `role: "system"` message in
 * the transcript. These helpers build that message from the rendered prompt and
 * keep exactly one at the head of any history the harness hands to pi.
 *
 * Checkpoints never store it: it is derived from the spec on every
 * invocation, so a resume or continue always sends the CURRENT rendered prompt,
 * and a checkpoint written before the migration (no system message) resumes the
 * same way as a new one.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai/compat";
import type { SystemMessage, Tool } from "@earendil-works/pi-ai/compat";

/**
 * The leading system message for a rendered prompt and the executable tools. Tool
 * declarations go through `toToolDeclaration`, the same shape pi's loop compares
 * against, so pi sees no tool delta and adds no second system message. Undefined when
 * both are empty.
 */
export function buildSystemMessage(
  systemPrompt: string,
  tools: ReadonlyArray<Tool>,
): SystemMessage | undefined {
  return createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
}

/** Drop the system message(s) at the head of a history. Later ones are left alone. */
export function stripLeadingSystem<T extends { role?: string }>(messages: ReadonlyArray<T>): T[] {
  let i = 0;
  while (i < messages.length && messages[i]!.role === "system") i += 1;
  return messages.slice(i) as T[];
}

/**
 * `messages` with exactly one leading system message: any existing leading one is
 * replaced by `system` (so a changed prompt wins and nothing doubles up).
 */
export function withSystemMessage(
  system: SystemMessage | undefined,
  messages: ReadonlyArray<AgentMessage>,
): AgentMessage[] {
  const rest = stripLeadingSystem(messages);
  return system ? [system as AgentMessage, ...rest] : rest;
}
