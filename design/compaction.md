# Drover Compaction Primitives — Design

Status: **proposal** (unbuilt). Audience: drover maintainers.
Scope: conversation-history compaction — auto + manual — as composable library primitives.

## 0. Design philosophy (locked)

Drover is a **library of primitives**, not an opinionated agent. Compaction follows the
same rule as the rest of the harness (cf. "no first-class advisor/grader/classifier
patterns — recipes, not core"):

- **No hidden defaults for behavioural options.** The caller declares the strategy, the
  trigger, and what to preserve, explicitly. Omitting an optional guard means *the guard is
  off* — never a silent non-zero value chosen for you.
- **Presence = active.** `spec.compaction` absent ⇒ today's behaviour (no compaction).
  Present ⇒ exactly what you configured.
- **Docs do the teaching.** Recommended values, the strategy ladder, model-specific tuning
  — demonstrated in guides/howto, not baked into code as defaults.

This drives two decisions already taken (see §8): the surface is a **core spec field, not a
plugin**, and the policy type makes the behavioural knobs **required**.

## 1. Summary

We add conversation-history compaction to drover — its first. The single load-bearing
decision: **all compaction runs inside `transformContext`**, pi-agent-core's one documented,
before-every-LLM-call seam (`packages/harness/src/run.ts:693`). That seam is already
half-occupied by checkpoint snapshotting, so compaction **composes with** snapshotting
(snapshot the *compacted* messages) and must be wired even when storage is absent (today it
is `undefined` without storage).

Two surfaces over one engine: an **auto** path (a `spec.compaction?` policy with an explicit
trigger) and a **manual** path (a `compactFlag` honoured by the next `transformContext`,
exposed as `handle.compact()`), mirroring the existing `pauseFlag` pattern exactly.

We reconcile with three contracts **already stubbed** in the tree: the `HarnessEvent`
`kind:"compaction"` payload (`events.ts:67`), the `beforeCompaction` plugin hook
(`plugin.ts:93`), and `HistoryMessage` (`plugin.ts:50`) — already rendered by
`step-tracer.ts:98`. The design conforms to those rather than inventing new ones.

## 2. Prior art (source-verified)

Findings below were extracted from each project's source and adversarially re-checked
against the cited files; codex/opencode verdict **accurate**, broader-SOTA **mostly-accurate**
(corrections were citation-precision, no fabricated mechanisms).

| System | Auto trigger | Preserves verbatim | Summary representation | Manual path | Token accounting |
|---|---|---|---|---|---|
| **codex** (Rust) | `tokens ≥ 90% × ctx` (`(window*9)/10`); + model-downshift | recent **user** msgs ≤20k tok (local) / 64k (remote-v2); base instructions re-supplied fresh | trailing `user` msg `"{PREFIX}\n{body}"`; empty ⇒ `(no summary available)` | `Op::Compact` standalone task; routes through the same override-aware `compact_prompt()` | server `last_token_usage.total` + delta heuristic |
| **opencode** (TS) | `count ≥ ctx − max(32k,output)` (32k overridable via env) | last `tail_turns` (def 2), clamp 2k–8k; prior summary anchored | assistant msg `summary:true`, **non-destructive** (`filterCompacted` reorders live) | `POST /summarize` → `create({auto:false})`; model from request payload | provider usage for trigger; `len/4` for head/tail selection |
| **Anthropic native** | server compaction default `input_tokens ≥ 150k`; clearing default 100k | system prompt; everything *after* the `compaction` block | typed `{type:"compaction",content:"<summary>…"}` block | per-request `context_management.edits`; `pause_after_compaction` ⇒ `stop_reason:"compaction"` | API usage echo; `count_tokens` dry-run (clearing only) |
| **Claude Code** | 3-tier: microcompact each turn above warn; full ≈89% (`ctx − min(maxOut,20k) − 13k`) | system prompt; ~5 hot-tail tool results; files ≤50k; CLAUDE.md re-injected | 9-section template behind a boundary marker | `/compact [free-text]`; `/clear` distinct | real tokenizer projecting next request size |
| **Cline** | `autoCondenseThreshold` 0–1 of window | first user/assistant exchange; even-count middle eviction | truncation (no LLM) or summary tool-call | manual condense | window fraction |
| **Anthropic clearing** | `input_tokens` OR `tool_uses` count | last `keep` tool results (def 3); matching `tool_use` kept | placeholder `"[cleared to save context]"`, `tool_use` survives | edits array, ordered | `clear_at_least` min-savings gate |

**Lessons we adopt:**

- **Separate, ordered mechanisms (cheap → expensive).** Expose a `strategy` *enum array*
  (`drop-tool-results` | `summarize` | `sliding-window`) applied in order until enough is
  reclaimed — not one monolithic "compact". Anthropic's cookbook orders `[clear, compact]`;
  Claude Code tiers microcompact → full.
- **Tool-result clearing is the lightest touch.** Replace old `tool_result` *content* with a
  placeholder, keep the `tool_use` record so the causal trace survives — zero inference cost.
  Note this is the *history* analogue of drover's existing `truncatePlugin` (which caps
  *incoming* tool-result bytes); they are complementary, not the same mechanism.
