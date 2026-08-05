// Statyczna mapa cen modeli — koszt w USD za 1 mln tokenów, osobno in/out.
// approximate defaults — edit to match current pricing
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-3-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

/** Dopasowuje id modelu (który zwykle niesie sufiks daty/wersji) po najdłuższym znanym prefiksie. */
function lookupPricing(model: string): ModelPricing | null {
  const match = Object.keys(PRICING)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICING[match] : null;
}

/** Szacowany koszt USD dla danej pary tokenów in/out; null gdy model nieznany. */
export function computeCost(model: string | null, tokensIn: number, tokensOut: number): number | null {
  if (!model) return null;
  const pricing = lookupPricing(model);
  if (!pricing) return null;
  return (tokensIn / 1_000_000) * pricing.inputPerMTok + (tokensOut / 1_000_000) * pricing.outputPerMTok;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

interface AgentUsage {
  meta: { model: string | null; tokensIn: number; tokensOut: number };
}

export interface SessionCostSummary {
  tokensIn: number;
  tokensOut: number;
  /** Suma kosztów agentów o znanym modelu — zaniżona, gdy partial === true. */
  cost: number;
  /** True, gdy co najmniej jeden agent ma nieznany/brak modelu (koszt nieliczalny). */
  partial: boolean;
}

/** Agreguje tokeny i koszt per agent (main + subagenci) w sumę sesji. */
export function aggregateSessionCost(agents: AgentUsage[]): SessionCostSummary {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let partial = false;
  for (const agent of agents) {
    tokensIn += agent.meta.tokensIn;
    tokensOut += agent.meta.tokensOut;
    const agentCost = computeCost(agent.meta.model, agent.meta.tokensIn, agent.meta.tokensOut);
    if (agentCost === null) partial = true;
    else cost += agentCost;
  }
  return { tokensIn, tokensOut, cost, partial };
}
