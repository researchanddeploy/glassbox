import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSubagentSidecars } from "./subagents.mjs";

describe("readSubagentSidecars", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "glassbox-subagents-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("czyta sidecary z meta.json i toleruje jego brak", () => {
    const mainPath = join(root, "sesja.jsonl");
    writeFileSync(mainPath, "{}\n");
    const dir = join(root, "sesja", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-abc.jsonl"), '{"agentId":"abc"}\n');
    writeFileSync(join(dir, "agent-abc.meta.json"), '{"agentType":"Explore","toolUseId":"toolu_1"}');
    writeFileSync(join(dir, "agent-def.jsonl"), '{"agentId":"def"}\n'); // bez meta.json

    const sidecars = readSubagentSidecars(mainPath);
    expect(sidecars.length).toBe(2);
    const withMeta = sidecars.find((s) => s.meta !== null);
    expect(withMeta?.meta?.toolUseId).toBe("toolu_1");
    expect(sidecars.every((s) => s.jsonl.includes("agentId"))).toBe(true);
  });

  it("zwraca pustą tablicę, gdy katalogu subagents nie ma", () => {
    const mainPath = join(root, "bez-sidecarow.jsonl");
    writeFileSync(mainPath, "{}\n");
    expect(readSubagentSidecars(mainPath)).toEqual([]);
  });
});
