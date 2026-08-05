import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSession } from "./parseSession.ts";

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
});
