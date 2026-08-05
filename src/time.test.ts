import { describe, expect, it } from "vitest";
import { formatRelative, toEpoch } from "./time.ts";

describe("toEpoch", () => {
  it("parsuje ISO timestamp na epokę ms", () => {
    expect(toEpoch("2026-08-05T09:00:04.000Z")).toBe(Date.parse("2026-08-05T09:00:04.000Z"));
  });

  it("zwraca null dla braku/niepoprawnego wejścia", () => {
    expect(toEpoch(null)).toBeNull();
    expect(toEpoch("nie-data")).toBeNull();
  });
});

describe("formatRelative", () => {
  it("liczy mm:ss od startu sesji", () => {
    expect(formatRelative("2026-08-05T09:00:00.000Z", "2026-08-05T09:01:05.000Z")).toBe("01:05");
  });

  it("zwraca myślnik, gdy brak danych", () => {
    expect(formatRelative(null, "2026-08-05T09:00:00.000Z")).toBe("—");
    expect(formatRelative("2026-08-05T09:00:00.000Z", null)).toBe("—");
  });
});
