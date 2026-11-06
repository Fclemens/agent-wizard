export * from "./types";
export * from "./events";
export * from "./graph";
export * from "./engine";
export * from "./nodes";
export * from "./tools";
export * from "./providers/index";

import type { AnyGraph } from "./graph";
import { reactAgent } from "./examples/react-agent";
import { reflectionLoop } from "./examples/reflection";

export { reactAgent, reflectionLoop };
export type { ReflectionState } from "./examples/reflection";

/** Graphs the server and CLI expose. Add your own here. */
export const exampleGraphs: AnyGraph[] = [reactAgent, reflectionLoop];
