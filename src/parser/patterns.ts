// Detekcja wzorców PEWNYCH (iteracja 2 planu kierunków v2) — czyste funkcje
// nad gotowymi węzłami grafu. Definicje: docs/plany/2026-08-05-taksonomia.md §3.
// Wzorce progowe (saturation_repeat, tool_streak, retry_loop, pipeline) świadomie
// poza zakresem — wymagają kalibracji na większej próbie (iteracja 3).

import type { GraphNode, NodeStatus, PatternId } from "./types.ts";

/**
 * Próg fan-outu z taksonomii §3.1: `pendingBackgroundAgentCount ≥ 3` odsiewa
 * zwykłą delegację (zaobserwowane wartości 1-2) od realnego dispatchu
 * równoległego (3, 6, 7). Wartość ze źródła prawdy, nie z lokalnej kalibracji.
 */
export const FANOUT_MIN_BACKGROUND_AGENTS = 3;

/** Statusy będące realną awarią — TYLKO one dostają czerwień (decyzja D5). */
export function isErrorStatus(status: NodeStatus): boolean {
  return status === "error_tool" || status === "error_api";
}

/** Wzorce pewne jednego węzła — markery wprost z danych (taxo/sandbox/status). */
export function patternsForNode(node: GraphNode): PatternId[] {
  const out: PatternId[] = [];
  if (node.type === "turn" && (node.taxo?.pendingBackgroundAgents ?? 0) >= FANOUT_MIN_BACKGROUND_AGENTS) {
    out.push("fanout");
  }
  if (node.type === "checkpoint" && node.taxo?.droppedTokens !== undefined) {
    out.push("saturation_compaction");
  }
  // Eskalacja: zejście z sandboxa (dangerouslyDisableSandbox → unsandboxed),
  // odmowa wykonania narzędzia (toolDenialKind → status denied) albo zmiana trybu
  // uprawnień na luźniejszy (rekordy `permission-mode` → taxo.permEscalation tury).
  // ponytail: attachment command_permissions (T3: 2×) nadal nieobsłużony — dodać,
  // gdy pojawi się w realnych danych częściej.
  if (node.sandbox.isolation === "unsandboxed" || node.meta.status === "denied" || node.taxo?.permEscalation !== undefined) {
    out.push("escalation");
  }
  if (node.taxo?.gateBlocked === true) out.push("gate_block");
  if (node.meta.status === "interrupted") out.push("interrupted");
  if (node.taxo?.newDiagnostics === true) out.push("diagnostics_regression");
  return out;
}

/** Przypisanie wzorców całemu grafowi: id węzła → lista wzorców (bez pustych wpisów). */
export function detectPatterns(nodes: readonly GraphNode[]): Map<string, PatternId[]> {
  const out = new Map<string, PatternId[]>();
  for (const node of nodes) {
    const patterns = patternsForNode(node);
    if (patterns.length > 0) out.set(node.id, patterns);
  }
  return out;
}

/** Jedno wywołanie narzędzia w porządku emisji — wejście detekcji `retried`. */
export interface ToolCallSeqEntry {
  nodeId: string;
  /** Klucz tożsamości wywołania: nazwa narzędzia + JSON inputu. */
  key: string;
  isError: boolean;
}

/**
 * Status `retried` (§4): błędne wywołanie, po którym w sesji wystąpił
 * identyczny bliźniak (ta sama nazwa + identyczny input). Zwraca id węzłów,
 * którym parser ma przestawić status z error_tool na retried.
 */
export function detectRetried(seq: readonly ToolCallSeqEntry[]): Set<string> {
  const lastIndexByKey = new Map<string, number>();
  seq.forEach((entry, i) => lastIndexByKey.set(entry.key, i));
  const out = new Set<string>();
  seq.forEach((entry, i) => {
    if (entry.isError && (lastIndexByKey.get(entry.key) ?? i) > i) out.add(entry.nodeId);
  });
  return out;
}
