// @droveragent/eval
// Record/replay of provider responses for evals and offline tests.
// The formal ScenarioRunner / Scorer / Reporter library is still reserved: the
// in-repo eval suite (`evals/run.ts`) is the current source of truth.
export {
  RECORDING_VERSION,
  ReplayAmbiguousError,
  ReplayDriftError,
  ReplayExhaustedError,
  createRecorder,
  hashRequest,
  recordStream,
  threadKey,
  replayStream,
  type RecordError,
  type RecordOptions,
  type RecordingStreamFn,
  type RecordedTurn,
  type RecordingSink,
  type ReplayOptions,
  type StreamRecording,
} from "./record-replay.ts";
export {
  FakeProviderExhaustedError,
  fakeProvider,
  faults,
  reply,
  type FakeProvider,
  type FakeStep,
} from "./fake-provider.ts";
