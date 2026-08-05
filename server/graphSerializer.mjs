// Kompaktowa serializacja grafu sesji do TSV — plan mierzył 750–5900 tokenów
// (docs/plany/2026-08-05-endpoint-i-czat.md §3), ale na parserze sprzed sklejania
// sidecarów; po fazie 0 sesja orkiestracyjna (699 węzłów) daje ~10,5 tys. tokenów
// (pomiar 2026-08-05, kb lessons/glassbox-budzet-po-zmianie-zrodla). Trzy decyzje
// redukujące: identyfikatory sekwencyjne n0…nN, offset sekundowy zamiast ISO 8601,
// pominięcie wartości domyślnych (status ok, zerowe liczniki). Mapa nX → oryginalne
// id wraca do wywołującego, bo get_node_detail i highlight_nodes muszą trafić
// we właściwy węzeł.

import { MAIN_AGENT_ID, projectGraph } from "../src/layout/collapse.ts";

const LABEL_LIMIT = 40;
/** Pułap pól pełnego detalu w drill-downie — chroni okno kontekstu rozmowy. */
const FULL_FIELD_LIMIT = 16000;

const TYPE_CHAR = {
  session: "s",
  agent: "a",
  tool_call: "t",
  file: "f",
  turn: "u",
  task: "k",
  checkpoint: "c",
};
const EDGE_CHAR = { spawns: "s", calls: "c", touches: "t" };

/** Legenda formatu — doklejana do odpowiedzi narzędzia, żeby TSV był samoopisowy. */
export const TSV_LEGEND =
  "# węzeł: id\ttyp(s=session a=agent t=tool f=file u=turn k=task c=checkpoint)\tlabel\tmodel(tylko s/a — reszta dziedziczy po agencie)\ttokIn\ttokOut\tstatus(puste=ok)\toffsetSek\tizolacja\tagregat\n" +
  "# agregat (tylko zwinięty agent): calls=N files=N errors=N agents=N cost=$X pat=wzorzec:N,… — poddrzewo schowane, rozwiń przez expand:[id]\n" +
  "# krawędź: typ(s=spawns c=calls t=touches)\tźródło\tcel";

function cleanLabel(text) {
  return String(text ?? "")
    .replace(/[\t\n\r]+/g, " ")
    .slice(0, LABEL_LIMIT);
}

