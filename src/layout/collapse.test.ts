import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSession } from "../parser/parseSession.ts";
import type { GraphEdge, GraphNode, SubagentSidecar } from "../parser/types.ts";
import { NO_SANDBOX_INFO } from "../parser/sandbox.ts";
import { MAIN_AGENT_ID, buildHierarchy, filterErrorsOnly, lodForZoom, projectGraph } from "./collapse.ts";
import { layoutProjected } from "./elkLayout.ts";

// --- Syntetyczny graf: session → main → (t1→fileA, sub1[→t2→fileA, sub2[→t3]]) ---

function node(id: string, type: GraphNode["type"], status: GraphNode["meta"]["status"] = "ok", model: string | null = null): GraphNode {
  return {
    id,
    type,
    label: id,
    detail: `detal ${id}`,
    output: "",
    meta: {
      timestamp: null,
      tokensIn: type === "agent" ? 100 : 0,
      tokensOut: type === "agent" ? 10 : 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      model,
      status,
    },
    sandbox: NO_SANDBOX_INFO,
    patterns: [],
  };
}

let edgeId = 0;
function edge(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  edgeId += 1;
  return { id: `e${edgeId}`, type, source, target };
}

const NODES: GraphNode[] = [
  node("session", "session"),
  node(MAIN_AGENT_ID, "agent", "ok", "claude-opus-5"),
  node("t1", "tool_call"),
  node("fileA", "file"),
  node("sub1", "agent", "ok", "claude-sonnet-5"),
  node("t2", "tool_call", "error_tool"),
  node("sub2", "agent", "ok", "claude-haiku-4-5"),
  node("t3", "tool_call"),
];

const EDGES: GraphEdge[] = [
  edge("spawns", "session", MAIN_AGENT_ID),
  edge("calls", MAIN_AGENT_ID, "t1"),
  edge("touches", "t1", "fileA"),
  edge("spawns", MAIN_AGENT_ID, "sub1"),
  edge("calls", "sub1", "t2"),
  edge("touches", "t2", "fileA"),
  edge("spawns", "sub1", "sub2"),
  edge("calls", "sub2", "t3"),
];

/** Rodzic (rozwinięty agent) musi wystąpić w tablicy PRZED swoim dzieckiem. */
function expectParentsBeforeChildren(projected: ReturnType<typeof projectGraph>) {
  const indexById = new Map(projected.nodes.map((pn, i) => [pn.node.id, i]));
  for (const pn of projected.nodes) {
    if (pn.parentAgentId === null) continue;
    const parentIndex = indexById.get(pn.parentAgentId);
    expect(parentIndex).toBeDefined();
    expect(parentIndex!).toBeLessThan(indexById.get(pn.node.id)!);
  }
}

describe("buildHierarchy", () => {
  it("indeksuje spawns/calls/touches w mapy rodzic→dzieci", () => {
    const h = buildHierarchy(EDGES);
    expect(h.childAgents.get("session")).toEqual([MAIN_AGENT_ID]);
    expect(h.childAgents.get(MAIN_AGENT_ID)).toEqual(["sub1"]);
    expect(h.agentTools.get("sub1")).toEqual(["t2"]);
    expect(h.toolFiles.get("t1")).toEqual(["fileA"]);
  });
});

