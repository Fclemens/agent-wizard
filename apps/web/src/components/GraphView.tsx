import {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import type { GraphDescription } from "../api";
import { type RunView, edgeKey, layout } from "../derive";

type StepNodeData = {
  label: string;
  kind: string;
  description?: string;
  visits: number;
  state: "idle" | "visited" | "active" | "paused";
};

const KIND_ICON: Record<string, string> = {
  llm: "◆",
  tool: "⚙",
  router: "⑂",
  function: "ƒ",
  human: "☺",
  start: "▶",
  end: "■",
};

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const terminal = data.kind === "start" || data.kind === "end";
  return (
    <div className={`gnode gnode--${data.kind} gnode--${data.state}${terminal ? " gnode--terminal" : ""}`} title={data.description}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="target" position={Position.Right} id="rt" style={{ top: "30%" }} />
      <div className="gnode__head">
        <span className="gnode__icon" aria-hidden>
          {KIND_ICON[data.kind] ?? "•"}
        </span>
        <span className="gnode__label">{data.label}</span>
        {!terminal && data.visits > 0 && <span className="gnode__visits">×{data.visits}</span>}
      </div>
      {!terminal && <div className="gnode__kind">{data.state === "paused" ? "paused before" : data.kind}</div>}
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Right} id="rs" style={{ top: "70%" }} />
      <Handle type="source" position={Position.Left} id="ls" style={{ top: "70%" }} />
      <Handle type="target" position={Position.Left} id="lt" style={{ top: "30%" }} />
    </div>
  );
}

const nodeTypes = { step: StepNode };

function Inner({ graph, view }: { graph: GraphDescription; view: RunView }) {
  const { positions, depth } = useMemo(() => layout(graph), [graph]);
  const { fitView } = useReactFlow();

  useEffect(() => {
    const id = requestAnimationFrame(() => void fitView({ padding: 0.25, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [graph, fitView]);

  const nodes: Node<StepNodeData>[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "step",
    position: positions[n.id] ?? { x: 0, y: 0 },
    draggable: true,
    data: {
      label: n.label,
      kind: n.kind,
      description: n.description,
      visits: view.visits[n.id] ?? 0,
      state:
        view.activeNode === n.id
          ? "active"
          : view.pausedNode === n.id
            ? "paused"
            : (view.visits[n.id] ?? 0) > 0
              ? "visited"
              : "idle",
    },
  }));

  const edges: Edge[] = graph.edges.map((e) => {
    const k = edgeKey(e.from, e.to);
    const count = view.edgeCounts[k] ?? 0;
    const span = (depth.get(e.to) ?? 0) - (depth.get(e.from) ?? 0);
    // Back edges loop around the right side; edges that skip a row go around the left.
    const route = span <= 0 ? "right" : span > 1 ? "left" : "down";
    const isLast = view.lastEdge === k && view.status !== "idle";
    const label = [e.label, count > 0 ? `×${count}` : ""].filter(Boolean).join("  ");
    return {
      id: k,
      source: e.from,
      target: e.to,
      sourceHandle: route === "right" ? "rs" : route === "left" ? "ls" : "b",
      targetHandle: route === "right" ? "rt" : route === "left" ? "lt" : "t",
      type: route === "down" ? "default" : "smoothstep",
      label: label || undefined,
      animated: isLast && view.status !== "completed",
      className: `gedge${count > 0 ? " gedge--used" : ""}${isLast ? " gedge--last" : ""}${e.conditional ? " gedge--cond" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: count > 0 ? Math.min(1.5 + count, 5) : 1.5 },
    };
  });

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      colorMode="system"
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      minZoom={0.3}
    >
      <Background gap={20} size={1} />
    </ReactFlow>
  );
}

export function GraphView(props: { graph: GraphDescription; view: RunView }) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
