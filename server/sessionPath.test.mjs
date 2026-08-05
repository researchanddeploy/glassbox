import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionPath } from "./sessionPath.mjs";

describe("resolveSessionPath", () => {
  let root;
  let sessionsDir;
  let outsideDir;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "glassbox-sessionpath-")));
    sessionsDir = join(root, "sessions");
    outsideDir = join(root, "outside");
    mkdirSync(sessionsDir);
    mkdirSync(outsideDir);
    mkdirSync(join(sessionsDir, "proj"));
    writeFileSync(join(sessionsDir, "proj", "a.jsonl"), "{}\n");
    writeFileSync(join(outsideDir, "secret.jsonl"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("akceptuje poprawną ścieżkę względną wewnątrz katalogu sesji", () => {
    const result = resolveSessionPath(sessionsDir, "proj/a.jsonl");
    expect(result).toBe(join(sessionsDir, "proj", "a.jsonl"));
  });

  it("odrzuca .. wyprowadzające poza katalog sesji", () => {
    expect(resolveSessionPath(sessionsDir, "../outside/secret.jsonl")).toBeNull();
  });

  it("odrzuca ścieżkę absolutną", () => {
    expect(resolveSessionPath(sessionsDir, join(outsideDir, "secret.jsonl"))).toBeNull();
  });

  it("odrzuca symlink wyprowadzający poza katalog sesji", () => {
    const linkPath = join(sessionsDir, "escape.jsonl");
    symlinkSync(join(outsideDir, "secret.jsonl"), linkPath);
    expect(resolveSessionPath(sessionsDir, "escape.jsonl")).toBeNull();
  });

  it("zwraca kandydata dla ścieżki bezpiecznej, ale nieistniejącej — wywołujący zgłasza brak pliku", () => {
    const result = resolveSessionPath(sessionsDir, "proj/nope.jsonl");
    expect(result).toBe(join(sessionsDir, "proj", "nope.jsonl"));
  });

  it("odrzuca pustą i nie-stringową ścieżkę", () => {
    expect(resolveSessionPath(sessionsDir, "")).toBeNull();
    expect(resolveSessionPath(sessionsDir, undefined)).toBeNull();
  });
});
