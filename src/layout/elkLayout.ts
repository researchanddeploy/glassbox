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

const GROUP_PADDING = 40;
const GROUP_LABEL_HEIGHT = 28;

/**
 * Otacza subagentów z izolacją (worktree/container) obrysem grupy React Flow:
 * ustawia parentId+extent na ich tool_call/file dzieciach i dokłada węzeł
 * grupy z etykietą typu izolacji. Krok post-processingu po płaskim layoucie
 * ELK — nie przelicza pozycji z algorytmu warstwowego, tylko dokleja ramkę
 * wokół już policzonej bounding-box dzieci (pozycje dzieci stają się względne
 * wobec grupy, jak wymaga React Flow dla parentId).
 * Poddrzewo subagenta = tool_calle wywołane przez niego (calls) + pliki
 * dotknięte przez te tool_calle (touches); nie schodzi w głąb zagnieżdżonych
 * subagentów (spawns) — ci dostają własny, osobny obrys.
 */
export function wrapIsolatedGroups(graphNodes: GraphNode[], edges: GraphEdge[], flowNodes: Node[]): Node[] {
  const flowById = new Map(flowNodes.map((n) => [n.id, n]));

  function descendantsOf(agentId: string): string[] {
    const toolIds = edges.filter((e) => e.type === "calls" && e.source === agentId).map((e) => e.target);
    const fileIds = edges.filter((e) => e.type === "touches" && toolIds.includes(e.source)).map((e) => e.target);
    return [...toolIds, ...fileIds];
  }

  const groups: Node[] = [];
  const childUpdates = new Map<string, { parentId: string; position: { x: number; y: number } }>();

  for (const node of graphNodes) {
    if (node.type !== "agent") continue;
    if (node.sandbox.isolation !== "worktree" && node.sandbox.isolation !== "container") continue;

    const childIds = descendantsOf(node.id).filter((id) => flowById.has(id));
    if (childIds.length === 0) continue; // brak zawartości do pokazania — nie rysuj pustego obrysu
    const childFlowNodes = childIds.map((id) => flowById.get(id)!);

    const minX = Math.min(...childFlowNodes.map((n) => n.position.x)) - GROUP_PADDING;
    const minY = Math.min(...childFlowNodes.map((n) => n.position.y)) - GROUP_PADDING - GROUP_LABEL_HEIGHT;
    const maxX = Math.max(...childFlowNodes.map((n) => n.position.x + NODE_WIDTH)) + GROUP_PADDING;
    const maxY = Math.max(...childFlowNodes.map((n) => n.position.y + NODE_HEIGHT)) + GROUP_PADDING;

    const groupId = `group-${node.id}`;
    groups.push({
      id: groupId,
      type: "isolationGroup",
      position: { x: minX, y: minY },
      style: { width: maxX - minX, height: maxY - minY },
      data: { label: node.label, isolation: node.sandbox.isolation },
      selectable: false,
      draggable: false,
      zIndex: -1,
    });

    for (const cn of childFlowNodes) {
      childUpdates.set(cn.id, { parentId: groupId, position: { x: cn.position.x - minX, y: cn.position.y - minY } });
    }
  }

  if (groups.length === 0) return flowNodes;

  const updatedNodes = flowNodes.map((n) => {
    const update = childUpdates.get(n.id);
    if (!update) return n;
    return { ...n, parentId: update.parentId, extent: "parent" as const, position: update.position };
  });

  // Rodzice muszą poprzedzać dzieci w tablicy — wymóg React Flow dla parentId.
  return [...groups, ...updatedNodes];
}