- **Preserve a verbatim recent tail + the opening turn; never summarize the latest turn.**
  Summaries lose file paths, line numbers, error strings — both codex (≤20k user budget) and
  opencode (`tail_turns`) keep recent reality verbatim.
- **The summarizer sub-call must be tools-off, text-only.** Documented Anthropic failure: a
  tool-equipped model calls a tool instead of writing the summary. opencode/Roo deliberately
  reuse the active model with tools suppressed.
- **Cache-awareness is first-class.** Rewriting the prefix busts the prompt cache. Gate on a
  minimum-savings threshold (Anthropic `clear_at_least`; codex trims from the *beginning* to
  preserve the prefix) and keep a stable suffix.
- **Empty-summary guard.** codex substitutes `(no summary available)` when the summarizer
  returns empty (`compact.rs:524`); we do the same rather than insert an empty message.

**We reject:**

- **codex's remote `responses/compact` endpoint** — drover is provider-agnostic over
  openrouter/pi-ai; there is no drover server or encrypted-transcript contract. Summarization
  is the local LLM-sub-call path only. (This mirrors Anthropic's *client-side SDK* compaction,
  which is what a library like drover is positioned to do, rather than server-side compaction.)
- **opencode's non-destructive `filterCompacted` dual-projection.** Drover's seam hands pi a
  flat `AgentMessage[]` that `convertToLlm` passes through 1:1 (`run.ts:702`); we do not own a
  parallel storage projection with `tail_start_id` markers. Drover compacts the array
  **destructively in-flight** and relies on per-turn checkpoints for reversibility (§4.4). We
  borrow opencode's *anchored-summary* idea without its machinery.

## 3. The drover model

### 3.1 Surface — a core spec field `spec.compaction?` (decided: core field only)

Compaction is a new optional `AgentSpec` field wired into `transformContext`. Rationale:

1. **Single seam.** Only `transformContext` (a pi `AgentLoopConfig` field) can rewrite the
   message list. Plugins have no message-rewrite hook (the `beforeCompaction` stub is an
   *advisory* `HistoryMessage[]` view, never wired). A plugin surface would create a second
   rewrite authority competing with snapshotting for the one seam.
2. **Resume-safety needs hashing.** `hashSpec()` already folds `quota`/`memory`/`lifecycle`. A
   core field drops into that hash (§4.5) so a resume under a drifted policy fails the check;
   a plugin would contribute only its `id`, hiding policy drift.
3. **No stateful-leak.** Compaction is stateful (a `summarizedThrough` cursor, last-fired
   turn). Per drover's rule, stateful plugins must be built per-run via `options.plugins`
   because spec plugins are not reconstructed. A pure-data `spec.compaction?` + harness-owned
   per-run state sidesteps that entirely.

The existing `beforeCompaction` **plugin** hook is kept as the *advisory* slot — plugins may
pre-shrink the head (strip large tool outputs) before the summarizer runs. That is the
composability surface; the engine stays core. No `compactionPlugin()` factory ships (a plugin
was explicitly not chosen as the surface).

