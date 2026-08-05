// Standardowy słownik etykiet taksonomii (docs/plany/2026-08-05-taksonomia.md §6):
// identyfikator EN w kodzie, etykieta PL w interfejsie. Kolory wyłącznie przez
// tokeny CSS `--gb-*` (index.css) — decyzja D5: czerwień TYLKO dla realnych awarii.

import type { GraphNodeType, NodeStatus, PatternId } from "./parser/types";

/** Typy węzłów: etykieta PL + ikona + token koloru akcentu karty. */
export const NODE_TYPE_META: Record<GraphNodeType, { pl: string; icon: string; accent: string }> = {
  session: { pl: "Sesja", icon: "◆", accent: "var(--gb-type-session)" },
  agent: { pl: "Agent", icon: "●", accent: "var(--gb-type-agent)" },
  tool_call: { pl: "Wywołanie", icon: "▸", accent: "var(--gb-type-tool)" },
  file: { pl: "Plik", icon: "▤", accent: "var(--gb-type-file)" },
  turn: { pl: "Tura", icon: "◷", accent: "var(--gb-type-turn)" },
  task: { pl: "Zadanie", icon: "☑", accent: "var(--gb-type-task)" },
  checkpoint: { pl: "Punkt kontrolny", icon: "⎋", accent: "var(--gb-type-checkpoint)" },
};

/** Statusy: etykieta PL + token koloru kropki. Czerwień tylko error_tool/error_api (D5). */
export const STATUS_META: Record<NodeStatus, { pl: string; color: string }> = {
  ok: { pl: "wykonane", color: "var(--gb-status-ok)" },
  error_tool: { pl: "błąd narzędzia", color: "var(--gb-status-error)" },
  error_api: { pl: "błąd API", color: "var(--gb-status-error)" },
  interrupted: { pl: "przerwane", color: "var(--gb-status-interrupted)" },
  denied: { pl: "odmowa", color: "var(--gb-status-denied)" },
  in_progress: { pl: "w toku", color: "var(--gb-status-in-progress)" },
  retried: { pl: "ponowione", color: "var(--gb-status-retried)" },
  abandoned: { pl: "porzucone", color: "var(--gb-status-abandoned)" },
  unknown: { pl: "nieznany", color: "var(--gb-status-unknown)" },
};

/** Wzorce pewne: etykieta badge'a PL + opis do tooltipa/panelu. */
export const PATTERN_META: Record<PatternId, { badge: string; desc: string }> = {
  fanout: { badge: "rozgałęzienie", desc: "równoległy dispatch agentów w tle" },
  saturation_compaction: { badge: "kompakcja", desc: "kontekst przepełniony, część historii odrzucona" },
  escalation: { badge: "eskalacja", desc: "zejście z sandboxa lub poluzowanie uprawnień" },
  gate_block: { badge: "bramka", desc: "hook zablokował zakończenie tury" },
  interrupted: { badge: "przerwanie", desc: "wykonanie przerwane przez użytkownika" },
  diagnostics_regression: { badge: "regresja", desc: "nowa diagnostyka po edycji" },
};
