// Testy serializacji TSV: odwracalność mapy identyfikatorów, pominięcie wartości
// domyślnych i budżet tokenów (realny transkrypt przez GLASSBOX_REAL_TRANSCRIPT —
// NIGDY nie kopiowany do repo).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSession } from "../src/parser/index.ts";
import { readSubagentSidecars } from "./subagents.mjs";
import { serializeCompact, serializeNode, serializeProjection } from "./graphSerializer.mjs";

const REAL_TRANSCRIPT = process.env.GLASSBOX_REAL_TRANSCRIPT ?? "";

/** Przelicznik z planu (§3): ~3,5 bajta na token. */
const BYTES_PER_TOKEN = 3.5;
// Budżet egzekwowany na RZUCIE ZWINIĘTYM (domyślny wynik get_session_graph):
// największa sesja z dysku (79 sidecarów, 5962 węzły pełne → 1071 w rzucie)
// zmierzona 2026-08-05 na ~13 tys. tokenów. Pełny płaski TSV tej sesji to
// ~100 tys. tokenów — dlatego NIE jest domyślnym wynikiem narzędzia
// (kb lessons/glassbox-budzet-po-zmianie-zrodla).
const TOKEN_BUDGET = 16000;

const sampleRaw = readFileSync(new URL("../public/sample.jsonl", import.meta.url), "utf-8");

describe("serializeCompact", () => {
  const graph = parseSession(sampleRaw);
  const { tsv, idMap, reverse } = serializeCompact(graph);

  it("mapa identyfikatorów jest odwracalna i pokrywa wszystkie węzły", () => {
    expect(idMap.size).toBe(graph.nodes.length);
    expect(reverse.size).toBe(graph.nodes.length);
    for (const [nid, orig] of idMap) {
      expect(reverse.get(orig)).toBe(nid);
    }
    // każdy wiersz węzła zaczyna się od nX obecnego w mapie
    const nodeLines = tsv.split("\n").slice(0, graph.nodes.length);
    for (const line of nodeLines) {
      expect(idMap.has(line.split("\t")[0])).toBe(true);
    }
  });

  it("wiersze węzłów i krawędzi mają zadany format, defaulty pominięte", () => {
    const lines = tsv.split("\n");
    expect(lines.length).toBe(graph.nodes.length + graph.edges.length);
    // status ok nie pojawia się w TSV (puste = ok)
    expect(tsv).not.toMatch(/\tok(\t|$)/);
    // krawędzie: pierwsza litera typu + dwa identyfikatory nX
    const edgeLines = lines.slice(graph.nodes.length);
    for (const line of edgeLines) {
      expect(line).toMatch(/^[sct]\tn\d+\tn\d+$/);
    }
    // etykiety bez tabów/nowych linii, max 40 znaków
    for (const line of lines.slice(0, graph.nodes.length)) {
      const label = line.split("\t")[2] ?? "";
      expect(label.length).toBeLessThanOrEqual(40);
      expect(label).not.toMatch(/[\n\r]/);
    }
  });

  it("status inny niż ok i izolacja są obecne w wierszu", () => {
    const errNode = graph.nodes.find((n) => n.meta.status === "error_tool");
    expect(errNode).toBeDefined();
    const nid = reverse.get(errNode.id);
    const line = tsv.split("\n").find((l) => l.startsWith(`${nid}\t`));
    expect(line).toContain("error_tool");

    const worktree = graph.nodes.find((n) => n.sandbox.isolation === "worktree");
    expect(worktree).toBeDefined();
    const wLine = tsv.split("\n").find((l) => l.startsWith(`${reverse.get(worktree.id)}\t`));
    expect(wLine.endsWith("worktree")).toBe(true);
  });
});

describe("serializeProjection", () => {
  const graph = parseSession(sampleRaw);
  const { reverse } = serializeCompact(graph);

  it("rzut zwinięty jest mniejszy od pełnego grafu i niesie agregaty subagentów", () => {
    const proj = serializeProjection(graph);
    expect(proj.visibleNodes.length).toBeLessThan(graph.nodes.length);
    // zwinięty subagent = jeden wiersz z kolumną agregatu calls=
    const aggLines = proj.tsv.split("\n").filter((l) => l.includes("calls="));
    expect(aggLines.length).toBeGreaterThan(0);
    // main jest rozwinięty — nie ma agregatu
    const mainLine = proj.tsv.split("\n").find((l) => l.startsWith(`${reverse.get("agent-main")}\t`));
    expect(mainLine).not.toContain("calls=");
  });

  it("numeracja nX w rzucie jest zgodna z pełnym grafem", () => {
    const proj = serializeProjection(graph);
    for (const node of proj.visibleNodes) {
      const nid = reverse.get(node.id);
      expect(proj.tsv.split("\n").some((l) => l.startsWith(`${nid}\t`))).toBe(true);
    }
  });

  it("expand rozwija poddrzewo wskazanego agenta", () => {
    const collapsed = serializeProjection(graph);
    const sub = graph.nodes.find((n) => n.type === "agent" && n.id !== "agent-main");
    const expanded = serializeProjection(graph, [sub.id]);
    expect(expanded.visibleNodes.length).toBeGreaterThan(collapsed.visibleNodes.length);
    // rozwinięty agent traci kolumnę agregatu
    const line = expanded.tsv.split("\n").find((l) => l.startsWith(`${reverse.get(sub.id)}\t`));
    expect(line).not.toContain("calls=");
  });
});

describe("serializeNode", () => {
  const graph = parseSession(sampleRaw);
  const { idMap, reverse } = serializeCompact(graph);

  it("zwraca pełny detal z sąsiedztwem w identyfikatorach nX", () => {
    const toolNode = graph.nodes.find((n) => n.type === "tool_call");
    const out = serializeNode(graph, toolNode.id, reverse);
    expect(out.id).toBe(reverse.get(toolNode.id));
    expect(out.original_id).toBe(toolNode.id);
    expect(out.neighbors.length).toBeGreaterThan(0);
    for (const nb of out.neighbors) {
      expect(idMap.has(nb.id)).toBe(true);
    }
  });

  it("nieznany węzeł → null", () => {
    expect(serializeNode(graph, "nie-ma-takiego", reverse)).toBeNull();
  });
});

describe("budżet tokenów — realny transkrypt", () => {
  const maybeIt = REAL_TRANSCRIPT ? it : it.skip;

  maybeIt(`rzut zwinięty realnej sesji mieści się w ${TOKEN_BUDGET} tokenach`, () => {
    const raw = readFileSync(REAL_TRANSCRIPT, "utf-8");
    // Sidecary sklejone jak w serwerze MCP — budżet mierzy pełny graf, nie 20% prawdy.
    const graph = parseSession(raw, readSubagentSidecars(REAL_TRANSCRIPT));
    const { tsv, visibleNodes } = serializeProjection(graph);
    const tokens = Buffer.byteLength(tsv, "utf-8") / BYTES_PER_TOKEN;
    console.log(
      `[real] rzut TSV: ${tsv.length} znaków ≈ ${Math.round(tokens)} tokenów ` +
        `(rzut ${visibleNodes.length}/${graph.nodes.length} węzłów)`,
    );
    expect(tokens).toBeLessThan(TOKEN_BUDGET);
  });
});
