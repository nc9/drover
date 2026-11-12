/**
 * A provider stream that never yields must not hang a run (#81): a call whose stream produces no
 * event for `idleMs` is ended as a failed call. The inner call's signal is aborted, and the
 * stream ends with an `error` event whose message is `"Request timed out."`, which the provider
 * chain classifies as `timeout` (so it fails over) and the harness reports as a provider error.
 */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

/** Default idle limit: 10 minutes without a single stream event. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

type StreamLike = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

const timedOut = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: "Request timed out.",
  timestamp: Date.now(),
});

/**
 * `fn` with an idle watchdog: the timer starts with the call and restarts on every event. When
 * it fires, the inner call is aborted and the returned stream ends with a timeout error. A caller
 * abort still passes through to the inner call. `idleMs` <= 0 or not finite: no watchdog.
 */
export function withStreamIdleTimeout<F extends StreamLike>(
  fn: F,
  idleMs: number,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessageEventStream> | AssistantMessageEventStream {
  if (!(idleMs > 0) || !Number.isFinite(idleMs)) return fn;
  return async (model, context, options) => {
    const ac = new AbortController();
    const caller = options?.signal;
    const onCallerAbort = (): void => ac.abort(caller?.reason);
    if (caller?.aborted) ac.abort(caller.reason);
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onIdle: () => void = () => {};
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        finish();
        ac.abort(new Error("stream idle timeout"));
        onIdle();
      }, idleMs);
    };
    arm();
    // Opening the stream: a throw passes through unchanged (callers read its structured fields);
    // an open that never settles is a timeout, thrown like the SDK's own.
    let inner: AssistantMessageEventStream;
    try {
      inner = await new Promise<AssistantMessageEventStream>((resolve, reject) => {
        onIdle = () => reject(new Error("Request timed out."));
        Promise.resolve(fn(model, context, { ...options, signal: ac.signal })).then(
          resolve,
          reject,
        );
      });
    } catch (err) {
      finish();
      throw err;
    }
    const out = createAssistantMessageEventStream();
    onIdle = () => {
      out.push({ type: "error", reason: "error", error: timedOut(model) });
      out.end();
    };
    void (async () => {
      try {
        for await (const ev of inner as AsyncIterable<AssistantMessageEvent>) {
          if (done) return;
          arm();
          out.push(ev);
          if (ev.type === "done" || ev.type === "error") {
            finish();
            out.end();
            return;
          }
        }
        if (!done) {
          // Ended without a terminal event: a failed call, not a hang.
          finish();
          const m = timedOut(model);
          m.errorMessage = "provider stream ended without a final message";
          out.push({ type: "error", reason: "error", error: m });
          out.end();
        }
      } catch (err) {
        if (done) return;
        finish();
        const m = timedOut(model);
        m.errorMessage = err instanceof Error ? err.message : String(err);
        if (caller?.aborted) m.stopReason = "aborted";
        out.push({ type: "error", reason: caller?.aborted ? "aborted" : "error", error: m });
        out.end();
      }
    })();
    return out;
  };
}
