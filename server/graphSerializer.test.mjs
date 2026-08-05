// Testy serializacji TSV: odwracalność mapy identyfikatorów, pominięcie wartości
// domyślnych i budżet tokenów (realny transkrypt przez GLASSBOX_REAL_TRANSCRIPT —
// NIGDY nie kopiowany do repo).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSession } from "../src/parser/index.ts";
import { readSubagentSidecars } from "./subagents.mjs";
import { serializeCompact, serializeNode } from "./graphSerializer.mjs";

const REAL_TRANSCRIPT = process.env.GLASSBOX_REAL_TRANSCRIPT ?? "";

/** Przelicznik z planu (§3): ~3,5 bajta na token. */
const BYTES_PER_TOKEN = 3.5;
// Plan zakładał 8000 przy parserze jednoplikowym; po sklejeniu sidecarów sesja
// orkiestracyjna (699 węzłów) zmierzona na ~10 552 tok. — sufit 16 000 jako
// asercja regresji formatu, nie powrót do starych widełek
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

  maybeIt(`kompakt realnej sesji mieści się w ${TOKEN_BUDGET} tokenach`, () => {
    const raw = readFileSync(REAL_TRANSCRIPT, "utf-8");
    // Sidecary sklejone jak w serwerze MCP — budżet mierzy pełny graf, nie 20% prawdy.
    const graph = parseSession(raw, readSubagentSidecars(REAL_TRANSCRIPT));
    const { tsv } = serializeCompact(graph);
    const tokens = Buffer.byteLength(tsv, "utf-8") / BYTES_PER_TOKEN;
    console.log(`[real] TSV: ${tsv.length} znaków ≈ ${Math.round(tokens)} tokenów (węzły: ${graph.nodes.length})`);
    expect(tokens).toBeLessThan(TOKEN_BUDGET);
  });
});