### 3.2 The policy type (no hidden defaults)

```ts
// packages/core/src/agent-spec.ts (new)

export type CompactionStrategy =
  /** Replace old tool_result content with a placeholder; keep the tool_use record. No LLM. */
  | "drop-tool-results"
  /** LLM sub-call summarizes the head; head replaced by one summary message. */
  | "summarize"
  /** Mechanical: keep first turn + recent tail, delete the middle. No LLM. */
  | "sliding-window";

/** Auto-trigger form. Omit `trigger` on the policy for manual-only compaction. */
export type CompactionTrigger =
  | { kind: "context_fraction"; value: number }   // e.g. 0.8 of model.contextWindow
  | { kind: "input_tokens"; value: number };      // absolute input-token ceiling

/** What survives a compaction verbatim, regardless of strategy. Caller declares it. */
export interface CompactionPreserve {
  /** Keep the opening user turn (the original task). */
  firstUserTurn: boolean;
  /** Keep the most-recent N turns verbatim (turn = user msg + its assistant/tool tail). */
  recentTurns: number;
  /** Tool ids whose results are never compacted (e.g. ["remember","recall"]). Omit ⇒ none. */
  pinTools?: readonly string[];
}

export interface CompactionPolicy {
  /** Strategy ladder, applied in order until the trigger clears. Required, ≥1 entry. */
  strategy: readonly CompactionStrategy[];
  /** Verbatim-preservation rules. Required — declare what is kept; no surprise loss. */
  preserve: CompactionPreserve;
  /** Auto-trigger. Omit ⇒ manual-only (handle.compact()). */
  trigger?: CompactionTrigger;
  /** Min tokens a pass must reclaim or it is skipped (cache-bust guard). Omit ⇒ no gate. */
  minReclaimTokens?: number;
  /** Don't auto-fire within this many turns of the last compaction. Omit ⇒ no cooldown. */
  cooldownTurns?: number;
  /**
   * Summary prompt for the "summarize" strategy. REQUIRED when strategy includes
   * "summarize" — the harness fails the run with CompactionConfigError if absent.
   * Import DEFAULT_COMPACTION_SUMMARY_PROMPT to use drover's shipped text explicitly.
   */
  summaryPrompt?: string;
  /** Model for the summarize sub-call. Omit ⇒ reuse the run's resolved model. ModelSpec form. */
  summaryModel?: ModelSpec;
}
```

`spec.compaction?: CompactionPolicy` is the new optional field. No `enabled` flag — presence
is the switch. Note: `summaryPrompt` is *conditionally* required (only with `"summarize"`),
enforced at run start with a clear error rather than a silent fallback; drover ships the
default text as an **importable constant**, not a hidden default.

### 3.3 Trigger and preservation semantics

