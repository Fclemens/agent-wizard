import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type AnyGraph,
  RunController,
  type TraceEvent,
  createProvider,
  newRunId,
  runGraph,
} from "@agent-wizard/core";

export interface RunSummary {
  id: string;
  graphId: string;
  provider: string;
  model: string;
  input: string;
  status: "running" | "paused" | "completed" | "max_steps" | "error" | "cancelled";
  startedAt: number;
  steps: number;
}

interface LiveRun {
  summary: RunSummary;
  events: TraceEvent[];
  controller?: RunController;
  listeners: Set<(e: TraceEvent) => void>;
}

/**
 * Keeps every run in memory and appends each event to runs/<id>.jsonl, so
 * past runs survive restarts and can be replayed in the UI.
 */
export class RunStore {
  private runs = new Map<string, LiveRun>();

  constructor(private dir: string) {}

  async load() {
    await mkdir(this.dir, { recursive: true });
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const events = (await readFile(path.join(this.dir, file), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as TraceEvent);
        const summary = summarize(events);
        if (!summary) continue;
        // A run with no run_end was interrupted by a restart.
        if (summary.status === "running" || summary.status === "paused") summary.status = "cancelled";
        this.runs.set(summary.id, { summary, events, listeners: new Set() });
      } catch (err) {
        console.warn(`Skipping unreadable run file ${file}:`, err);
      }
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => r.summary).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string) {
    return this.runs.get(id);
  }

  start(graph: AnyGraph, opts: { providerId: string; input: string; stepMode: boolean }): string {
    const provider = createProvider(opts.providerId, graph);
    const id = newRunId();
    const controller = new RunController({ stepMode: opts.stepMode });
    const run: LiveRun = {
      summary: {
        id,
        graphId: graph.id,
        provider: provider.id,
        model: provider.model,
        input: opts.input,
        status: "running",
        startedAt: Date.now(),
        steps: 0,
      },
      events: [],
      controller,
      listeners: new Set(),
    };
    this.runs.set(id, run);
    const file = path.join(this.dir, `${id}.jsonl`);
    let writes = Promise.resolve();

    void runGraph(graph, {
      runId: id,
      provider,
      input: opts.input,
      controller,
      onEvent: (event) => {
        run.events.push(event);
        updateSummary(run.summary, event);
        writes = writes.then(() => appendFile(file, `${JSON.stringify(event)}\n`)).catch((err) => {
          console.warn(`Failed to persist event for ${id}:`, err);
        });
        for (const listener of run.listeners) listener(event);
      },
    }).finally(() => {
      run.controller = undefined;
    });
    return id;
  }

  control(id: string, action: string): boolean {
    const controller = this.runs.get(id)?.controller;
    if (!controller) return false;
    switch (action) {
      case "step":
        controller.step();
        return true;
      case "pause":
        controller.pause();
        return true;
      case "resume":
        controller.resume();
        if (this.runs.get(id)?.summary.status === "paused") this.runs.get(id)!.summary.status = "running";
        return true;
      case "cancel":
        controller.cancel();
        return true;
      default:
        return false;
    }
  }
}

function updateSummary(s: RunSummary, e: TraceEvent) {
  switch (e.type) {
    case "paused":
      s.status = "paused";
      break;
    case "node_start":
      s.status = "running";
      break;
    case "edge":
      s.steps = e.step + (e.from === "__start__" ? 0 : 1);
      break;
    case "run_end":
      s.status = e.status;
      s.steps = e.steps;
      break;
  }
}

function summarize(events: TraceEvent[]): RunSummary | undefined {
  const first = events[0];
  if (!first || first.type !== "run_start") return undefined;
  const s: RunSummary = {
    id: first.runId,
    graphId: first.graphId,
    provider: first.provider,
    model: first.model,
    input: first.input,
    status: "running",
    startedAt: first.ts,
    steps: 0,
  };
  for (const e of events) updateSummary(s, e);
  return s;
}
