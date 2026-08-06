import { describe, expect, it } from "vitest";
import { NO_SANDBOX_INFO } from "./sandbox.ts";
import { detectPatterns, detectRetried, isErrorStatus, patternsForNode } from "./patterns.ts";
import type { GraphNode, NodeStatus } from "./types.ts";

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "tool_call",
    label: partial.id,
    detail: "",
    output: "",
    meta: {
      timestamp: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      model: null,
      status: "ok",
    },
    sandbox: NO_SANDBOX_INFO,
    patterns: [],
    ...partial,
    ...(partial.meta ? { meta: partial.meta } : {}),
  };
}

function withStatus(id: string, status: NodeStatus, extra?: Partial<GraphNode>): GraphNode {
  const n = node({ id, ...extra });
  n.meta.status = status;
  return n;
}

describe("isErrorStatus — czerwień tylko dla realnych awarii (D5)", () => {
  it("awaria: error_tool i error_api; nie-awaria: cała reszta", () => {
    expect(isErrorStatus("error_tool")).toBe(true);
    expect(isErrorStatus("error_api")).toBe(true);
    for (const s of ["ok", "unknown", "in_progress", "interrupted", "denied", "retried", "abandoned"] as const) {
      expect(isErrorStatus(s)).toBe(false);
    }
  });
});

describe("patternsForNode — wzorce pewne, markery wprost z danych", () => {
  it("fanout: tura z pendingBackgroundAgents ≥ 3; poniżej progu brak wzorca", () => {
    expect(patternsForNode(node({ id: "t", type: "turn", taxo: { pendingBackgroundAgents: 6 } }))).toContain("fanout");
    expect(patternsForNode(node({ id: "t", type: "turn", taxo: { pendingBackgroundAgents: 2 } }))).toEqual([]);
  });

  it("saturation_compaction: checkpoint kompakcji (droppedTokens), nie snapshot", () => {
    expect(patternsForNode(node({ id: "c", type: "checkpoint", taxo: { droppedTokens: 138000 } }))).toContain(
      "saturation_compaction",
    );
    expect(patternsForNode(node({ id: "c", type: "checkpoint" }))).toEqual([]);
  });

  it("escalation: unsandboxed, odmowa albo zmiana trybu uprawnień na luźniejszy", () => {
    const unsandboxed = node({ id: "u", sandbox: { isolation: "unsandboxed", boundaryCrossings: ["filesystem-out"] } });
    expect(patternsForNode(unsandboxed)).toContain("escalation");
    expect(patternsForNode(withStatus("d", "denied"))).toContain("escalation");
    expect(
      patternsForNode(node({ id: "p", type: "turn", taxo: { permEscalation: "plan → bypassPermissions" } })),
    ).toContain("escalation");
    expect(patternsForNode(node({ id: "s", sandbox: { isolation: "sandboxed", boundaryCrossings: [] } }))).toEqual([]);
  });

  it("gate_block i interrupted i diagnostics_regression", () => {
    expect(patternsForNode(node({ id: "g", type: "turn", taxo: { gateBlocked: true } }))).toContain("gate_block");
    expect(patternsForNode(withStatus("i", "interrupted"))).toContain("interrupted");
    expect(patternsForNode(node({ id: "e", taxo: { newDiagnostics: true } }))).toContain("diagnostics_regression");
  });
});

describe("detectPatterns", () => {
  it("mapuje tylko węzły z wzorcami (bez pustych wpisów)", () => {
    const nodes = [
      node({ id: "plain" }),
      node({ id: "turn", type: "turn", taxo: { pendingBackgroundAgents: 3, gateBlocked: true } }),
    ];
    const map = detectPatterns(nodes);
    expect(map.has("plain")).toBe(false);
    expect(map.get("turn")).toEqual(["fanout", "gate_block"]);
  });
});

describe("detectRetried — błędne wywołanie z późniejszym identycznym bliźniakiem", () => {
  it("oznacza błąd ponowiony później; ostatnie wystąpienie i inne klucze zostają", () => {
    const retried = detectRetried([
      { nodeId: "a", key: "Bash lint", isError: true },
      { nodeId: "b", key: "Bash test", isError: true }, // inny klucz, bez powtórki
      { nodeId: "c", key: "Bash lint", isError: false }, // bliźniak domykający
      { nodeId: "d", key: "Bash lint", isError: true }, // błąd BEZ późniejszej powtórki
    ]);
    expect(retried).toEqual(new Set(["a"]));
  });

  it("pusta sekwencja → pusty zbiór", () => {
    expect(detectRetried([])).toEqual(new Set());
  });
});
