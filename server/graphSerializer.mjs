// Kompaktowa serializacja grafu sesji do TSV — plan mierzył 750–5900 tokenów
// (docs/plany/2026-08-05-endpoint-i-czat.md §3), ale na parserze sprzed sklejania
// sidecarów; po fazie 0 sesja orkiestracyjna (699 węzłów) daje ~10,5 tys. tokenów
// (pomiar 2026-08-05, kb lessons/glassbox-budzet-po-zmianie-zrodla). Trzy decyzje
// redukujące: identyfikatory sekwencyjne n0…nN, offset sekundowy zamiast ISO 8601,
// pominięcie wartości domyślnych (status ok, zerowe liczniki). Mapa nX → oryginalne
// id wraca do wywołującego, bo get_node_detail i highlight_nodes muszą trafić
// we właściwy węzeł.

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
  "# węzeł: id\ttyp(s=session a=agent t=tool f=file u=turn k=task c=checkpoint)\tlabel\tmodel\ttokIn\ttokOut\tstatus(puste=ok)\toffsetSek\tizolacja\n" +
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

/**
 * @param {import('../src/parser/types.ts').SessionGraph} graph
 * @returns {{ tsv: string, idMap: Map<string, string>, reverse: Map<string, string> }}
 *   idMap: "n7" → oryginalne id; reverse: oryginalne id → "n7".
 */
export function serializeCompact(graph) {
  const idMap = new Map();
  const reverse = new Map();
  const start = toEpoch(graph.meta.startedAt);
  const lines = [];

  graph.nodes.forEach((node, i) => {
    const nid = `n${i}`;
    idMap.set(nid, node.id);
    reverse.set(node.id, nid);
    const epoch = toEpoch(node.meta.timestamp);
    const offset =
      Number.isFinite(start) && Number.isFinite(epoch) ? String(Math.round((epoch - start) / 1000)) : "";
    lines.push(
      row([
        nid,
        TYPE_CHAR[node.type] ?? "?",
        cleanLabel(node.label),
        node.meta.model ?? "",
        node.meta.tokensIn ? String(node.meta.tokensIn) : "",
        node.meta.tokensOut ? String(node.meta.tokensOut) : "",
        node.meta.status === "ok" ? "" : node.meta.status,
        offset,
        node.sandbox?.isolation ?? "",
      ]),
    );
  });

  for (const edge of graph.edges) {
    const s = reverse.get(edge.source);
    const t = reverse.get(edge.target);
    if (s === undefined || t === undefined) continue; // krawędź do nieznanego węzła — pomijamy uczciwie
    lines.push(row([EDGE_CHAR[edge.type] ?? "?", s, t]));
  }

  return { tsv: lines.join("\n"), idMap, reverse };
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
