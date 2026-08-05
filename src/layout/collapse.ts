// Projekcja grafu sesji na widok hierarchiczny z collapse (ojacie-e0c, D2).
//
// React Flow nie ma OSS-owego expand/collapse (useExpandCollapse jest tylko
// w Pro), więc collapse to CZYSTA funkcja: pełny graf żyje poza React Flow,
// a do komponentu trafia wyliczony rzut — widoczne węzły + krawędzie.
// Zwinięty agent = jeden węzeł zbiorczy z agregatami poddrzewa; jego praca
// (tool calle, pliki, zagnieżdżeni agenci) w ogóle nie wchodzi do tablicy
// węzłów (tańsze niż masowe `hidden: true`, które zostaje w nodeLookup).
//
// Zoom NIGDY nie zmienia zbioru węzłów — od tego jest lodForZoom (LOD karty).

import type { GraphEdge, GraphNode } from "../parser/types.ts";
import { aggregateSessionCost, type SessionCostSummary } from "../pricing.ts";

export const MAIN_AGENT_ID = "agent-main";

/** Agregaty poddrzewa agenta (rekurencyjnie: własne + wszystkich potomków). */
export interface AgentAggregates {
  /** Liczba tool calli w poddrzewie. */
  toolCalls: number;
  /** Węzły (tool calle + agenci) ze statusem error w poddrzewie. */
  errors: number;
  /** Unikalne pliki dotknięte w poddrzewie. */
  files: number;
  /** Liczba agentów-potomków (bez samego agenta). */
  agents: number;
  /** Tokeny i koszt USD poddrzewa (agent + potomkowie), per model. */
  cost: SessionCostSummary;
}

export interface ProjectedNode {
  node: GraphNode;
  /** Agent, którego rozwinięta grupa zawiera ten węzeł; null = poziom root. */
  parentAgentId: string | null;
  /** Tylko agenci: true = węzeł zbiorczy (poddrzewo schowane). */
  collapsed: boolean;
  /** Tylko agenci: agregaty poddrzewa. */
  aggregates: AgentAggregates | null;
}

export interface ProjectedGraph {
  /** Kolejność DFS pre-order: rodzic (grupa) zawsze przed dzieckiem — wymóg React Flow. */
  nodes: ProjectedNode[];
  /** Krawędzie, których oba końce są widoczne w rzucie. */
  edges: GraphEdge[];
}

interface Hierarchy {
  /** source → targety krawędzi spawns (session→main, agent→subagent). */
  childAgents: Map<string, string[]>;
  /** agent → jego tool calle (kolejność chronologiczna parsera). */
  agentTools: Map<string, string[]>;
  /** tool call → dotknięte pliki. */
  toolFiles: Map<string, string[]>;
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Indeksuje krawędzie grafu w hierarchię rodzic→dzieci (jedno przejście po edges). */
export function buildHierarchy(edges: GraphEdge[]): Hierarchy {
  const childAgents = new Map<string, string[]>();
  const agentTools = new Map<string, string[]>();
  const toolFiles = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type === "spawns") push(childAgents, e.source, e.target);
    else if (e.type === "calls") push(agentTools, e.source, e.target);
    else push(toolFiles, e.source, e.target);
  }
  return { childAgents, agentTools, toolFiles };
}

interface SubtreeAcc {
  toolCalls: number;
  errors: number;
  files: Set<string>;
  agents: number;
  agentNodes: GraphNode[];
}

/**
 * Rzutuje pełny graf sesji na widok z zadanym zbiorem rozwiniętych agentów.
 * Domyślny widok (expanded = {agent-main}) to kręgosłup sesji:
 * session → main (z własną pracą) → subagenci zwinięci do węzłów zbiorczych.
 */
