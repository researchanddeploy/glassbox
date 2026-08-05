import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSession } from "./parseSession.ts";
import type { SubagentSidecar } from "./types.ts";

// Realny transkrypt z dysku — czytany bezpośrednio w teście, NIGDY kopiowany do repo
// (dane prywatne). Ścieżkę podaje env GLASSBOX_REAL_TRANSCRIPT; bez niej test jest pomijany.
const REAL_TRANSCRIPT = process.env.GLASSBOX_REAL_TRANSCRIPT ?? "";

function readTranscript(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Sidecary subagentów: <katalog>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json). */
function readSidecars(mainPath: string): SubagentSidecar[] {
  const dir = join(dirname(mainPath), basename(mainPath, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const metaPath = join(dir, f.replace(/\.jsonl$/, ".meta.json"));
      let meta: Record<string, unknown> | null = null;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
      } catch {
        meta = null;
      }
      return { jsonl: readFileSync(join(dir, f), "utf-8"), meta };
    });
}

/** Liczba agentów z realnie dowiązaną pracą (≥1 własne wywołanie narzędzia). */
function agentsWithWork(graph: ReturnType<typeof parseSession>): number {
  const agentIds = new Set(graph.nodes.filter((n) => n.type === "agent").map((n) => n.id));
  const withCalls = new Set(graph.edges.filter((e) => e.type === "calls" && agentIds.has(e.source)).map((e) => e.source));
  return withCalls.size;
}

