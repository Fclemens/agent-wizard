import { useEffect, useRef } from "react";
import type { TraceEvent } from "../api";

export function summarizeEvent(e: TraceEvent): { icon: string; title: string; detail?: string; tone?: string } {
  switch (e.type) {
    case "run_start":
      return { icon: "▶", title: "Run started", detail: `${e.provider} · ${e.model}` };
    case "paused":
      return { icon: "⏸", title: `Paused before ${e.nextNode}`, tone: "warn" };
    case "node_start":
      return { icon: "→", title: `Enter ${e.node}`, detail: `step ${e.step}`, tone: "node" };
    case "llm_request":
      return { icon: "⇡", title: "LLM request", detail: `${e.request.messages.length} msgs · ${e.request.tools.length} tools` };
    case "llm_response": {
      const calls = e.response.toolCalls.map((c) => c.name).join(", ");
      return {
        icon: "⇣",
        title: calls ? `LLM → ${calls}` : "LLM answered",
        detail: `${e.durationMs}ms · ${e.response.stopReason}`,
        tone: "llm",
      };
    }
    case "tool_call":
      return { icon: "⚙", title: `Call ${e.call.name}`, detail: compact(e.call.input) };
    case "tool_result":
      return {
        icon: e.result.isError ? "✗" : "✓",
        title: `${e.result.name} ${e.result.isError ? "failed" : "returned"}`,
        detail: compact(e.result.output),
        tone: e.result.isError ? "error" : "tool",
      };
    case "log":
      return { icon: "✎", title: e.message };
    case "node_end":
      return { icon: "←", title: `Leave ${e.node}`, detail: `${e.durationMs}ms` };
    case "edge":
      return { icon: "↳", title: `${pretty(e.from)} → ${pretty(e.to)}`, detail: e.reason, tone: "edge" };
    case "run_end":
      return {
        icon: "■",
        title: `Run ${e.status}`,
        detail: e.error ?? `${e.steps} steps · ${e.durationMs}ms`,
        tone: e.status === "completed" ? "ok" : "error",
      };
  }
}

const pretty = (id: string) => (id === "__start__" ? "start" : id === "__end__" ? "end" : id);
const compact = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

export function Timeline(props: {
  events: TraceEvent[];
  selected: number | null;
  cursor: number;
  onSelect: (index: number) => void;
}) {
  const { events, selected, cursor, onSelect } = props;
  const listRef = useRef<HTMLOListElement>(null);
  const following = selected === null;

  useEffect(() => {
    if (following) listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [events.length, following]);

  if (!events.length) return <p className="empty">Start a run to see its events here.</p>;

  return (
    <ol className="timeline" ref={listRef}>
      {events.map((e, i) => {
        const s = summarizeEvent(e);
        return (
          <li key={e.seq}>
            <button
              type="button"
              className={`tl tl--${s.tone ?? "plain"}${i === selected ? " tl--selected" : ""}${i > cursor ? " tl--future" : ""}`}
              onClick={() => onSelect(i)}
            >
              <span className="tl__icon" aria-hidden>
                {s.icon}
              </span>
              <span className="tl__body">
                <span className="tl__title">{s.title}</span>
                {s.detail && <span className="tl__detail">{s.detail}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