describe("projectGraph", () => {
  it("widok domyślny: kręgosłup session→main z pracą maina i zwiniętymi subagentami", () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID]));
    const ids = projected.nodes.map((pn) => pn.node.id);

    expect(ids).toEqual(["session", MAIN_AGENT_ID, "t1", "fileA", "sub1"]);
    // Praca zwiniętego sub1 (t2, sub2, t3) nie wchodzi do rzutu W OGÓLE (nie `hidden`).
    expect(ids).not.toContain("t2");
    expect(ids).not.toContain("sub2");

    const sub1 = projected.nodes.find((pn) => pn.node.id === "sub1")!;
    expect(sub1.collapsed).toBe(true);
    expect(sub1.parentAgentId).toBe(MAIN_AGENT_ID);

    // Krawędzie tylko między widocznymi węzłami.
    const visible = new Set(ids);
    for (const e of projected.edges) {
      expect(visible.has(e.source)).toBe(true);
      expect(visible.has(e.target)).toBe(true);
    }
    expectParentsBeforeChildren(projected);
  });

  it("agregaty węzła zbiorczego liczą poddrzewo rekurencyjnie (tool calle, błędy, pliki, agenci, koszt)", () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID]));
    const sub1 = projected.nodes.find((pn) => pn.node.id === "sub1")!;
    const agg = sub1.aggregates!;

    expect(agg.toolCalls).toBe(2); // t2 + t3 (z zagnieżdżonego sub2)
    expect(agg.errors).toBe(1); // t2
    expect(agg.files).toBe(1); // fileA
    expect(agg.agents).toBe(1); // sub2
    // Koszt poddrzewa: sub1 (sonnet) + sub2 (haiku), tokeny 2×(100 we / 10 wy).
    expect(agg.cost.tokensIn).toBe(200);
    expect(agg.cost.tokensOut).toBe(10 * 2);
    expect(agg.cost.cost.total).toBeGreaterThan(0);
    expect(agg.cost.partial).toBe(false);
  });

  it("rozwinięcie subagenta dokłada jego pracę i pokazuje zagnieżdżonych jako zwiniętych", () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID, "sub1"]));
    const ids = projected.nodes.map((pn) => pn.node.id);

    expect(ids).toContain("t2");
    expect(ids).toContain("sub2");
    expect(ids).not.toContain("t3"); // sub2 nadal zwinięty

    const t2 = projected.nodes.find((pn) => pn.node.id === "t2")!;
    expect(t2.parentAgentId).toBe("sub1");
    const sub2 = projected.nodes.find((pn) => pn.node.id === "sub2")!;
    expect(sub2.collapsed).toBe(true);
    expect(sub2.parentAgentId).toBe("sub1");

    // Plik współdzielony zostaje w pierwszej grupie (main), bez duplikatu.
    expect(ids.filter((id) => id === "fileA").length).toBe(1);
    // Krawędź touches t2→fileA przekracza grupy, ale oba końce są widoczne.
    expect(projected.edges.some((e) => e.source === "t2" && e.target === "fileA")).toBe(true);
    expectParentsBeforeChildren(projected);
  });

  it("zwinięcie WSZYSTKIEGO (nawet maina) zostawia sam kręgosłup session→main", () => {
    const projected = projectGraph(NODES, EDGES, new Set());
    expect(projected.nodes.map((pn) => pn.node.id)).toEqual(["session", MAIN_AGENT_ID]);
    const main = projected.nodes.find((pn) => pn.node.id === MAIN_AGENT_ID)!;
    expect(main.collapsed).toBe(true);
    expect(main.aggregates!.toolCalls).toBe(3); // t1 + t2 + t3 — nic nie ginie z liczników
    expect(main.aggregates!.agents).toBe(2); // sub1 + sub2
  });
});

describe("layoutProjected — layout zagnieżdżony ELK", () => {
  it("rozwinięty agent to grupa-rodzic PRZED dziećmi, z pozycjami względnymi wewnątrz obrysu", async () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID, "sub1"]));
    const { nodes, edges } = await layoutProjected(projected);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const grpMain = byId.get(`grp-${MAIN_AGENT_ID}`)!;
    const grpSub1 = byId.get("grp-sub1")!;
    expect(grpMain.type).toBe("agentGroup");
    expect(grpSub1.parentId).toBe(`grp-${MAIN_AGENT_ID}`); // grupa zagnieżdżona w grupie

    // Rodzic przed dzieckiem w tablicy — twardy wymóg React Flow dla parentId.
    const indexById = new Map(nodes.map((n, i) => [n.id, i]));
    for (const n of nodes) {
      if (n.parentId) expect(indexById.get(n.parentId)!).toBeLessThan(indexById.get(n.id)!);
    }

    // Dzieci mieszczą się w obrysie rodzica (pozycje względne + rozmiar grupy z ELK).
    const w = grpSub1.style?.width as number;
    const h = grpSub1.style?.height as number;
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    for (const n of nodes.filter((n) => n.parentId === "grp-sub1")) {
      expect(n.position.x).toBeGreaterThanOrEqual(0);
      expect(n.position.y).toBeGreaterThanOrEqual(0);
      expect(n.position.x + 220).toBeLessThanOrEqual(w + 1);
    }

    // Krawędzie seq są tylko dla ELK — do React Flow nie wychodzą.
    expect(edges.every((e) => !e.id.startsWith("seq-"))).toBe(true);
    // Krawędzie rzutu przechodzą 1:1.
    expect(edges.length).toBe(projected.edges.length);
  });

  it("węzły zbiorcze są zwykłymi kartami (bez grupy)", async () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID]));
    const { nodes } = await layoutProjected(projected);
    expect(nodes.some((n) => n.id === "grp-sub1")).toBe(false);
    const sub1 = nodes.find((n) => n.id === "sub1")!;
    expect(sub1.type).toBe("agent");
    expect((sub1.data as { collapsed?: boolean }).collapsed).toBe(true);
  });
});

