import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GraphDescription, type ProviderInfo, type RunSummary, type TraceEvent, api } from "./api";
import { GraphView } from "./components/GraphView";
import { Inspector } from "./components/Inspector";
import { Timeline } from "./components/Timeline";
import { deriveView } from "./derive";

export function App() {
  const [graphs, setGraphs] = useState<GraphDescription[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [graphId, setGraphId] = useState("");
  const [providerId, setProviderId] = useState("mock");
  const [input, setInput] = useState("");
  const [stepMode, setStepMode] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  /** Selected timeline index; null = follow the live tail. */
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  const refreshRuns = useCallback(() => {
    api.runs().then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([api.graphs(), api.providers()])
      .then(([g, p]) => {
        setGraphs(g);
        setProviders(p);
        const first = g[0];
        if (first) {
          setGraphId(first.id);
          setInput(first.exampleInputs[0] ?? "");
        }
      })
      .catch((e: Error) => setError(`Cannot reach the server: ${e.message}. Is it running on port 8787?`));
    refreshRuns();
    return () => unsubscribe.current?.();
  }, [refreshRuns]);

  const runGraphId = events[0]?.type === "run_start" ? events[0].graphId : graphId;
  const graph = graphs.find((g) => g.id === runGraphId) ?? graphs.find((g) => g.id === graphId);
  const cursor = selected ?? events.length - 1;
  const view = useMemo(() => deriveView(events, cursor), [events, cursor]);
  const live = useMemo(() => deriveView(events), [events]);
  const isLive = live.status === "running" || live.status === "paused";

  const watch = useCallback(
    (id: string) => {
      unsubscribe.current?.();
      setRunId(id);
      setEvents([]);
      setSelected(null);
      unsubscribe.current = api.subscribe(
        id,
        (e) => {
          setEvents((prev) => [...prev, e]);
          if (e.type === "run_end") refreshRuns();
        },
        refreshRuns,
      );
    },
    [refreshRuns],
  );

  const start = async () => {
    setError(null);
    try {
      const { runId: id } = await api.startRun({ graphId, providerId, input, stepMode });
      watch(id);
      refreshRuns();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const control = (action: "step" | "pause" | "resume" | "cancel") => {
    if (!runId) return;
    if (action !== "pause") setSelected(null);
    api.control(runId, action).catch((e: Error) => setError(e.message));
  };

  const pickGraph = (id: string) => {
    setGraphId(id);
    setInput(graphs.find((g) => g.id === id)?.exampleInputs[0] ?? "");
    if (!isLive) {
      unsubscribe.current?.();
      setRunId(null);
      setEvents([]);
      setSelected(null);
    }
  };

  const currentGraph = graphs.find((g) => g.id === graphId);
  const provider = providers.find((p) => p.id === providerId);

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span aria-hidden>🧙</span> Agent Wizard
        </h1>
        <p className="muted">Run agent graphs, step through the loop, inspect every call.</p>
      </header>

      <aside className="panel controls">
        <label className="lbl">
          Graph
          <select value={graphId} onChange={(e) => pickGraph(e.target.value)}>
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        {currentGraph && <p className="muted small">{currentGraph.description}</p>}

        <label className="lbl">
          Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.label}
                {p.configured ? ` · ${p.model}` : " (not configured)"}
              </option>
            ))}
          </select>
        </label>
        {provider?.hint && <p className="muted small">{provider.hint}</p>}

        <label className="lbl">
          Input
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} />
        </label>
        {currentGraph && currentGraph.exampleInputs.length > 1 && (
          <div className="chips">
            {currentGraph.exampleInputs.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setInput(ex)} title={ex}>
                {ex.length > 38 ? `${ex.slice(0, 38)}…` : ex}
              </button>
            ))}
          </div>
        )}

        <label className="check">
          <input type="checkbox" checked={stepMode} onChange={(e) => setStepMode(e.target.checked)} />
          Step mode (pause before every node)
        </label>

        <button type="button" className="btn btn--primary" onClick={start} disabled={!graphId || !input.trim() || isLive}>
          ▶ Run
        </button>

        {isLive && (
          <div className="btnrow">
            {live.status === "paused" ? (
              <>
                <button type="button" className="btn" onClick={() => control("step")}>
                  Step
                </button>
                <button type="button" className="btn" onClick={() => control("resume")}>
                  Continue
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => control("pause")}>
                Pause
              </button>
            )}
            <button type="button" className="btn btn--danger" onClick={() => control("cancel")}>
              Cancel
            </button>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <h2 className="section">History</h2>
        {runs.length === 0 && <p className="muted small">No runs yet.</p>}
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`run${r.id === runId ? " run--active" : ""}`}
                onClick={() => watch(r.id)}
                title={r.input}
              >
                <span className={`badge badge--${r.status}`}>{r.status}</span>
                <span className="run__input">{r.input}</span>
                <span className="muted small">
                  {r.graphId} · {r.provider} · {r.steps} steps · {new Date(r.startedAt).toLocaleTimeString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="panel stage">
        <div className="stats">
          <Stat label="status" value={view.status} tone={view.status} />
          <Stat label="steps" value={view.steps} />
          <Stat label="LLM calls" value={view.llmCalls} />
          <Stat label="tool calls" value={view.toolCalls} />
          <Stat label="tokens in/out" value={`${view.inputTokens} / ${view.outputTokens}`} />
          <Stat label="elapsed" value={`${(view.elapsedMs / 1000).toFixed(1)}s`} />
        </div>
        <div className="graph">{graph ? <GraphView graph={graph} view={view} /> : <p className="empty">Loading…</p>}</div>
        {events.length > 0 && (
          <div className="scrubber">
            <label className="muted small" htmlFor="scrub">
              Time travel
            </label>
            <input
              id="scrub"
              type="range"
              min={0}
              max={events.length - 1}
              value={cursor}
              onChange={(e) => setSelected(Number(e.target.value))}
            />
            <span className="muted small mono">
              {cursor + 1}/{events.length}
            </span>
            <button type="button" className="btn btn--small" onClick={() => setSelected(null)} disabled={selected === null}>
              Live
            </button>
          </div>
        )}
        {view.error && <p className="error">Error: {view.error}</p>}
      </main>

      <section className="panel events">
        <h2 className="section">Timeline</h2>
        <Timeline events={events} selected={selected} cursor={cursor} onSelect={setSelected} />
      </section>

      <section className="panel detail">
        <h2 className="section">Inspector</h2>
        <Inspector event={events[cursor]} />
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}`}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
