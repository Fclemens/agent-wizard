# agent-wizard

A harness for building, running, and **understanding** agentic loops and agent graphs.

You define an agent as a graph in TypeScript (nodes that read and update shared state, connected by
edges, including cycles). Agent Wizard runs it with any LLM provider and records every step as a
trace event. The web UI then lets you:

- **Watch** the graph execute live: the active node pulses, edges light up and count traversals.
- **Step** through a run one node at a time (step mode), then continue, pause, or cancel.
- **Inspect** every event: the exact messages and tools sent to the model, its reasoning summary,
  tool calls and results, each node's state update, and why each edge was taken.
- **Time travel**: scrub back through a finished run and see the graph and state at any point.
- **Replay** past runs, which are saved as JSONL under `runs/`.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The **Mock** provider needs no API key: each example graph ships scripted
model replies, so you can study the loop mechanics offline, for free.

Terminal-only alternative:

```bash
npm run cli -- react-agent "What is (17 * 23) + 4^3, and what is an agentic loop?"
```

### Real models

| Provider | Environment variables |
|---|---|
| Claude (Anthropic SDK) | `ANTHROPIC_API_KEY` (or `ant auth login`). Optional: `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_EFFORT` (`low`…`max`, default `medium`) |
| OpenAI-compatible (OpenAI, Ollama, vLLM, LM Studio, …) | `OPENAI_MODEL` (required), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `OPENAI_API_KEY` |

For example, with a local Ollama:

```bash
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3.1 npm run dev
```

The Claude adapter uses adaptive thinking with summarized display (so reasoning shows up in the
inspector) and the server-side refusal fallback (`fallbacks: "default"`), which reroutes a
declined request to another model. Turn the fallback off with `new AnthropicProvider({ fallbacks: false })`.

## Concepts

```
            ┌──────────────────────────────┐
            ▼                              │ observe results
start ──▶ agent ──(has tool calls)──▶ tools ┘
            │
            └──(final answer)──▶ end
```

| Piece | What it is |
|---|---|
| **State** | One object shared by all nodes. `messages` is append-only. Every other key is replaced by updates. |
| **Node** | `run(state, ctx)` returns a partial state update. Kinds: `llm`, `tool`, `function`, `router`, `human`. |
| **Edge** | Static (`{ from, to }`) or conditional (`{ from, targets, route(state) }`). One outgoing edge per node; branch with a conditional edge. |
| **Loop** | Any cycle in the graph. The engine keeps following edges until it reaches `end`, or `maxSteps` stops it. |
| **Trace** | Every engine action is a `TraceEvent` (`node_start`, `llm_request`, `llm_response`, `tool_call`, `tool_result`, `node_end`, `edge`, `paused`, `run_end`, …). The UI is built only from this stream. |
| **Provider** | `LLMProvider.complete(request)`. Messages are provider-neutral; each adapter converts to its wire format. |

## Example graphs

- **`react-agent`**: the canonical agent ⇄ tools loop with a calculator, a clock, and an offline
  notes lookup. Try "Tell me about vector databases." to see a tool error fed back to the model
  instead of crashing the run.
- **`reflection`**: writer → critic → (revise | end). The loop condition lives in custom state
  (`approved`, `revision`) rather than in the messages.

## Writing your own graph

```ts
import { END, type BaseState, type GraphDefinition, llmNode, toolNode, routeOnToolCalls, calculatorTool } from "@agent-wizard/core";

export const myGraph: GraphDefinition<BaseState> = {
  id: "my-graph",
  name: "My graph",
  description: "What it does",
  entry: "agent",
  nodes: [
    llmNode({ id: "agent", system: "You are …", tools: [calculatorTool] }),
    toolNode({ id: "tools", tools: [calculatorTool] }),
  ],
  edges: [
    { from: "agent", targets: ["tools", END], route: routeOnToolCalls("tools") },
    { from: "tools", to: "agent" },
  ],
  initialState: (input) => ({ messages: [{ role: "user", text: input }] }),
  // Optional: scripted replies so it also runs on the Mock provider.
  mockScripts: { agent: (req, turn) => ({ text: "…" }) },
};
```

Register it in `exampleGraphs` in `packages/core/src/index.ts` and it appears in the UI and CLI.
For custom logic, use `functionNode` and call the model with `ctx.callLLM(...)`, which traces the
request and response automatically.

## Repository layout

```
packages/core   engine, graph model, node helpers, tools, providers, example graphs (+ tests)
apps/server     HTTP API + Server-Sent Events stream, run store, CLI
apps/web        React + React Flow UI
runs/           recorded traces (git-ignored)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API server (port 8787) + Vite UI (port 5173) |
| `npm run build` then `npm start` | Build the UI and serve everything from port 8787 |
| `npm run cli -- <graph> "<input>" [--provider …] [--json]` | Run a graph in the terminal |
| `npm test` | Engine tests (Vitest) |
| `npm run typecheck` | Type-check all workspaces |

## API

| Method | Path | |
|---|---|---|
| GET | `/api/graphs` | Graph descriptions (nodes, edges, example inputs) |
| GET | `/api/providers` | Providers and whether they are configured |
| GET | `/api/runs` | Run summaries |
| POST | `/api/runs` | `{ graphId, providerId, input, stepMode }` → `{ runId }` |
| GET | `/api/runs/:id` | Summary + full event list |
| GET | `/api/runs/:id/events` | SSE: replays history, then streams live events until `run_end` |
| POST | `/api/runs/:id/control` | `{ action: "step" \| "pause" \| "resume" \| "cancel" }` |

## Roadmap ideas

- Parallel branches (fan-out / fan-in) and subgraphs
- Human-in-the-loop nodes (approve or edit tool calls from the UI)
- YAML graph definitions and a visual editor that round-trips with code
- Re-run from any step with edited state (forking a run)
- Run comparison and cost/latency charts across providers
