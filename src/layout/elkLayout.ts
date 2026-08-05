import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "../parser/types";

const elk = new ELK();

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;

/** Układa graf sesji przez elkjs (warstwowy layout, kierunek DOWN) i zwraca węzły/krawędzie React Flow. */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "40",
    },
    children: nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(elkGraph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  const flowNodes: Node[] = nodes.map((n) => ({
    id: n.id,
    type: n.type === "session" ? "session" : n.type === "agent" ? "agent" : n.type === "tool_call" ? "tool_call" : "file",
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: { node: n },
  }));

  const edgeColor: Record<string, string> = {
    spawns: "#aa3bff",
    calls: "#4f7cff",
    touches: "#22a06b",
  };

  const flowEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.type,
    animated: e.type === "spawns",
    style: { stroke: edgeColor[e.type] ?? "#999" },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}
