// Testy handlera JSON-RPC serwera MCP: protokół (initialize/tools/list/notyfikacje),
// cztery narzędzia na syntetycznej sesji (public/sample.jsonl kopiowany do tmp)
// oraz odmowa path traversal przez resolveSessionPath.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS, createMcpHandler } from "./mcp.mjs";

const sampleRaw = readFileSync(new URL("../public/sample.jsonl", import.meta.url), "utf-8");

describe("createMcpHandler", () => {
  let sessionsDir;
  let handle;
  let broadcasts;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "glassbox-mcp-"));
    mkdirSync(join(sessionsDir, "proj"));
    writeFileSync(join(sessionsDir, "proj", "sample.jsonl"), sampleRaw);
    broadcasts = [];
    handle = createMcpHandler({
      sessionsDir,
      broadcastHighlight: (absPath, payload) => {
        broadcasts.push({ absPath, payload });
        return 1;
      },
    });
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  const call = (name, args) =>
    handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  it("initialize zwraca wersję protokołu i serverInfo", () => {
    const res = handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.serverInfo.name).toBe("glassbox");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("notifications/initialized → null (odpowiedź 202 bez treści)", () => {
    expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("tools/list deklaruje cztery narzędzia ze schematami", () => {
    const res = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.result.tools.map((t) => t.name)).toEqual([
      "list_sessions",
      "get_session_graph",
      "get_node_detail",
      "highlight_nodes",
    ]);
    for (const tool of TOOLS) expect(tool.inputSchema.type).toBe("object");
  });

  it("nieznana metoda → błąd -32601", () => {
    const res = handle({ jsonrpc: "2.0", id: 9, method: "cośtam" });
    expect(res.error.code).toBe(-32601);
  });

  it("list_sessions zwraca sesję z liczbą węzłów", () => {
    const res = call("list_sessions", {});
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.length).toBe(1);
    expect(parsed[0].path).toBe("proj/sample.jsonl");
    expect(parsed[0].nodes).toBeGreaterThan(0);
  });

  it("get_session_graph zwraca TSV z legendą i nagłówkiem", () => {
    const res = call("get_session_graph", { session: "proj/sample.jsonl" });
    const text = res.result.content[0].text;
    expect(res.result.isError).toBeUndefined();
    expect(text).toMatch(/^# sesja /);
    expect(text).toContain("# węzeł: id");
    expect(text).toMatch(/\nn0\t/);
    expect(text).toMatch(/\n[sct]\tn\d+\tn\d+/); // sekcja krawędzi
  });

  it("get_node_detail po nX zwraca pełny detal", () => {
    const res = call("get_node_detail", { session: "proj/sample.jsonl", node_id: "n0" });
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.id).toBe("n0");
    expect(parsed.type).toBe("session");
  });

  it("highlight_nodes mapuje nX na oryginalne id i broadcastuje", () => {
    const res = call("highlight_nodes", {
      session: "proj/sample.jsonl",
      node_ids: ["n1", "n2"],
      note: "spójrz tutaj",
    });
    expect(res.result.isError).toBeUndefined();
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].payload.ids.length).toBe(2);
    expect(broadcasts[0].payload.ids[0]).not.toMatch(/^n\d+$/); // oryginalne id, nie nX
    expect(broadcasts[0].payload.note).toBe("spójrz tutaj");
  });

  it("path traversal (../../etc/passwd) kończy się odmową", () => {
    for (const session of ["../../etc/passwd", "/etc/passwd", "..%2F..%2Fetc%2Fpasswd"]) {
      const res = call("get_session_graph", { session });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain("Nieprawidłowa");
    }
    expect(broadcasts.length).toBe(0);
  });

  it("nieznany node_id → isError, bez broadcastu", () => {
    const res = call("highlight_nodes", { session: "proj/sample.jsonl", node_ids: ["n99999"] });
    expect(res.result.isError).toBe(true);
    expect(broadcasts.length).toBe(0);
  });
});
