import ELKModule from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
// Rozszerzenia .ts jawnie — plik jest typowany także w projekcie nodenext
// (tsconfig.node.json obejmuje testy), gdzie import bez rozszerzenia nie przejdzie.
import type { GraphEdge, GraphNode } from "../parser/types.ts";
import type { ProjectedGraph, ProjectedNode } from "./collapse.ts";

// Interop CJS/ESM: pod bundlerem default importu to konstruktor, pod nodenext
// (projekt tsconfig.node.json typujący testy) TS widzi cały moduł CJS. Runtime
// jest zgodny w obu światach: module.exports === konstruktor === .default.
const ELK = ELKModule as unknown as new () => ElkInstance;
const elk = new ELK();

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;
/** Zwinięty agent ma dodatkowy wiersz agregatów. */
const COLLAPSED_AGENT_HEIGHT = 100;

/**
 * Układa graf sesji przez elkjs (warstwowy layout, kierunek DOWN) i zwraca węzły/krawędzie React Flow.
 * Od ojacie-e0c App używa layoutProjected (hierarchia + collapse); płaski layoutGraph
 * i wrapIsolatedGroups zostają jako ścieżka historyczna (no-deletion) — izolację
 * w widoku hierarchicznym pokazuje obrys AgentGroupNode.
 */
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

const edgeColor: Record<string, string> = {
  spawns: "#aa3bff",
  calls: "#4f7cff",
  touches: "#22a06b",
};

function toFlowEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.type,
    animated: e.type === "spawns",
    style: { stroke: edgeColor[e.type] ?? "#999" },
  }));
}

const groupId = (agentId: string) => `grp-${agentId}`;

/**
 * Layout ZAGNIEŻDŻONY dla rzutu grafu (ojacie-e0c): każdy rozwinięty agent to
 * compound ELK (karta agenta + jego tool calle/pliki/dzieci), więc szeroka
 * warstwa setek wywołań nie powstaje na poziomie root — układ liczy się per
 * poddrzewo. Krawędzie przekraczające hierarchię obsługuje
 * `elk.hierarchyHandling: INCLUDE_CHILDREN`.
 *
 * Wewnątrz rozwiniętego agenta tool calle dostają niewidoczne krawędzie
 * sekwencji (chronologia = narracja) — bez nich layered kładzie wszystkie
 * wywołania w jednej warstwie o szerokości N×260 px. Krawędzie seq idą TYLKO
 * do ELK, nie do React Flow.
 */
export async function layoutProjected(projected: ProjectedGraph): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const byContainer = new Map<string | null, ProjectedNode[]>();
  for (const pn of projected.nodes) {
    const list = byContainer.get(pn.parentAgentId) ?? [];
    list.push(pn);
    byContainer.set(pn.parentAgentId, list);
  }

  const projectedById = new Map(projected.nodes.map((pn) => [pn.node.id, pn]));
  const seqEdges: { id: string; sources: string[]; targets: string[] }[] = [];

  // Łańcuch sekwencji obejmuje też węzły taksonomii (turn/task/checkpoint) —
  // chronologia = narracja; granice tur układają się między wywołaniami.
  const SEQ_TYPES = new Set(["tool_call", "turn", "task", "checkpoint"]);

  function elkNodeFor(pn: ProjectedNode): ElkNode {
    if (pn.node.type === "agent" && !pn.collapsed) {
      const members = byContainer.get(pn.node.id) ?? [];
      const toolIds = members.filter((m) => SEQ_TYPES.has(m.node.type)).map((m) => m.node.id);
      for (let i = 1; i < toolIds.length; i += 1) {
        seqEdges.push({ id: `seq-${pn.node.id}-${i}`, sources: [toolIds[i - 1]], targets: [toolIds[i]] });
      }
      return {
        id: groupId(pn.node.id),
        layoutOptions: { "elk.padding": "[top=52,left=24,bottom=24,right=24]" },
        children: [
          { id: pn.node.id, width: NODE_WIDTH, height: NODE_HEIGHT },
          ...members.map(elkNodeFor),
        ],
      };
    }
    return {
      id: pn.node.id,
      width: NODE_WIDTH,
      height: pn.node.type === "agent" ? COLLAPSED_AGENT_HEIGHT : NODE_HEIGHT,
    };
  }

  const rootChildren = (byContainer.get(null) ?? []).map(elkNodeFor);
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "40",
    },
    children: rootChildren,
    // Krawędzie calls NIE wchodzą do ELK: przynależność tool calli wyraża
    // containment grupy + łańcuch seq, a wachlarz agent→każde narzędzie
    // (dziesiątki krawędzi do jednej karty) rozjeżdżał kolumny na skos.
    // W React Flow calls renderują się normalnie — to decyzja layoutu, nie języka wizualnego.
    edges: [
      ...projected.edges
        .filter((e) => e.type !== "calls")
        .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
      ...seqEdges,
    ],
  });

  // Konwersja pre-order → rodzic (grupa) zawsze przed dzieckiem w tablicy React Flow.
  const flowNodes: Node[] = [];
  function walk(elkNode: ElkNode, parentFlowId: string | undefined) {
    for (const child of elkNode.children ?? []) {
      const position = { x: child.x ?? 0, y: child.y ?? 0 }; // ELK: względne wobec rodzica — jak React Flow
      const parentProps = parentFlowId ? { parentId: parentFlowId, extent: "parent" as const } : {};
      if (child.id.startsWith("grp-")) {
        const pn = projectedById.get(child.id.slice(4));
        if (!pn) continue;
        flowNodes.push({
          id: child.id,
          type: "agentGroup",
          position,
          style: { width: child.width ?? 0, height: child.height ?? 0 },
          data: { node: pn.node },
          selectable: false,
          draggable: false,
          ...parentProps,
        });
        walk(child, child.id);
        continue;
      }
      const pn = projectedById.get(child.id);
      if (!pn) continue;
      flowNodes.push({
        id: child.id,
        type: pn.node.type, // typy grafu = typy komponentów (nodeTypes w App)
        position,
        data: { node: pn.node, collapsed: pn.collapsed, aggregates: pn.aggregates },
        draggable: false,
        ...parentProps,
      });
    }
  }
  walk(result, undefined);

  return { nodes: flowNodes, edges: toFlowEdges(projected.edges) };
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
