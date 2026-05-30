// Umbrella entry point for the drover agent harness.
//
// Re-exports the public run/resume facade plus `defineAgent` so consumers can
// reach the essentials from a single unscoped package:
//
//   import { defineAgent, runAgent } from "droveragent";
//
// For anything beyond define + run, import the scoped packages directly
// (e.g. `@droveragent/plugins`, `@droveragent/runtime`, `@droveragent/storage`).
export * from "@droveragent/facade";
export { defineAgent } from "@droveragent/core";
