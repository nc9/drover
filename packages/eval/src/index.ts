// @droveragent/eval
// Record/replay of provider responses for evals and offline tests.
// The formal ScenarioRunner / Scorer / Reporter library is still reserved: the
// in-repo eval suite (`evals/run.ts`) is the current source of truth.
export {
  RECORDING_VERSION,
  ReplayDriftError,
  ReplayExhaustedError,
  createRecorder,
  hashRequest,
  recordStream,
  replayStream,
  type RecordOptions,
  type RecordedTurn,
  type RecordingSink,
  type ReplayOptions,
  type StreamRecording,
} from "./record-replay.ts";