describe("projectGraph — węzły taksonomii i wzorce w agregatach", () => {
  // main ma turę z fanoutem i checkpoint kompakcji; t2 (error) żyje w zwiniętym sub1.
  const turn = node("turn1", "turn");
  turn.taxo = { pendingBackgroundAgents: 6 };
  turn.patterns = ["fanout"];
  const chk = node("chk1", "checkpoint");
  chk.taxo = { droppedTokens: 1000 };
  chk.patterns = ["saturation_compaction"];
  const taxoNodes = [...NODES, turn, chk];
  const taxoEdges = [...EDGES, edge("calls", MAIN_AGENT_ID, "turn1"), edge("calls", MAIN_AGENT_ID, "chk1")];

  it("turn/checkpoint nie liczą się jako wywołania, ale ich wzorce wchodzą do agregatów", () => {
    const projected = projectGraph(taxoNodes, taxoEdges, new Set());
    const main = projected.nodes.find((pn) => pn.node.id === MAIN_AGENT_ID)!;
    expect(main.aggregates!.toolCalls).toBe(3); // t1+t2+t3 — turn/checkpoint NIE zawyżają
    expect(main.aggregates!.patterns).toEqual({ fanout: 1, saturation_compaction: 1 });
    expect(main.aggregates!.errors).toBe(1); // t2 (error_tool)
  });

  it("rozwinięty main pokazuje węzły taksonomii jako członków grupy", () => {
    const projected = projectGraph(taxoNodes, taxoEdges, new Set([MAIN_AGENT_ID]));
    const ids = projected.nodes.map((pn) => pn.node.id);
    expect(ids).toContain("turn1");
    expect(ids).toContain("chk1");
    expect(projected.nodes.find((pn) => pn.node.id === "turn1")!.parentAgentId).toBe(MAIN_AGENT_ID);
  });
});

describe("filterErrorsOnly — filtr „tylko błędy” na rzucie grafu", () => {
  it("zostawia sesję, awarie i ścieżkę agentów; liczy ukryte", () => {
    // sub1 rozwinięty: t2 (error_tool) widoczny wprost.
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID, "sub1"]));
    const { graph, hiddenCount } = filterErrorsOnly(projected);
    const ids = graph.nodes.map((pn) => pn.node.id);

    expect(ids).toContain("session");
    expect(ids).toContain(MAIN_AGENT_ID); // błąd w poddrzewie → ścieżka przodków zostaje
    expect(ids).toContain("sub1");
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t1"); // ok — ukryty
    expect(ids).not.toContain("fileA");
    expect(ids).not.toContain("sub2"); // bez błędów w poddrzewie
    expect(hiddenCount).toBe(projected.nodes.length - ids.length);
    expect(hiddenCount).toBeGreaterThan(0);

    // Krawędzie spójne po filtrze.
    const visible = new Set(ids);
    for (const e of graph.edges) {
      expect(visible.has(e.source)).toBe(true);
      expect(visible.has(e.target)).toBe(true);
    }
  });

  it("zwinięty agent z błędami w poddrzewie zostaje widoczny z agregatami", () => {
    const projected = projectGraph(NODES, EDGES, new Set([MAIN_AGENT_ID]));
    const { graph } = filterErrorsOnly(projected);
    const sub1 = graph.nodes.find((pn) => pn.node.id === "sub1");
    expect(sub1).toBeDefined();
    expect(sub1!.collapsed).toBe(true);
    expect(sub1!.aggregates!.errors).toBe(1); // licznik z PEŁNEGO poddrzewa, nie z rzutu
  });

  it("graf bez błędów redukuje się do sesji", () => {
    const cleanNodes = NODES.map((n) => (n.id === "t2" ? { ...n, meta: { ...n.meta, status: "ok" as const } } : n));
    const projected = projectGraph(cleanNodes, EDGES, new Set([MAIN_AGENT_ID]));
    const { graph } = filterErrorsOnly(projected);
    expect(graph.nodes.map((pn) => pn.node.id)).toEqual(["session"]);
  });
});

describe("lodForZoom — zoom zmienia LOD karty, nigdy zbiór węzłów", () => {
  it("progi far/mid/near", () => {
    expect(lodForZoom(0.1)).toBe("far");
    expect(lodForZoom(0.6)).toBe("mid");
    expect(lodForZoom(1.5)).toBe("near");
  });
});

// --- Realny transkrypt (env GLASSBOX_REAL_TRANSCRIPT, wzorzec z parseSession.test.ts) ---

const REAL_TRANSCRIPT = process.env.GLASSBOX_REAL_TRANSCRIPT ?? "";

