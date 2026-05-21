import type { Scenario } from "./types.ts";

import { scenario as writeArticle } from "./write-article.ts";
import { scenario as fixCodeBug } from "./fix-code-bug.ts";
import { scenario as filterEmails } from "./filter-emails.ts";
import { scenario as extractData } from "./extract-data.ts";
import { scenario as summarizeDoc } from "./summarize-doc.ts";
import { scenario as classifyTickets } from "./classify-tickets.ts";
import { scenario as planTrip } from "./plan-trip.ts";
import { scenario as answerFaq } from "./answer-faq.ts";
import { scenario as researchSubagent, researcherSpec } from "./research-with-subagent.ts";
import { scenario as bashBlocklist } from "./bash-blocklist-triggered.ts";
import { scenario as loopDetectThrash } from "./loop-detect-thrash.ts";
import { scenario as skillRewrite } from "./skill-rewrite.ts";
import { scenario as mcpRoundtrip } from "./mcp-roundtrip.ts";
import { scenario as circuitBreakerTrip } from "./circuit-breaker-trip.ts";
import { scenario as phaseRecorderPipeline } from "./phase-recorder-pipeline.ts";
import { scenario as quotaTurns } from "./quota-turns.ts";

export const ALL_SCENARIOS: ReadonlyArray<Scenario> = [
  writeArticle as unknown as Scenario,
  fixCodeBug as unknown as Scenario,
  filterEmails as unknown as Scenario,
  extractData as unknown as Scenario,
  summarizeDoc as unknown as Scenario,
  classifyTickets as unknown as Scenario,
  planTrip as unknown as Scenario,
  answerFaq as unknown as Scenario,
  researchSubagent as unknown as Scenario,
  bashBlocklist as unknown as Scenario,
  loopDetectThrash as unknown as Scenario,
  skillRewrite as unknown as Scenario,
  mcpRoundtrip as unknown as Scenario,
  circuitBreakerTrip as unknown as Scenario,
  phaseRecorderPipeline as unknown as Scenario,
  quotaTurns as unknown as Scenario,
];

/** Subagent registry shared across runs. Add child specs here. */
export const SUBAGENT_REGISTRY = {
  researcher: researcherSpec,
} as const;

export type { Scenario } from "./types.ts";