export function projectGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expanded: ReadonlySet<string>,
): ProjectedGraph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const h = buildHierarchy(edges);

  // Agregaty poddrzewa z memoizacją — graf jest DAG-iem po spawns (drzewo agentów).
  const subtreeMemo = new Map<string, SubtreeAcc>();
  function subtree(agentId: string): SubtreeAcc {
    const memo = subtreeMemo.get(agentId);
    if (memo) return memo;
    const acc: SubtreeAcc = { toolCalls: 0, errors: 0, files: new Set(), agents: 0, agentNodes: [] };
    subtreeMemo.set(agentId, acc); // przed rekursją — bezpiecznik na cykl w danych
    const self = byId.get(agentId);
    if (self) {
      acc.agentNodes.push(self);
      if (self.meta.status === "error") acc.errors += 1;
    }
    for (const toolId of h.agentTools.get(agentId) ?? []) {
      acc.toolCalls += 1;
      if (byId.get(toolId)?.meta.status === "error") acc.errors += 1;
      for (const fileId of h.toolFiles.get(toolId) ?? []) acc.files.add(fileId);
    }
    for (const childId of h.childAgents.get(agentId) ?? []) {
      const child = subtree(childId);
      acc.toolCalls += child.toolCalls;
      acc.errors += child.errors;
      acc.agents += 1 + child.agents;
      for (const f of child.files) acc.files.add(f);
      acc.agentNodes.push(...child.agentNodes);
    }
    return acc;
  }

  function aggregatesFor(agentId: string): AgentAggregates {
    const acc = subtree(agentId);
    return {
      toolCalls: acc.toolCalls,
      errors: acc.errors,
      files: acc.files.size,
      agents: acc.agents,
      cost: aggregateSessionCost(acc.agentNodes),
    };
  }

  const out: ProjectedNode[] = [];
  const visible = new Set<string>();
  function emit(node: GraphNode, parentAgentId: string | null, collapsed: boolean, aggregates: AgentAggregates | null) {
    out.push({ node, parentAgentId, collapsed, aggregates });
    visible.add(node.id);
  }

  // Agenci obsłużeni w przebiegu — także ci SCHOWANI w poddrzewie zwiniętego
  // rodzica (nie są widoczni, ale nie są zgubieni: żyją w agregatach).
  const handled = new Set<string>();

  function visitAgent(agentId: string, containerAgentId: string | null) {
    const node = byId.get(agentId);
    if (!node || handled.has(agentId)) return;
    handled.add(agentId);
    const isExpanded = expanded.has(agentId);
    emit(node, containerAgentId, !isExpanded, aggregatesFor(agentId));
    if (!isExpanded) {
      for (const descendant of subtree(agentId).agentNodes) handled.add(descendant.id);
      return;
    }
    for (const toolId of h.agentTools.get(agentId) ?? []) {
      const tool = byId.get(toolId);
      if (!tool) continue;
      emit(tool, agentId, false, null);
      for (const fileId of h.toolFiles.get(toolId) ?? []) {
        if (visible.has(fileId)) continue; // plik współdzielony — zostaje w pierwszej grupie
        const file = byId.get(fileId);
        if (file) emit(file, agentId, false, null);
      }
    }
    for (const childId of h.childAgents.get(agentId) ?? []) visitAgent(childId, agentId);
  }

  const session = nodes.find((n) => n.type === "session");
  if (session) {
    emit(session, null, false, null);
    for (const rootAgentId of h.childAgents.get(session.id) ?? []) visitAgent(rootAgentId, null);
  }
  // Bezpiecznik: agent nieosiągalny z sesji (nie powinien istnieć) — pokazujemy na root, nie gubimy.
  for (const n of nodes) {
    if (n.type === "agent" && !handled.has(n.id)) visitAgent(n.id, null);
  }

  return { nodes: out, edges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)) };
}

/** Poziom szczegółu karty sterowany zoomem — zoom zmienia LOD, nigdy zbiór węzłów. */
export type CardLod = "far" | "mid" | "near";

/** Progi zwracają wartość stabilną referencyjnie — selektor useStore nie re-renderuje co klatkę. */
export function lodForZoom(zoom: number): CardLod {
  if (zoom < 0.45) return "far";
  if (zoom < 1.1) return "mid";
  return "near";
}