- **Trigger.** `context_fraction` computes `usable = floor(resolved.model.contextWindow *
  value)` (the `contextWindow`/`maxTokens` fields are confirmed present on pi's `Model` type)
  and fires when `estimatedInputTokens >= usable`. `input_tokens` is an absolute ceiling.
  Guides recommend values per model class (e.g. ~0.8 leaves summarizer-output headroom on
  131k models); the library imposes none.
- **Preserve.** The **system prompt** is never in `AgentMessage[]` (pi sends it separately) —
  compaction physically cannot touch it. From the array: the **first user turn**, the **last
  `recentTurns` turns verbatim**, and any `pinTools` results. The **head** = everything between
  first turn and recent tail; only the head is compacted. The head boundary is snapped to a
  turn (assistant-message) boundary so a `tool_use` is never orphaned from its `tool_result`.

### 3.4 The summarize sub-call

Reuses `resolved.model` + `resolved.apiKey` (or `summaryModel`), as a one-shot pi call **with
no tools and `reasoning` forced off** (dodging the documented tool-call-instead-of-summary
failure). Feeds the head messages + a trailing user instruction (`summaryPrompt`). The
returned text becomes a single synthetic `user`-role `AgentMessage` inserted at the head's
position, prefixed with a machine-detectable boundary marker:

```
[compacted] <summary text>
```

Resulting array: `[firstUserTurn, summaryMessage, ...recentTurns]` — summary *before* the
verbatim tail (the tail stays last so the model acts on the freshest reality). Empty summary ⇒
`[compacted] (no summary available)` (codex's guard). A prior summary in the head is **anchored**
(fed back) rather than summarized-of-summary.

Drover ships the default prompt as `DEFAULT_COMPACTION_SUMMARY_PROMPT`
(`packages/harness/src/compaction/prompt.ts`), exported for explicit use:

```
You are compacting the conversation above to free context while preserving
everything needed to continue the task. Write a single handoff summary for the
same assistant, which will lose access to the raw history above and see only
this summary plus the most recent turns.

Capture, in terse structured bullets:
- GOAL: the original task and any hard constraints or user preferences.
- PROGRESS: what is done, in progress, and blocked.
- DECISIONS: key technical choices and why.
- STATE: exact file paths, identifiers, commands, and error strings still in play
  — reproduce them verbatim, do not paraphrase.
- NEXT: the concrete next steps.

Do not call any tools. Respond with text only. Do not mention that you are
summarizing or that context was compacted.
```

### 3.5 Manual path

Mirror the `pauseFlag` pattern exactly. The harness holds a mutable `compactFlag` the facade
flips; the **next** `transformContext` honours it (ignoring the trigger), then clears it.

- **Harness internal:** `runAgentEffect` args gain `compactFlag?: { requested: boolean;
  instructions?: string }` (parallel to `pauseFlag`, `run.ts:222`). On entry to
  `transformContext`: if `compactFlag.requested`, run one pass (using `instructions` to
  override `summaryPrompt` for that pass), clear the flag, then fall through to the trigger
  check.
- **Facade surface** (`RunHandle`, `facade/src/index.ts`):

```ts
export interface RunHandle<S extends AgentSpec> {
  // ...existing runId, events, result, abort, pause...
  /**
   * Request a compaction before the next LLM call. Honoured by the next
   * transformContext even when spec.compaction.trigger is unset. No-op when
   * spec.compaction is absent.
   * @param instructions optional one-shot summary-prompt override.
   */
  compact: (instructions?: string) => void;
}
```

Unlike `pause()`, `compact()` does **not** require storage — it rewrites the in-flight array;
the snapshot just rides along if storage exists. Pure no-op when `spec.compaction` is absent.

### 3.6 The `compaction` event (extend the existing stub)

The `compaction` event already exists (`events.ts:67`) and is consumed by `step-tracer.ts:102`.
Keep that contract; extend the payload additively (the tracer reads only the existing fields):

```ts
| {
    kind: "compaction";
    runId: string;
    turn: number;                       // ADD: turn at which it fired
    trigger: "auto" | "manual";         // ADD
    strategy: CompactionStrategy;       // ADD: which ladder rung applied
    beforeTokens: number;               // existing
    afterTokens: number;                // existing
    collapsedRange: [number, number];   // existing: [startIdx, endIdx) of head replaced
    summarized: boolean;                // ADD: true only for "summarize"
    ts: number;
  }
```

One event per *applied* pass. A skipped pass (below `minReclaimTokens`) emits nothing. A failed
summarizer sub-call emits `{ kind: "error", tag: "CompactionError", … }` (observation only; the
run continues uncompacted — §5).

## 4. Integration — wiring in `packages/harness/src/run.ts`

### 4.1 Compose with the existing snapshot transformContext (don't replace)

Today (`run.ts:693`) `transformContext` exists only when `storage` is truthy and only
snapshots. New shape — compaction runs **first**, snapshot captures the **post-compaction** array:

```ts
const wantsCompaction = spec.compaction !== undefined;
const wantsSnapshot = !!storage;

const transformContext =
  wantsCompaction || wantsSnapshot
    ? async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        let next = messages;
        if (wantsCompaction) {
          next = await maybeCompact({          // never throws — returns input on any failure
            messages,
            policy: spec.compaction!,
            resolved,
            ctx,
            signal,
            estimateInputTokens: () => lastUsage.value.inputTokens || estimateTokens(messages),
            compactFlag,                        // manual trigger
            compactionState,                    // per-run cursor (cooldown, summarizedThrough)
            emit: safeEmit,
          });
        }
        if (wantsSnapshot) messagesSnapshot.value = [...next]; // snapshot the COMPACTED form
        return next;
      }
    : undefined;
```

Key: compaction **precedes** snapshot (checkpoint persists the compacted array — §4.4), and
`transformContext` is now wired **when storage is absent** if compaction is on (fixing the
current gap).

### 4.2 Token-estimation source

Prefer **live usage** (`lastUsage.value.inputTokens`, accumulated each `message_end`,
`run.ts:549`) — the authoritative provider count for the previous request, as codex/opencode
do. First call (no usage yet) or stale ⇒ fall back to a `len/4` char heuristic over the
serialized `AgentMessage[]` (opencode's `CHARS_PER_TOKEN=4`), or pi's `estimateTokens` if
exported. New helper `packages/harness/src/compaction/estimate.ts`. Compare against
`floor(resolved.model.contextWindow * fraction)`.

### 4.3 Must-not-throw contract

`transformContext`'s pi contract: **must not throw/reject** — return original messages on
failure. `maybeCompact` wraps every internal step (summarizer call, plugin `beforeCompaction`,
estimate) in `Effect.either`/try-catch; on any failure it emits `CompactionError` and returns
the **original** `messages`. The abort `signal` is honoured — a cancelled run skips compaction.

### 4.4 Resume — checkpoint stores compacted (post) history

`persistCheckpoint` (`run.ts:508`) saves `messagesSnapshot.value`. Because compaction runs
before snapshot (§4.1), the checkpoint captures the **compacted** array. Resume
(`runAgentLoopContinue`, seeded from `resumeFrom.messages`) replays from compacted history —
O(suffix) resume, no re-summarization (codex's `replacement_history` property).

Reversibility: compaction is destructive in the live array, but each checkpoint `seq` is a
turn, so the pre-compaction state is recoverable from an earlier checkpoint —
opencode-grade reversibility without the dual-projection. `collapsedRange` records the dropped
span for observability.

### 4.5 hashSpec() addition

Add to the hashed object (`run.ts:1200`): `compaction: spec.compaction ?? null`. Matches
`quota`/`memory`/`lifecycle` already there: policy changes how a run replays, so a resume
under a drifted policy must fail the hash check. `CompactionPolicy` is pure JSON ⇒
`JSON.stringify` captures it fully.

### 4.6 Prompt-cache implications

Compaction rewrites the head of `AgentMessage[]` ⇒ busts the cached prefix from the first
changed message forward. Mitigations are caller-controlled (no hidden defaults):

- **Fire rarely:** `cooldownTurns` + `minReclaimTokens` (both opt-in) prevent thrash; a pass
  that can't reclaim the minimum is skipped.
- **Stable suffix:** the verbatim recent tail is appended unchanged and last, so post-compaction
  turns re-warm a new prefix that then stays stable until the next compaction.
- **System prompt unaffected:** sent separately by pi, so its cache breakpoint is never
  invalidated by compaction.
- `drop-tool-results` still busts the prefix (edits in place); `minReclaimTokens` is the
  `clear_at_least` equivalent making the bust worth it.

## 5. Edge cases & failure modes

- **Summarizer fails / times out / empty.** Catch, emit `CompactionError`, return original
  messages. Empty-summary ⇒ `[compacted] (no summary available)` rather than an empty message.
- **Compaction during a tool batch.** `transformContext` fires between turns, not mid-batch.
  The most-recent turn is never dropped (recent-tail preservation), so a dangling
  `tool_use`/`tool_result` pair is always kept together; the head boundary snaps to a turn
  boundary so no `tool_use` is orphaned.
- **Double-compaction.** Guarded by `cooldownTurns` (auto) and `compactionState.summarizedThrough`
  (don't re-summarize an already-summarized head). Manual-then-auto: manual runs once, clears
  the flag; auto won't re-fire within cooldown. A prior summary in the head is anchored, not
  re-summarized.
- **Compaction + output-retry.** The schema-correction user turn (`getFollowUpMessages`,
  `run.ts:580`) is in the recent tail ⇒ preserved verbatim; `retriesUsed` is independent state.
- **Compaction + subagents.** Subagents are separate runs (own `RunContext`, depth+1), each with
  its own `spec.compaction` or none. The parent's `task`-tool result is a normal tool result
  subject to the parent's policy. No cross-run coupling.
- **Tiny context windows.** If `usable < firstUserTurn + recentTurns` cost, the head is empty ⇒
  no-op. If even the tail overflows, compaction can't help; log and proceed (provider rejects —
  same as today).
- **Summary itself overflows.** If the head exceeds the summarizer model's `contextWindow`, trim
  the head from the oldest (codex's `remove_first_item`, preserves recency) until it fits. If
  still impossible, fall down the ladder to `sliding-window` (mechanical) for that pass.
- **Strategy-ladder exhaustion.** Apply rungs in order, re-estimate after each; stop when under
  budget or the ladder is exhausted. Still over after all rungs ⇒ return best effort.

## 6. API sketches

**TypeBox schema** (`packages/core/src/agent-spec.ts` — TypeBox everywhere per locked decision):

```ts
import { Type, type Static } from "@sinclair/typebox";

export const CompactionStrategySchema = Type.Union([
  Type.Literal("drop-tool-results"),
  Type.Literal("summarize"),
  Type.Literal("sliding-window"),
]);

export const CompactionTriggerSchema = Type.Union([
  Type.Object({ kind: Type.Literal("context_fraction"), value: Type.Number({ minimum: 0.1, maximum: 0.99 }) }),
  Type.Object({ kind: Type.Literal("input_tokens"), value: Type.Integer({ minimum: 1 }) }),
]);

export const CompactionPolicySchema = Type.Object({
  strategy: Type.Array(CompactionStrategySchema, { minItems: 1 }),   // required
  preserve: Type.Object({                                            // required
    firstUserTurn: Type.Boolean(),
    recentTurns: Type.Integer({ minimum: 0 }),
    pinTools: Type.Optional(Type.Array(Type.String())),
  }),
  trigger: Type.Optional(CompactionTriggerSchema),
  minReclaimTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cooldownTurns: Type.Optional(Type.Integer({ minimum: 0 })),
  summaryPrompt: Type.Optional(Type.String()),
  summaryModel: Type.Optional(ModelSpecSchema), // existing ModelSpec schema
});
export type CompactionPolicy = Static<typeof CompactionPolicySchema>;
```

**`defineAgent` with auto compaction (everything explicit):**

```ts
import { defineAgent, DEFAULT_COMPACTION_SUMMARY_PROMPT } from "@droveragent/core";
import { Type } from "@sinclair/typebox";

export const researcher = defineAgent({
  id: "researcher",
  systemPrompt: "Research the question thoroughly using your tools.",
  inputSchema: Type.Object({ question: Type.String() }),
  outputSchema: Type.Object({ answer: Type.String() }),
  model: "sonnet",
  tools: ["bash", "show_tool_result"],
  compaction: {
    strategy: ["drop-tool-results", "summarize"],
    trigger: { kind: "context_fraction", value: 0.8 },
    preserve: { firstUserTurn: true, recentTurns: 3, pinTools: ["remember", "recall"] },
    minReclaimTokens: 4096,
    cooldownTurns: 2,
    summaryPrompt: DEFAULT_COMPACTION_SUMMARY_PROMPT, // explicit; or your own text
  },
});
```

**Manual-only compaction (no trigger):**

```ts
export const stepwise = defineAgent({
  // ...
  compaction: {
    strategy: ["drop-tool-results"],
    preserve: { firstUserTurn: true, recentTurns: 5 },
    // no trigger ⇒ only handle.compact() fires it
  },
});

const handle = runAgent(stepwise, { question: "…" }, { storage });
handle.compact("Focus the summary on the failing test and the stack trace.");
const result = await handle.result;
```

Internal engine (pure, exported from `@droveragent/harness/compaction`):
`maybeCompact(args): Promise<AgentMessage[]>`, `summarizeHead(...): Effect<...>`,
`dropToolResults(messages, preserve): AgentMessage[]`, `slidingWindow(messages, preserve):
AgentMessage[]`, `selectHeadTail(messages, preserve): { head, tail, firstTurn }`. Effect
internally, Promise at the `transformContext` boundary — matches drover's
Effect-internals + Promise-facade rule.

## 7. Phased build plan

**P1 — Manual + `drop-tool-results` + `sliding-window` (no LLM).** Independently shippable,
zero model cost, lowest risk.
- `packages/core`: `CompactionPolicy`/`CompactionStrategy`/schema; `spec.compaction?` field;
  extend `compaction` event (additive); export.
- `packages/harness`: `compaction/` module — `selectHeadTail`, `dropToolResults`,
  `slidingWindow`, `estimate`; `transformContext` composition (§4.1) incl. **storage-absent**
  wiring; `compactFlag` arg + honour; `hashSpec` line; `maybeCompact` (no-summarize rungs);
  `CompactionConfigError` if `"summarize"` configured (deferred to P2).
- `packages/facade`: `compactFlag` plumbing + `handle.compact()` on `RunHandle`.
- Validates the seam, must-not-throw, manual trigger, event/checkpoint composition — no LLM dep.

**P2 — `summarize` strategy.**
- `packages/harness`: `summarizeHead` (one-shot pi call reusing `resolved.model`+`apiKey`, no
  tools, reasoning off, anchored prior summary), `prompt.ts` (`DEFAULT_COMPACTION_SUMMARY_PROMPT`),
  `summaryModel` resolution, head-trim-on-overflow, ladder re-estimation; auto-trigger on
  `context_fraction`/`input_tokens` with `cooldownTurns`/`minReclaimTokens`; enforce
  `summaryPrompt` required-when-summarize.
- Wire the existing `beforeCompaction` plugin hook (`plugin.ts:93`) as the pre-summarize
  head-shrink pass.

**P3 — Advanced.**
- Anchored incremental summaries, `pinTools` hardening, lifecycle `{ kind: "compact" }` step,
  hard-provider-overflow retry (catch context-overflow rejection ⇒ force compaction ⇒ replay
  last user turn, opencode-style).
- `packages/eval`: a compaction regression harness (long synthetic transcript ⇒ assert reclaim
  + answer fidelity).
- Docs: a `guides/compaction` page + a howto recipe demonstrating each strategy/trigger.

## 8. Decisions

**Resolved:**

1. **Surface = core spec field `spec.compaction?`, no plugin.** (Single seam, hashable,
   no stateful-leak — §3.1.) The `beforeCompaction` plugin stub is kept as an advisory
   pre-summarize hook only.
2. **No hidden defaults.** `strategy` and `preserve` are required; `trigger` omitted ⇒
   manual-only; guard fields omitted ⇒ guard off; `summaryPrompt` shipped as an importable
   constant, required (not silently defaulted) when `"summarize"` is used. Recommended values
   live in guides, not code (§0).

**Open:**

3. **`summaryPrompt` ergonomics.** Conditionally-required + exported constant (chosen) vs
   always-optional with a documented fallback. Chosen form keeps "no silent default" honest at
   the cost of one required field when summarizing. Revisit if too noisy in practice.
4. **`beforeCompaction` stub.** Keep + wire as advisory (chosen, P2) vs remove (drops an unused
   extension point, smaller surface). Recommend keep — it's the plugin-as-bundle composability
   slot and is already typed.

---

Touched files (when built): `packages/core/src/agent-spec.ts` (add `CompactionPolicy` +
`spec.compaction?`), `packages/core/src/events.ts:67` (extend `compaction` event),
`packages/core/src/plugin.ts:93` (wire `beforeCompaction`), `packages/harness/src/run.ts`
(`:693` compose `transformContext`, `:508` snapshot compacted, `:1200` `hashSpec`, `:222`
`compactFlag`), `packages/facade/src/index.ts` (`RunHandle.compact()` + flag), new
`packages/harness/src/compaction/{maybe-compact,summarize,drop-tool-results,sliding-window,estimate,prompt}.ts`.
