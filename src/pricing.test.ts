import { describe, expect, it } from "vitest";
import { aggregateSessionCost, computeCost } from "./pricing.ts";

describe("computeCost", () => {
  it("liczy koszt dla znanego modelu (dopasowanie po prefiksie)", () => {
    // claude-opus-4-8 nie jest kluczem wprost, ale zaczyna się od "claude-opus-4"
    const cost = computeCost("claude-opus-4-8", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(15 + 75, 6);
  });

  it("zwraca null dla nieznanego modelu", () => {
    expect(computeCost("mystery-model-9000", 1000, 1000)).toBeNull();
  });

  it("zwraca null przy braku modelu", () => {
    expect(computeCost(null, 1000, 1000)).toBeNull();
  });
});

describe("aggregateSessionCost", () => {
  it("sumuje tokeny i koszt per agent, oznacza partial przy nieznanym modelu", () => {
    const summary = aggregateSessionCost([
      { meta: { model: "claude-sonnet-4-5", tokensIn: 1_000_000, tokensOut: 0 } }, // $3
      { meta: { model: "claude-haiku-4-5", tokensIn: 0, tokensOut: 1_000_000 } }, // $5
      { meta: { model: "unknown-model", tokensIn: 500, tokensOut: 500 } },
    ]);

    expect(summary.tokensIn).toBe(1_000_500);
    expect(summary.tokensOut).toBe(1_000_500);
    expect(summary.cost).toBeCloseTo(8, 6); // tylko znane modele
    expect(summary.partial).toBe(true);
  });

  it("nie ustawia partial, gdy wszystkie modele są znane", () => {
    const summary = aggregateSessionCost([
      { meta: { model: "claude-sonnet-4-5", tokensIn: 100, tokensOut: 100 } },
    ]);
    expect(summary.partial).toBe(false);
    expect(summary.cost).toBeGreaterThan(0);
  });
});