function toEpoch(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Ucina wiersz z prawej: puste kolumny na końcu nie kosztują tabów. */
function row(fields) {
  return fields.join("\t").replace(/\t+$/, "");
}

/** Numeracja nX ZAWSZE z pełnego grafu — spójna między rzutem zwiniętym,
 *  pełnym TSV, get_node_detail i highlight_nodes. */
export function buildIdMaps(graph) {
  const idMap = new Map();
  const reverse = new Map();
  graph.nodes.forEach((node, i) => {
    idMap.set(`n${i}`, node.id);
    reverse.set(node.id, `n${i}`);
  });
  return { idMap, reverse };
}

function nodeRow(node, nid, start, aggregate = "") {
  const epoch = toEpoch(node.meta.timestamp);
  const offset =
    Number.isFinite(start) && Number.isFinite(epoch) ? String(Math.round((epoch - start) / 1000)) : "";
  // Model tylko na session/agent — tool call dziedziczy model po agencie, a jego
  // powtarzanie w tysiącach wierszy kosztowało ~3,5 tys. tokenów (pomiar 2026-08-05).
  const model = node.type === "session" || node.type === "agent" ? (node.meta.model ?? "") : "";
  return row([
    nid,
    TYPE_CHAR[node.type] ?? "?",
    cleanLabel(node.label),
    model,
    node.meta.tokensIn ? String(node.meta.tokensIn) : "",
    node.meta.tokensOut ? String(node.meta.tokensOut) : "",
    node.meta.status === "ok" ? "" : node.meta.status,
    offset,
    node.sandbox?.isolation ?? "",
    aggregate,
  ]);
}

function edgeRows(edges, reverse) {
  const lines = [];
  for (const edge of edges) {
    const s = reverse.get(edge.source);
    const t = reverse.get(edge.target);
    if (s === undefined || t === undefined) continue; // krawędź do nieznanego węzła — pomijamy uczciwie
    lines.push(row([EDGE_CHAR[edge.type] ?? "?", s, t]));
  }
  return lines;
}

/**
 * Pełny płaski TSV (wszystkie węzły) — rośnie liniowo z liczbą wywołań, więc
 * na dużych sesjach rozsadza budżet; domyślnym wynikiem narzędzia MCP jest
 * serializeProjection. Zostaje jako podstawa map identyfikatorów i drill-downu.
 * @param {import('../src/parser/types.ts').SessionGraph} graph
 * @returns {{ tsv: string, idMap: Map<string, string>, reverse: Map<string, string> }}
 *   idMap: "n7" → oryginalne id; reverse: oryginalne id → "n7".
 */
export function serializeCompact(graph) {
  const { idMap, reverse } = buildIdMaps(graph);
  const start = toEpoch(graph.meta.startedAt);
  const lines = graph.nodes.map((node) => nodeRow(node, reverse.get(node.id), start));
  lines.push(...edgeRows(graph.edges, reverse));
  return { tsv: lines.join("\n"), idMap, reverse };
}

/** Agregat zwiniętego agenta w jednej kolumnie (pola zerowe pominięte). */
function aggregateColumn(agg) {
  if (!agg) return "";
  const parts = [`calls=${agg.toolCalls}`];
  if (agg.files) parts.push(`files=${agg.files}`);
  if (agg.errors) parts.push(`errors=${agg.errors}`);
  if (agg.agents) parts.push(`agents=${agg.agents}`);
  const total = agg.cost?.cost?.total ?? 0;
  if (total > 0) parts.push(`cost=$${total.toFixed(2)}${agg.cost.partial ? "+" : ""}`);
  const pat = Object.entries(agg.patterns ?? {})
    .map(([p, n]) => `${p}:${n}`)
    .join(",");
  if (pat) parts.push(`pat=${pat}`);
  return parts.join(" ");
}

/**
 * Rzut zwinięty grafu (domyślny wynik get_session_graph): kręgosłub sesji jak
 * w widoku domyślnym UI — session → main z własną pracą → subagenci zwinięci do
 * jednego wiersza z agregatami poddrzewa. Wynik skaluje się z pracą maina
 * i liczbą AGENTÓW, nie wywołań (5962 węzły pełne → 1071 w rzucie, pomiar
 * 2026-08-05). `expandedIds` (oryginalne id agentów) rozwija wskazane poddrzewa;
 * numeracja nX pozostaje ta sama co w serializeCompact.
 * @param {import('../src/parser/types.ts').SessionGraph} graph
 * @param {string[]} [expandedIds]
 * @returns {{ tsv: string, idMap: Map<string, string>, reverse: Map<string, string>, visibleNodes: import('../src/parser/types.ts').GraphNode[] }}
 */
export function serializeProjection(graph, expandedIds = []) {
  const { idMap, reverse } = buildIdMaps(graph);
  const start = toEpoch(graph.meta.startedAt);
  const projected = projectGraph(graph.nodes, graph.edges, new Set([MAIN_AGENT_ID, ...expandedIds]));
  const lines = projected.nodes.map((pn) =>
    nodeRow(pn.node, reverse.get(pn.node.id), start, pn.collapsed ? aggregateColumn(pn.aggregates) : ""),
  );
  lines.push(...edgeRows(projected.edges, reverse));
  return {
    tsv: lines.join("\n"),
    idMap,
    reverse,
    visibleNodes: projected.nodes.map((pn) => pn.node),
  };
}

function capText(text) {
  const s = String(text ?? "");
  return s.length > FULL_FIELD_LIMIT ? `${s.slice(0, FULL_FIELD_LIMIT)}… [ucięte: ${s.length} znaków]` : s;
}

/**
 * Drill-down jednego węzła: pełny detail/output (z pułapem FULL_FIELD_LIMIT),
 * sandbox, wzorce i sąsiedztwo. Identyfikatory sąsiadów mapowane na nX przez
 * `reverse` z serializeCompact tej samej sesji.
 * @param {import('../src/parser/types.ts').SessionGraph} graph
 * @param {string} nodeId oryginalne id węzła
 * @param {Map<string, string>} reverse oryginalne id → nX
 */
export function serializeNode(graph, nodeId, reverse) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const full = graph.details.get(nodeId) ?? null;
  const neighbors = [];
  for (const e of graph.edges) {
    if (e.source === nodeId) neighbors.push({ dir: "out", type: e.type, id: reverse.get(e.target) ?? e.target });
    else if (e.target === nodeId) neighbors.push({ dir: "in", type: e.type, id: reverse.get(e.source) ?? e.source });
  }
  return {
    id: reverse.get(nodeId) ?? nodeId,
    original_id: nodeId,
    type: node.type,
    label: node.label,
    detail: node.detail,
    output: node.output,
    meta: node.meta,
    sandbox: node.sandbox,
    patterns: node.patterns,
    taxo: node.taxo ?? null,
    full: full
      ? {
          input: capText(full.input),
          output: capText(full.output),
          toolUseResult: full.toolUseResult == null ? null : capText(JSON.stringify(full.toolUseResult)),
        }
      : null,
    neighbors,
  };
}
