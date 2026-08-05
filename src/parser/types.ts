// Typy grafu wykonania sesji Claude Code — czysty model, bez zależności od UI.

import type { SandboxInfo } from "./sandbox.ts";
export type { IsolationType, BoundaryCrossing, SandboxInfo } from "./sandbox.ts";

export type NodeStatus =
  | "ok"
  | "error"
  | "unknown"
  /** Spawn asynchroniczny bez domknięcia (brak sidecara) albo sesja live. */
  | "in_progress"
  /** Przerwane: `toolUseResult.interrupted === true`. */
  | "interrupted"
  /** Odmowa wykonania narzędzia: rekord wyniku niesie `toolDenialKind`. */
  | "denied";

export type GraphNodeType = "session" | "agent" | "tool_call" | "file";

export interface NodeMeta {
  timestamp: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Tokeny czytane z cache (`cache_read_input_tokens`), deduplikowane po message.id. */
  cacheReadTokens: number;
  /** Tokeny zapisu do cache (`cache_creation_input_tokens`), deduplikowane po message.id. */
  cacheCreationTokens: number;
  /**
   * Zapis do cache w podziale na TTL (`usage.cache_creation.ephemeral_*_input_tokens`).
   * Gdy rekord nie niesie podziału, całość trafia do 5m (domyślny TTL) — zawsze
   * cacheCreation5mTokens + cacheCreation1hTokens === cacheCreationTokens.
   */
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
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
  /** Izolacja/sandbox i przekroczenia granicy — patrz parser/sandbox.ts. */
  sandbox: SandboxInfo;
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
  /** Suma tokenów cache read/creation po deduplikacji per message.id — patrz parseSession. */
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  modelsUsed: string[];
  agentCount: number;
  toolCallCount: number;
  fileCount: number;
  /** Liczba sidecarów `subagents/agent-<id>.jsonl` sklejonych z grafem. */
  sidecarsAttached: number;
  /** Liczniki rekordów `system` per `subtype` (turn_duration, compact_boundary, …). */
  systemSubtypeCounts: Record<string, number>;
  /** Liczniki rekordów `attachment` per `attachment.type` (hook_success, diagnostics, …). */
  attachmentTypeCounts: Record<string, number>;
  /** Liczba linii JSONL pominiętych (nieparsowalnych lub nieznanych). */
  skippedLines: number;
}

/** Pełne szczegóły węzła — bez limitu DETAIL_LIMIT, trzymane obok grafu, nie w GraphNode. */
export interface FullDetail {
  /** Pełny input wywołania (JSON/komenda/prompt), nieucięty. */
  input: string;
  /** Pełny output tool_result, nieucięty. */
  output: string;
  /** Surowe pole `toolUseResult` rekordu wyniku (obiekt, string albo tablica; null gdy brak). */
  toolUseResult: unknown;
}

/** Zawartość jednego sidecara subagenta: `subagents/agent-<id>.jsonl` + opcjonalny meta.json. */
export interface SubagentSidecar {
  jsonl: string;
  /** Zawartość `agent-<id>.meta.json` (agentType, description, toolUseId, parentAgentId, name…). */
  meta?: Record<string, unknown> | null;
}

export interface SessionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: SessionMeta;
  /** Pełne szczegóły per węzeł (tool_call i agent-spawn) — patrz FullDetail. */
  details: Map<string, FullDetail>;
}