function readSidecars(mainPath: string): SubagentSidecar[] {
  const dir = join(dirname(mainPath), basename(mainPath, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      let meta: Record<string, unknown> | null = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf-8")) as Record<string, unknown>;
      } catch {
        meta = null;
      }
      return { jsonl: readFileSync(join(dir, f), "utf-8"), meta };
    });
}

describe("projectGraph — realny transkrypt", () => {
  let raw: string | null = null;
  try {
    raw = REAL_TRANSCRIPT ? readFileSync(REAL_TRANSCRIPT, "utf-8") : null;
  } catch {
    raw = null;
  }
  const maybeIt = raw ? it : it.skip;

  maybeIt("rzut domyślny redukuje graf, nic nie gubi z liczników i zachowuje spójność", () => {
    const graph = parseSession(raw as string, readSidecars(REAL_TRANSCRIPT));
    const projected = projectGraph(graph.nodes, graph.edges, new Set([MAIN_AGENT_ID]));

    // eslint-disable-next-line no-console
    console.log(`[real] rzut domyślny: ${projected.nodes.length}/${graph.nodes.length} węzłów`);
    expect(projected.nodes.length).toBeLessThan(graph.nodes.length);

    // Liczniki zbiorcze pokrywają CAŁĄ schowaną pracę: suma tool calli widocznych
    // + zagregowanych w zwiniętych agentach == wszystkie tool calle grafu.
    const visibleToolCalls = projected.nodes.filter((pn) => pn.node.type === "tool_call").length;
    const aggregated = projected.nodes
      .filter((pn) => pn.collapsed && pn.aggregates)
      .reduce((sum, pn) => sum + pn.aggregates!.toolCalls, 0);
    expect(visibleToolCalls + aggregated).toBe(graph.meta.toolCallCount);

    const visible = new Set(projected.nodes.map((pn) => pn.node.id));
    for (const e of projected.edges) {
      expect(visible.has(e.source)).toBe(true);
      expect(visible.has(e.target)).toBe(true);
    }
    expectParentsBeforeChildren(projected);

    // Rozwinięcie jednego subagenta z pracą dokłada węzły.
    const firstWithWork = projected.nodes.find((pn) => pn.collapsed && pn.aggregates && pn.aggregates.toolCalls > 0);
    expect(firstWithWork).toBeDefined();
    const expandedOne = projectGraph(graph.nodes, graph.edges, new Set([MAIN_AGENT_ID, firstWithWork!.node.id]));
    expect(expandedOne.nodes.length).toBeGreaterThan(projected.nodes.length);
  });

  maybeIt("filtr „tylko błędy” drastycznie redukuje graf i nie psuje liczników agregatów", () => {
    const graph = parseSession(raw as string, readSidecars(REAL_TRANSCRIPT));
    // Pełne rozwinięcie wszystkich agentów — worst case liczby węzłów.
    const allAgents = new Set(graph.nodes.filter((n) => n.type === "agent").map((n) => n.id));
    const projected = projectGraph(graph.nodes, graph.edges, allAgents);
    const { graph: filtered, hiddenCount } = filterErrorsOnly(projected);

    const patternCounts: Record<string, number> = {};
    for (const n of graph.nodes) for (const p of n.patterns) patternCounts[p] = (patternCounts[p] ?? 0) + 1;
    const statusCounts: Record<string, number> = {};
    for (const n of graph.nodes) statusCounts[n.meta.status] = (statusCounts[n.meta.status] ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.log(
      `[real] filtr błędów: ${projected.nodes.length} → ${filtered.nodes.length} węzłów ` +
        `(${(projected.nodes.length / Math.max(filtered.nodes.length, 1)).toFixed(1)}×, ukryto ${hiddenCount}); ` +
        `statusy=${JSON.stringify(statusCounts)}; wzorce=${JSON.stringify(patternCounts)}`,
    );

    expect(hiddenCount).toBe(projected.nodes.length - filtered.nodes.length);
    // Rząd redukcji z taksonomii (§5: udział błędów 1,5-2,4% → ~50×) — asercja
    // zgrubna: co najmniej 10× na dużej realnej sesji.
    expect(projected.nodes.length / Math.max(filtered.nodes.length, 1)).toBeGreaterThan(10);

    // Spójność krawędzi po filtrze.
    const visible = new Set(filtered.nodes.map((pn) => pn.node.id));
    for (const e of filtered.edges) {
      expect(visible.has(e.source)).toBe(true);
      expect(visible.has(e.target)).toBe(true);
    }
    // Agregaty widocznych zwiniętych agentów nadal liczą PEŁNE poddrzewo.
    for (const pn of filtered.nodes) {
      if (pn.collapsed && pn.aggregates) expect(pn.aggregates.errors).toBeGreaterThan(0);
    }
  });
});
