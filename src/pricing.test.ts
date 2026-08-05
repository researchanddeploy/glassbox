import { describe, expect, it } from "vitest";
import { aggregateSessionCost, computeCost, type TokenUsage } from "./pricing.ts";

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    ...partial,
  };
}

describe("computeCost", () => {
  it("liczy pełne rozbicie dla znanego modelu (in/out/cache read/cache write 5m+1h)", () => {
    // claude-opus-4-8: $5 in / $25 out za 1M; cache: odczyt 0.1×, zapis 5m 1.25×, zapis 1h 2×.
    const cost = computeCost(
      "claude-opus-4-8",
      usage({
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000,
        cacheCreation1hTokens: 1_000_000,
      }),
    );
    expect(cost).not.toBeNull();
    expect(cost!.input).toBeCloseTo(5, 6);
    expect(cost!.output).toBeCloseTo(25, 6);
    expect(cost!.cacheRead).toBeCloseTo(0.5, 6);
    expect(cost!.cacheWrite).toBeCloseTo(6.25 + 10, 6);
    expect(cost!.total).toBeCloseTo(5 + 25 + 0.5 + 16.25, 6);
  });

  it("dopasowuje po najdłuższym prefiksie (sufiks daty, kolizja opus-4 vs opus-4-5)", () => {
    // claude-opus-4-5-20251101 → stawka opus-4-5 ($5/$25), nie opus-4 ($15/$75).
    const cost = computeCost("claude-opus-4-5-20251101", usage({ tokensIn: 1_000_000, tokensOut: 1_000_000 }));
    expect(cost!.total).toBeCloseTo(30, 6);
    // claude-opus-4-20250514 → stara stawka opus-4 ($15/$75).
    const old = computeCost("claude-opus-4-20250514", usage({ tokensIn: 1_000_000, tokensOut: 1_000_000 }));
    expect(old!.total).toBeCloseTo(90, 6);
  });

  it("zwraca null dla nieznanego modelu (nie zmyśla stawki)", () => {
    expect(computeCost("mystery-model-9000", usage({ tokensIn: 1000 }))).toBeNull();
  });

  it("zwraca null przy braku modelu", () => {
    expect(computeCost(null, usage({ tokensIn: 1000 }))).toBeNull();
  });
});

describe("aggregateSessionCost", () => {
  it("sumuje tokeny, cache i rozbicie kosztu per agent, oznacza partial przy nieznanym modelu", () => {
    const summary = aggregateSessionCost([
      { meta: { model: "claude-sonnet-4-5", ...usage({ tokensIn: 1_000_000 }) } }, // $3 input
      { meta: { model: "claude-haiku-4-5", ...usage({ tokensOut: 1_000_000 }) } }, // $5 output
      {
        // cache: odczyt 1M×0.1×$5 = $0.50; zapis 1h 1M×2×$5 = $10.
        meta: {
          model: "claude-opus-4-8",
          ...usage({ cacheReadTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }),
        },
      },
      { meta: { model: "unknown-model", ...usage({ tokensIn: 500, tokensOut: 500 }) } },
    ]);

    expect(summary.tokensIn).toBe(1_000_500);
    expect(summary.tokensOut).toBe(1_000_500);
    expect(summary.cacheReadTokens).toBe(1_000_000);
    expect(summary.cacheCreationTokens).toBe(1_000_000);
    expect(summary.cost.input).toBeCloseTo(3, 6);
    expect(summary.cost.output).toBeCloseTo(5, 6);
    expect(summary.cost.cacheRead).toBeCloseTo(0.5, 6);
    expect(summary.cost.cacheWrite).toBeCloseTo(10, 6);
    expect(summary.cost.total).toBeCloseTo(18.5, 6); // tylko znane modele
    expect(summary.partial).toBe(true);
  });

  it("nie ustawia partial, gdy wszystkie modele są znane", () => {
    const summary = aggregateSessionCost([
      { meta: { model: "claude-sonnet-4-5", ...usage({ tokensIn: 100, tokensOut: 100 }) } },
    ]);
    expect(summary.partial).toBe(false);
    expect(summary.cost.total).toBeGreaterThan(0);
  });
});
