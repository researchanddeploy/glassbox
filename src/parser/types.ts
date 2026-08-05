// Typy grafu wykonania sesji Claude Code — czysty model, bez zależności od UI.

export type NodeStatus = "ok" | "error" | "unknown";

export type GraphNodeType = "session" | "agent" | "tool_call" | "file";

export interface NodeMeta {
  timestamp: string | null;
  tokensIn: number;
  tokensOut: number;
  model: string | null;
  status: NodeStatus;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  /** Krótka etykieta do wyświetlenia na karcie węzła. */
  label: string;
  /** Skrócony input (polecenie/prompt/ścieżka), max ~2 KB. */
  detail: string;
  /** Skrócony output (tool_result), max ~2 KB. Puste, gdy nie dotyczy. */
  output: string;
  meta: NodeMeta;
}

export type EdgeType = "spawns" | "calls" | "touches";

export interface GraphEdge {
  id: string;
  type: EdgeType;
  source: string;
  target: string;
}

export interface SessionMeta {
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  totalTokensIn: number;
  totalTokensOut: number;
  modelsUsed: string[];
  agentCount: number;
  toolCallCount: number;
  fileCount: number;
  /** Liczba linii JSONL pominiętych (nieparsowalnych lub nieznanych). */
  skippedLines: number;
}

export interface SessionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: SessionMeta;
}
