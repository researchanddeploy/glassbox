import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifySandbox } from "./sandbox.ts";
import { parseSession } from "./parseSession.ts";

// Realny transkrypt Claude Code — czytany bezpośrednio z dysku w teście, NIGDY
// kopiowany do repo (dane prywatne). Ścieżkę podaje env GLASSBOX_REAL_TRANSCRIPT;
// bez niej test jest pomijany.
const CURRENT_SESSION = process.env.GLASSBOX_REAL_TRANSCRIPT ?? "";

function readTranscript(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

describe("classifySandbox — markery jednostkowo", () => {
  it("Bash bez dangerouslyDisableSandbox → sandboxed, brak przekroczeń", () => {
    expect(classifySandbox("Bash", { command: "ls -la" })).toEqual({
      isolation: "sandboxed",
      boundaryCrossings: [],
    });
  });

  it("Bash z dangerouslyDisableSandbox → unsandboxed + filesystem-out", () => {
    expect(classifySandbox("Bash", { command: "touch x", dangerouslyDisableSandbox: true })).toEqual({
      isolation: "unsandboxed",
      boundaryCrossings: ["filesystem-out"],
    });
  });

  it("Bash z curl w komendzie → przekroczenie network", () => {
    const info = classifySandbox("Bash", { command: "curl -s https://example.com" });
    expect(info.isolation).toBe("sandboxed");
    expect(info.boundaryCrossings).toContain("network");
  });

  it("Bash z docker w komendzie → przekroczenie container", () => {
    const info = classifySandbox("Bash", { command: "docker ps" });
    expect(info.boundaryCrossings).toContain("container");
  });

  it("WebFetch → przekroczenie network, brak izolacji własnej", () => {
    expect(classifySandbox("WebFetch", { url: "https://example.com" })).toEqual({
      isolation: null,
      boundaryCrossings: ["network"],
    });
  });

  it("WebSearch → przekroczenie network", () => {
    expect(classifySandbox("WebSearch", { query: "x" }).boundaryCrossings).toEqual(["network"]);
  });

  it("narzędzie mcp__* → przekroczenie network", () => {
    expect(classifySandbox("mcp__tavily__tavily_search", {}).boundaryCrossings).toEqual(["network"]);
  });

  it("Agent z isolation:worktree → izolacja worktree", () => {
    expect(classifySandbox("Agent", { isolation: "worktree" })).toEqual({
      isolation: "worktree",
      boundaryCrossings: [],
    });
  });

  it("Agent z isolation:remote → izolacja container (mapowanie)", () => {
    expect(classifySandbox("Agent", { isolation: "remote" }).isolation).toBe("container");
  });

  it("Task bez isolation → brak sygnału, null", () => {
    expect(classifySandbox("Task", { description: "x" })).toEqual({
      isolation: null,
      boundaryCrossings: [],
    });
  });

  it("narzędzie bez żadnego markera (Read/Write/Edit/Grep) → null, konserwatywnie", () => {
    expect(classifySandbox("Read", { file_path: "/x" })).toEqual({ isolation: null, boundaryCrossings: [] });
    expect(classifySandbox("Grep", { pattern: "x" })).toEqual({ isolation: null, boundaryCrossings: [] });
  });
});

describe("classifySandbox — na realnym transkrypcie bieżącej sesji", () => {
  const raw = readTranscript(CURRENT_SESSION);
  const maybeIt = raw ? it : it.skip;

  maybeIt("wykrywa >0 wywołań z przekroczeniem network (WebFetch + curl)", () => {
    const graph = parseSession(raw as string);
    const networkCrossings = graph.nodes.filter((n) => n.sandbox.boundaryCrossings.includes("network"));
    expect(networkCrossings.length).toBeGreaterThan(0);
  });
});
