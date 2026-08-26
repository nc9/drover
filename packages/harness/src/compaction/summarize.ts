/**
 * `summarize` strategy — an LLM sub-call condenses the compactable head into a
 * single synthetic user message, inserted before the verbatim tail.
 *
 * The summariser is injected as a {@link SummarizeFn} so the orchestrator and
 * its tests stay decoupled from pi; {@link makeSummarizer} builds the
 * pi-backed implementation the harness wires in.
 *
 * The head is rendered to plain text and sent as ONE user message (not as a
 * structured transcript) on purpose: it sidesteps provider role-ordering rules
 * and any dangling `toolCall`/`toolResult` pairing the slice might contain, and
 * keeps the call portable across every provider drover targets. The call is
 * made with NO tools and reasoning OFF — a tool-equipped model otherwise tends
 * to call a tool instead of writing the summary.
 */
import { COMPACTION_SUMMARY_MARKER } from "@droveragent/core";
import { completeSimple } from "@mariozechner/pi-ai";
import type { KnownApi, Message, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

/** Produce summary text for the head messages. Injected into the orchestrator. */
export type SummarizeFn = (
  head: ReadonlyArray<Message>,
  summaryPrompt: string,
  signal?: AbortSignal,
) => Promise<string>;

/** Default output cap for a summary call — summaries should be terse. */
const SUMMARY_MAX_TOKENS = 4096;

const SUMMARY_SYSTEM_PROMPT =
  "You are a summarization assistant. You condense a conversation transcript into a compact handoff note. Follow the user's instructions exactly. Respond with text only.";

function blockText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/** Flatten a slice of the transcript to plain text for the summariser. */
export function renderTranscript(head: ReadonlyArray<Message>): string {
  const lines: string[] = [];
  for (const m of head) {
    if (m.role === "user") {
      lines.push(`User: ${typeof m.content === "string" ? m.content : blockText(m.content)}`);
    } else if (m.role === "assistant") {
      const text = blockText(m.content);
      if (text) lines.push(`Assistant: ${text}`);
      for (const c of m.content) {
        if (c.type === "toolCall")
          lines.push(`Assistant called ${c.name}(${JSON.stringify(c.arguments)})`);
      }
    } else {
      lines.push(`Tool result (${m.toolName}): ${blockText(m.content)}`);
    }
  }
  return lines.join("\n");
}

/** Synthetic user message carrying the summary, marked so the drop point is detectable. */
export function buildSummaryMessage(summaryText: string, now: number): Message {
  const body = summaryText.trim().length > 0 ? summaryText.trim() : "(no summary available)";
  return { role: "user", content: `${COMPACTION_SUMMARY_MARKER} ${body}`, timestamp: now };
}

/**
 * Build the pi-backed summariser bound to a model + key.
 *
 * `onPayload` is the host's provider request-body seam (`HarnessDeps.onPayload`)
 * forwarded verbatim, so a summary call routes exactly like the run's other
 * model calls — a host that pins an OpenRouter provider order for the loop would
 * otherwise silently lose it here.
 */
export function makeSummarizer(
  model: Model<KnownApi>,
  apiKey: string,
  maxTokens?: number,
  onPayload?: SimpleStreamOptions["onPayload"],
): SummarizeFn {
  return async (head, summaryPrompt, signal) => {
    const transcript = renderTranscript(head);
    const userContent = `${transcript}\n\n---\n\n${summaryPrompt}`;
    const reply = await completeSimple(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
      },
      {
        apiKey,
        maxTokens: maxTokens ?? SUMMARY_MAX_TOKENS,
        ...(signal ? { signal } : {}),
        ...(onPayload ? { onPayload } : {}),
      },
    );
    return blockText(reply.content);
  };
}

/**
 * Apply the summarize strategy: replace `[headStart, headEnd)` with one summary
 * message. Throws if the summariser throws — the orchestrator catches it.
 */
export async function summarizeStrategy(
  messages: ReadonlyArray<Message>,
  headStart: number,
  headEnd: number,
  summarize: SummarizeFn,
  summaryPrompt: string,
  now: number,
  signal?: AbortSignal,
): Promise<Message[]> {
  const head = messages.slice(headStart, headEnd);
  const text = await summarize(head, summaryPrompt, signal);
  const summaryMsg = buildSummaryMessage(text, now);
  return [...messages.slice(0, headStart), summaryMsg, ...messages.slice(headEnd)];
}
