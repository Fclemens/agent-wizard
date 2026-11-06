export * from "./types";
export * from "./events";
export * from "./graph";
export * from "./engine";
export * from "./nodes";
export * from "./tools";
export * from "./providers/index";

import type { AnyGraph } from "./graph";
import { guardrails } from "./examples/guardrails";
import { intentRouter } from "./examples/intent-router";
import { planExecute } from "./examples/plan-execute";
import { promptChain } from "./examples/prompt-chain";
import { reactAgent } from "./examples/react-agent";
import { reflectionLoop } from "./examples/reflection";
import { supervisorTeam } from "./examples/supervisor";
import { validatedExtraction } from "./examples/validated-extraction";

export { guardrails, intentRouter, planExecute, promptChain, reactAgent, reflectionLoop, supervisorTeam, validatedExtraction };
export type { ReflectionState } from "./examples/reflection";
export { checkPolicy } from "./examples/guardrails";
export { validateContact } from "./examples/validated-extraction";

/** Graphs the server and CLI expose, roughly simplest first. Add your own here. */
export const exampleGraphs: AnyGraph[] = [
  intentRouter,
  promptChain,
  reactAgent,
  reflectionLoop,
  validatedExtraction,
  guardrails,
  planExecute,
  supervisorTeam,
];
