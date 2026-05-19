import type { HarnessEvent, HarnessPlugin } from "@drover/core";
import { Effect } from "effect";

export interface OutputValidateTrace {
  /** When an output_retry fires, the reason text. */
  retries: ReadonlyArray<{ attempt: number; reason: string; ts: number }>;
  /** Whether output_validated fired at the end (terminal success). */
  validated: boolean;
}

export interface OutputValidateRecorder {
  trace: OutputValidateTrace;
  plugin: HarnessPlugin;
}

/**
 * Observation-only plugin that mirrors the harness's built-in
 * output-validation lifecycle into a flat trace. Useful for eval
 * harnesses and dashboards that want to surface validation churn
 * without parsing the full event stream.
 *
 * The validation/retry logic itself lives in `@drover/harness`
 * (it's load-bearing — the harness's `outputRetries` budget feeds
 * back corrective messages to the model). This plugin only observes.
 */
export function outputValidatePlugin(): OutputValidateRecorder {
  const retries: { attempt: number; reason: string; ts: number }[] = [];
  const state: { validated: boolean } = { validated: false };

  const plugin: HarnessPlugin = {
    id: "output-validate-recorder",
    onEvent: (event: HarnessEvent): Effect.Effect<void, never, never> =>
      Effect.sync(() => {
        if (event.kind === "output_retry") {
          retries.push({ attempt: event.attempt, reason: event.reason, ts: event.ts });
        } else if (event.kind === "output_validated") {
          state.validated = true;
        }
      }),
  };

  return {
    trace: {
      get retries() {
        return retries;
      },
      get validated() {
        return state.validated;
      },
    } as OutputValidateTrace,
    plugin,
  };
}
