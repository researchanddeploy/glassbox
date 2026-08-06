import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessions } from "./sessionsList.mjs";

describe("listSessions", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "glassbox-sessionslist-"));
    mkdirSync(join(root, "proj-a"));
    mkdirSync(join(root, "proj-b", "nested"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("znajduje pliki .jsonl rekurencyjnie i sortuje po mtime malejąco", () => {
    writeFileSync(join(root, "proj-a", "old.jsonl"), "{}\n");
    writeFileSync(join(root, "proj-b", "nested", "new.jsonl"), "{}\n");
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(join(root, "proj-a", "old.jsonl"), older, older);
    utimesSync(join(root, "proj-b", "nested", "new.jsonl"), newer, newer);

    const result = listSessions(root);
    expect(result.map((r) => r.path)).toEqual(["proj-b/nested/new.jsonl", "proj-a/old.jsonl"]);
    expect(result[0].size).toBeGreaterThan(0);
  });

  it("pomija pliki 0 B i pliki nie-.jsonl", () => {
    writeFileSync(join(root, "proj-a", "empty.jsonl"), "");
    writeFileSync(join(root, "proj-a", "notes.txt"), "hello");
    writeFileSync(join(root, "proj-a", "real.jsonl"), "{}\n");

    const result = listSessions(root);
    expect(result.map((r) => r.path)).toEqual(["proj-a/real.jsonl"]);
  });

  it("pomija sidecary subagentów (katalog subagents/)", () => {
    mkdirSync(join(root, "proj-a", "sesja-1", "subagents"), { recursive: true });
    writeFileSync(join(root, "proj-a", "sesja-1.jsonl"), "{}\n");
    writeFileSync(join(root, "proj-a", "sesja-1", "subagents", "agent-x.jsonl"), "{}\n");
    writeFileSync(join(root, "proj-a", "sesja-1", "subagents", "agent-y.jsonl"), "{}\n");

    const result = listSessions(root);
    expect(result.map((r) => r.path)).toEqual(["proj-a/sesja-1.jsonl"]);
  });

  it("respektuje limit wpisów", () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, "proj-a", `s${i}.jsonl`), "{}\n");
    }
    const result = listSessions(root, 3);
    expect(result).toHaveLength(3);
  });

  it("zwraca pustą listę dla pustego katalogu", () => {
    expect(listSessions(join(root, "proj-a"))).toEqual([]);
  });
});
