import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTracker } from "./tracker.mjs";

describe("createTracker — przyrostowy tail z obsługą truncate/rotacji", () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glassbox-tracker-"));
    file = join(dir, "sesja.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("czyta istniejącą zawartość i kolejne przyrosty", async () => {
    writeFileSync(file, '{"a":1}\n');
    const tracker = createTracker(file);
    tracker.checkForGrowth();
    await vi.waitFor(() => expect(tracker.backlog).toEqual(['{"a":1}']));

    appendFileSync(file, '{"a":2}\n');
    tracker.checkForGrowth();
    await vi.waitFor(() => expect(tracker.backlog).toEqual(['{"a":1}', '{"a":2}']));
  });

  it("po skróceniu pliku (truncate/rotacja) resetuje stan: nowy backlog i emisja nowych linii", async () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const tracker = createTracker(file);
    tracker.checkForGrowth();
    await vi.waitFor(() => expect(tracker.backlog).toEqual(['{"a":1}', '{"a":2}']));

    // Podłączony klient SSE — przed fixem po truncate nie dostawał już nic.
    const received = [];
    tracker.clients.add({ write: (s) => received.push(s) });

    // Rotacja: plik zastąpiony krótszą, nową zawartością.
    writeFileSync(file, '{"b":1}\n');
    tracker.checkForGrowth();
    await vi.waitFor(() => expect(tracker.backlog).toEqual(['{"b":1}']));

    // Backlog jest NOWY (bez starych linii), a klient dostał nową linię.
    expect(received.join("")).toContain('{"b":1}');
    expect(received.join("")).not.toContain('{"a":1}');

    // Dalszy przyrost po skróceniu nadal dochodzi.
    appendFileSync(file, '{"b":2}\n');
    tracker.checkForGrowth();
    await vi.waitFor(() => expect(tracker.backlog).toEqual(['{"b":1}', '{"b":2}']));
    expect(received.join("")).toContain('{"b":2}');
  });
});