describe("parseSession — realny transkrypt", () => {
  const raw = readTranscript(REAL_TRANSCRIPT);
  const maybeIt = raw ? it : it.skip;

  maybeIt("buduje graf z sensownymi węzłami, krawędziami i tokenami", () => {
    const jsonl = raw as string;
    const graph = parseSession(jsonl);

    const agentNodes = graph.nodes.filter((n) => n.type === "agent");
    const toolCallNodes = graph.nodes.filter((n) => n.type === "tool_call");

    expect(agentNodes.length).toBeGreaterThan(0);
    expect(toolCallNodes.length).toBeGreaterThan(0);

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }

    expect(graph.meta.totalTokensIn + graph.meta.totalTokensOut).toBeGreaterThan(0);
  });

  maybeIt("skleja WSZYSTKIE sidecary subagentów (kryterium akceptacji 1/N → N/N)", () => {
    const jsonl = raw as string;
    const sidecars = readSidecars(REAL_TRANSCRIPT);
    expect(sidecars.length).toBeGreaterThan(0); // sesję dobieramy z sidecarami

    const before = parseSession(jsonl);
    const after = parseSession(jsonl, sidecars);

    const workBefore = agentsWithWork(before);
    const workAfter = agentsWithWork(after);
    // eslint-disable-next-line no-console
    console.log(
      `[real] sidecary: ${after.meta.sidecarsAttached}/${sidecars.length} sklejone; ` +
        `agenci z pracą: ${workBefore}/${sidecars.length + 1} przed → ${workAfter}/${sidecars.length + 1} po; ` +
        `tool calle: ${before.meta.toolCallCount} → ${after.meta.toolCallCount}`,
    );

    // Każdy dostarczony sidecar musi trafić do grafu — żaden transkrypt nie ginie.
    expect(after.meta.sidecarsAttached).toBe(sidecars.length);
    expect(workAfter).toBeGreaterThan(workBefore);
    expect(after.meta.toolCallCount).toBeGreaterThan(before.meta.toolCallCount);

    // Spójność krawędzi po sklejeniu.
    const nodeIds = new Set(after.nodes.map((n) => n.id));
    for (const edge of after.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  maybeIt("liczy tokeny cache bez naiwnej sumy po liniach", () => {
    const jsonl = raw as string;
    const graph = parseSession(jsonl);

    expect(graph.meta.totalCacheReadTokens).toBeGreaterThan(0);

    // Pułapka kumulacji: jedna wiadomość bywa rozpisana na wiele linii JSONL,
    // każda z powtórzonym usage. Suma po deduplikacji per message.id musi być
    // ostro mniejsza od naiwnej sumy po liniach.
    let naiveSum = 0;
    for (const line of jsonl.split("\n")) {
      if (!line.includes("cache_read_input_tokens")) continue;
      try {
        const rec = JSON.parse(line) as { message?: { usage?: { cache_read_input_tokens?: number } } };
        naiveSum += rec.message?.usage?.cache_read_input_tokens ?? 0;
      } catch {
        // linia nieparsowalna — pomijamy, jak parser
      }
    }
    expect(graph.meta.totalCacheReadTokens).toBeLessThan(naiveSum);
  });

  maybeIt("widzi rekordy system i attachment", () => {
    const graph = parseSession(raw as string);
    expect(Object.keys(graph.meta.systemSubtypeCounts).length).toBeGreaterThan(0);
    expect(Object.keys(graph.meta.attachmentTypeCounts).length).toBeGreaterThan(0);
  });
});

describe("parseSession — przykład syntetyczny (public/sample.jsonl)", () => {
  const raw = readFileSync(new URL("../../public/sample.jsonl", import.meta.url), "utf-8");

  it("rozpoznaje main agenta, subagentów, tool calle i pliki", () => {
    const graph = parseSession(raw);

    const agentNodes = graph.nodes.filter((n) => n.type === "agent");
    const toolCallNodes = graph.nodes.filter((n) => n.type === "tool_call");
    const fileNodes = graph.nodes.filter((n) => n.type === "file");
    const sessionNodes = graph.nodes.filter((n) => n.type === "session");

    expect(sessionNodes.length).toBe(1);
    // main + 3 subagentów (Explore, general-purpose async, worktree)
    expect(agentNodes.length).toBe(4);
    expect(toolCallNodes.length).toBeGreaterThan(0);
    expect(fileNodes.length).toBe(5); // App.tsx, types.ts (Read), parseSession.ts (Edit), README.md (Write), sandbox.ts (Edit, w worktree)

    const spawnEdges = graph.edges.filter((e) => e.type === "spawns");
    expect(spawnEdges.length).toBe(4); // session->main, main->sub1, main->sub2, main->sub3(worktree)

    const errorTool = toolCallNodes.find((n) => n.meta.status === "error");
    expect(errorTool).toBeDefined();
    expect(errorTool?.label).toBe("Bash");

    // Krawędzie spójne: source/target istnieją
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }

    expect(graph.meta.totalTokensIn).toBeGreaterThan(0);
    expect(graph.meta.totalTokensOut).toBeGreaterThan(0);
    expect(graph.meta.skippedLines).toBeGreaterThan(0); // linia "not valid json {{{"
  });

  it("klasyfikuje izolację/sandbox: worktree-subagent, unsandboxed Bash, network WebFetch", () => {
    const graph = parseSession(raw);

    const worktreeAgent = graph.nodes.find((n) => n.type === "agent" && n.sandbox.isolation === "worktree");
    expect(worktreeAgent).toBeDefined();
    expect(worktreeAgent?.label).toBe("Refaktor w izolowanym worktree");

    const unsandboxedBash = graph.nodes.find(
      (n) => n.type === "tool_call" && n.label === "Bash" && n.sandbox.isolation === "unsandboxed",
    );
    expect(unsandboxedBash).toBeDefined();
    expect(unsandboxedBash?.sandbox.boundaryCrossings).toContain("filesystem-out");

    const networkFetch = graph.nodes.find((n) => n.type === "tool_call" && n.label === "WebFetch");
    expect(networkFetch?.sandbox.boundaryCrossings).toContain("network");

    // Tool calle wewnątrz worktree-subagenta (Edit/Bash) są od niego osiągalne przez calls.
    const worktreeToolIds = graph.edges
      .filter((e) => e.type === "calls" && e.source === worktreeAgent?.id)
      .map((e) => e.target);
    expect(worktreeToolIds.length).toBeGreaterThan(0);
  });

  it("jest odporny na puste/nieznane linie", () => {
    const graph = parseSession("\n\nnot json\n" + raw + "\n{\"type\":\"weird\"}\n");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  it("rozpoznaje statusy in_progress, interrupted i denied", () => {
    const graph = parseSession(raw);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    // Spawn asynchroniczny bez sidecara = praca w toku, nie "ok".
    expect(byId.get("agent-toolu_u-0015")?.meta.status).toBe("in_progress");
    // toolUseResult.interrupted → przerwane, mimo is_error: false.
    expect(byId.get("tool-toolu_u-0041")?.meta.status).toBe("interrupted");
    // toolDenialKind → odmowa, mimo is_error: true (odmowa to nie awaria).
    expect(byId.get("tool-toolu_u-0043")?.meta.status).toBe("denied");
  });

  it("liczy usage raz per message.id (pułapka kumulacji cache)", () => {
    const graph = parseSession(raw);
    // msg_sample_cache jest rozpisany na dwie linie z identycznym usage —
    // cache_read=1000 i cache_creation=200 mają wejść do sumy dokładnie raz.
    expect(graph.meta.totalCacheReadTokens).toBe(1000);
    expect(graph.meta.totalCacheCreationTokens).toBe(200);
    // Podział zapisu cache po TTL (usage.cache_creation) też liczony raz per message.id.
    const main = graph.nodes.find((n) => n.id === "agent-main");
    expect(main?.meta.cacheCreation5mTokens).toBe(50);
    expect(main?.meta.cacheCreation1hTokens).toBe(150);
  });

  it("bez podziału TTL traktuje cały zapis cache jako 5m (domyślny TTL)", () => {
    const line =
      '{"type":"assistant","uuid":"ttl-1","timestamp":"2026-08-05T09:00:00.000Z","message":{"id":"msg_ttl","model":"claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":77}}}';
    const graph = parseSession(line);
    const main = graph.nodes.find((n) => n.id === "agent-main");
    expect(main?.meta.cacheCreationTokens).toBe(77);
    expect(main?.meta.cacheCreation5mTokens).toBe(77);
    expect(main?.meta.cacheCreation1hTokens).toBe(0);
  });

  it("zlicza rekordy system i attachment per subtype/typ", () => {
    const graph = parseSession(raw);
    expect(graph.meta.systemSubtypeCounts).toEqual({ turn_duration: 1, compact_boundary: 1 });
    expect(graph.meta.attachmentTypeCounts).toEqual({ hook_success: 2, diagnostics: 1 });
  });

  it("wystawia pełne szczegóły węzła w details, bez zmiany limitu na karcie", () => {
    const graph = parseSession(raw);

    // Spawn: pełny prompt w details, skrót na karcie.
    const spawnDetail = graph.details.get("agent-toolu_u-0006");
    expect(spawnDetail?.input).toBe("Przejrzyj src/parser i opisz typy węzłów grafu.");

    // toolUseResult surowe w details (tu: interrupted z Bash).
    const bashDetail = graph.details.get("tool-toolu_u-0041");
    expect((bashDetail?.toolUseResult as { interrupted?: boolean })?.interrupted).toBe(true);

    // Karta nadal ucina do DETAIL_LIMIT, details nie.
    for (const node of graph.nodes) {
      expect(node.detail.length).toBeLessThanOrEqual(2001); // 2000 + "…"
    }
  });
});

describe("parseSession — sklejanie sidecarów subagentów (syntetyczne)", () => {
  const raw = readFileSync(new URL("../../public/sample.jsonl", import.meta.url), "utf-8");

  const sidecarA: SubagentSidecar = {
    // Transkrypt asynchronicznego subagenta a99f2c1b0 (spawn toolu_u-0015 w sample).
    jsonl: [
      '{"agentId":"a99f2c1b0","isSidechain":true,"type":"assistant","uuid":"sub-0001","timestamp":"2026-08-05T09:01:10.000Z","message":{"id":"msg_sub_a1","model":"claude-sonnet-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_sub-0001","name":"Write","input":{"file_path":"/repo/src/parser/parseSession.test.ts","content":"// test"}}],"usage":{"input_tokens":50,"output_tokens":20,"cache_read_input_tokens":300}}}',
      '{"agentId":"a99f2c1b0","isSidechain":true,"type":"user","uuid":"sub-0002","timestamp":"2026-08-05T09:01:14.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_sub-0001","content":"Utworzono plik.","is_error":false}]}}',
      '{"agentId":"a99f2c1b0","isSidechain":true,"type":"assistant","uuid":"sub-0003","timestamp":"2026-08-05T09:01:18.000Z","message":{"id":"msg_sub_a2","model":"claude-sonnet-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_sub-0003","name":"Agent","input":{"description":"Zagnieżdżony weryfikator","subagent_type":"Explore","prompt":"Sprawdź test."}}],"usage":{"input_tokens":60,"output_tokens":25}}}',
      '{"agentId":"a99f2c1b0","isSidechain":true,"type":"user","uuid":"sub-0004","timestamp":"2026-08-05T09:01:22.000Z","toolUseResult":{"agentId":"abcnested1","isAsync":true,"status":"async_launched"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_sub-0003","content":"Async agent launched successfully. agentId: abcnested1","is_error":false}]}}',
    ].join("\n"),
    meta: { agentType: "general-purpose", description: "Napisz test parsera", toolUseId: "toolu_u-0015", spawnDepth: 0 },
  };

  const sidecarNested: SubagentSidecar = {
    // Sidecar zagnieżdżony (spawnDepth 1) — rodzic rozpoznawalny dopiero po sklejeniu sidecarA.
    jsonl: [
      '{"agentId":"abcnested1","isSidechain":true,"type":"assistant","uuid":"nest-0001","timestamp":"2026-08-05T09:01:30.000Z","message":{"id":"msg_nest_1","model":"claude-haiku-4-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_nest-0001","name":"Read","input":{"file_path":"/repo/src/parser/parseSession.test.ts"}}],"usage":{"input_tokens":30,"output_tokens":10}}}',
      '{"agentId":"abcnested1","isSidechain":true,"type":"user","uuid":"nest-0002","timestamp":"2026-08-05T09:01:34.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_nest-0001","content":"// test","is_error":false}]}}',
    ].join("\n"),
    meta: { agentType: "Explore", description: "Zagnieżdżony weryfikator", toolUseId: "toolu_sub-0003", parentAgentId: "a99f2c1b0", spawnDepth: 1 },
  };

  const sidecarOrphan: SubagentSidecar = {
    // Teammate bez toolUseId i bez rozpoznawalnego rodzica — ma trafić pod main, nie zginąć.
    jsonl: [
      '{"agentId":"aorphan001","isSidechain":true,"type":"assistant","uuid":"orp-0001","timestamp":"2026-08-05T09:01:40.000Z","message":{"id":"msg_orp_1","model":"claude-sonnet-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_orp-0001","name":"Bash","input":{"command":"echo ok"}}],"usage":{"input_tokens":15,"output_tokens":5}}}',
      '{"agentId":"aorphan001","isSidechain":true,"type":"user","uuid":"orp-0002","timestamp":"2026-08-05T09:01:44.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_orp-0001","content":"ok","is_error":false}]}}',
    ].join("\n"),
    meta: { agentType: "sierota", name: "sierota", taskKind: "in_process_teammate", spawnDepth: 1 },
  };

  it("dowiązuje sidecar po toolUseResult.agentId i domyka status async spawnu", () => {
    const graph = parseSession(raw, [sidecarA]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(graph.meta.sidecarsAttached).toBe(1);
    // Praca subagenta dowiązana do ISTNIEJĄCEGO węzła spawnu (bez duplikatu).
    const callEdges = graph.edges.filter((e) => e.type === "calls" && e.source === "agent-toolu_u-0015");
    expect(callEdges.map((e) => e.target)).toContain("tool-toolu_sub-0001");
    // Async spawn z pełnym transkryptem przestaje być "in_progress".
    expect(byId.get("agent-toolu_u-0015")?.meta.status).toBe("ok");
    // Usage subagenta ląduje na jego węźle, nie na main.
    expect(byId.get("agent-toolu_u-0015")?.meta.tokensIn).toBe(110);
    expect(byId.get("agent-toolu_u-0015")?.meta.cacheReadTokens).toBe(300);
    // Plik dotknięty przez subagenta wchodzi do grafu.
    expect(graph.nodes.some((n) => n.type === "file" && n.detail === "/repo/src/parser/parseSession.test.ts")).toBe(true);
  });

  it("skleja sidecary zagnieżdżone (pętla do punktu stałego) i sieroty pod main", () => {
    // Celowo w odwrotnej kolejności: zagnieżdżony przed rodzicem.
    const graph = parseSession(raw, [sidecarNested, sidecarOrphan, sidecarA]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(graph.meta.sidecarsAttached).toBe(3);

    // Zagnieżdżony dowiązany do węzła spawnu utworzonego w sidecarA.
    const nestedCalls = graph.edges.filter((e) => e.type === "calls" && e.source === "agent-toolu_sub-0003");
    expect(nestedCalls.map((e) => e.target)).toContain("tool-toolu_nest-0001");
    expect(byId.get("agent-toolu_sub-0003")?.meta.status).toBe("ok"); // async domknięty sidecarem

    // Sierota: nowy węzeł agenta pod main.
    const orphanNode = byId.get("agent-aorphan001");
    expect(orphanNode).toBeDefined();
    expect(orphanNode?.label).toBe("sierota");
    expect(graph.edges.some((e) => e.type === "spawns" && e.source === "agent-main" && e.target === "agent-aorphan001")).toBe(true);

    // Nikt nie zginął i nic się nie zdublowało:
    // 4 agentów z sample + zagnieżdżony spawn z sidecarA + 1 sierota.
    expect(graph.nodes.filter((n) => n.type === "agent").length).toBe(6);
  });
});
