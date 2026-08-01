import { describe, test, expect } from "bun:test";

import { createTranslator, type PiEvent } from "../src/translate.ts";

const textDelta = (delta: string): PiEvent =>
  ({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  }) as PiEvent;

const thinkingDelta = (delta: string): PiEvent =>
  ({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
  }) as PiEvent;

const toolcallDelta = (delta: string): PiEvent =>
  ({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta },
  }) as PiEvent;

const messageEnd = (text: string): PiEvent =>
  ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) as PiEvent;

describe("createTranslator — message_update deltas", () => {
  test("default: message_update produces no events (exact current behaviour)", () => {
    const { translate } = createTranslator("r1");
    expect(translate(textDelta("hel"))).toEqual([]);
    expect(translate(thinkingDelta("hmm"))).toEqual([]);
    expect(translate(toolcallDelta('{"a"'))).toEqual([]);
  });

  test("emitDeltas: text_delta -> assistant_delta with the delta text", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    const events = translate(textDelta("hel"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "assistant_delta", runId: "r1", text: "hel" });
  });

  test("emitDeltas: thinking_delta -> thinking_delta event", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    const events = translate(thinkingDelta("let me see"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "thinking_delta", runId: "r1", text: "let me see" });
  });

  test("emitDeltas: toolcall_delta stays dropped", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    expect(translate(toolcallDelta('{"a":1'))).toEqual([]);
  });

  test("emitDeltas: empty delta produces no event", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    expect(translate(textDelta(""))).toEqual([]);
  });

  test("emitDeltas: deltas carry the current turn", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    translate({ type: "turn_start" } as PiEvent);
    const events = translate(textDelta("x"));
    expect(events[0]).toMatchObject({ kind: "assistant_delta", turn: 1 });
  });

  test("emitDeltas: whole-message assistant_text at message_end is unchanged", () => {
    const { translate } = createTranslator("r1", 0, { emitDeltas: true });
    translate(textDelta("hel"));
    translate(textDelta("lo"));
    const events = translate(messageEnd("hello"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "assistant_text", text: "hello" });
  });
});
