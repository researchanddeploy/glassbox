// Statyczna mapa cen modeli — koszt w USD za 1 mln tokenów, osobno in/out.
// Stawki wg dokumentacji Anthropic (skill claude-api), stan na 2026-08-05.
// Mnożniki cache są jednolite dla wszystkich modeli względem ceny input:
// odczyt 0.1×, zapis 5m TTL 1.25×, zapis 1h TTL 2×.
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-3-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
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

/** Pełny zestaw pól usage wchodzących do kosztu — strukturalnie zgodny z NodeMeta. */
export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
}

/** Rozbicie kosztu USD na kategorie; total = suma pozostałych. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Szacowany koszt USD z rozbiciem; null gdy model nieznany (nie zmyślamy stawki). */
export function computeCost(model: string | null, usage: TokenUsage): CostBreakdown | null {
  if (!model) return null;
  const pricing = lookupPricing(model);
  if (!pricing) return null;
  const perTokIn = pricing.inputPerMTok / 1_000_000;
  const input = usage.tokensIn * perTokIn;
  const output = (usage.tokensOut / 1_000_000) * pricing.outputPerMTok;
  const cacheRead = usage.cacheReadTokens * perTokIn * CACHE_READ_MULT;
  const cacheWrite =
    usage.cacheCreation5mTokens * perTokIn * CACHE_WRITE_5M_MULT +
    usage.cacheCreation1hTokens * perTokIn * CACHE_WRITE_1H_MULT;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

interface AgentUsage {
  meta: TokenUsage & { model: string | null };
}

const ZERO_BREAKDOWN: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export interface SessionCostSummary {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Suma kosztów agentów o znanym modelu — zaniżona, gdy partial === true. */
  cost: CostBreakdown;
  /** True, gdy co najmniej jeden agent ma nieznany/brak modelu (koszt nieliczalny). */
  partial: boolean;
}

/** Agreguje tokeny i koszt per agent (main + subagenci) w sumę sesji. */
export function aggregateSessionCost(agents: AgentUsage[]): SessionCostSummary {
  const summary: SessionCostSummary = {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: { ...ZERO_BREAKDOWN },
    partial: false,
  };
  for (const agent of agents) {
    summary.tokensIn += agent.meta.tokensIn;
    summary.tokensOut += agent.meta.tokensOut;
    summary.cacheReadTokens += agent.meta.cacheReadTokens;
    summary.cacheCreationTokens += agent.meta.cacheCreation5mTokens + agent.meta.cacheCreation1hTokens;
    const agentCost = computeCost(agent.meta.model, agent.meta);
    if (agentCost === null) {
      summary.partial = true;
      continue;
    }
    summary.cost.input += agentCost.input;
    summary.cost.output += agentCost.output;
    summary.cost.cacheRead += agentCost.cacheRead;
    summary.cost.cacheWrite += agentCost.cacheWrite;
    summary.cost.total += agentCost.total;
  }
  return summary;
}
