// Odczyt sidecarów subagentów sesji: <dir>/<sessionId>/subagents/agent-*.jsonl
// (+ opcjonalny agent-*.meta.json). Kształt zgodny z SubagentSidecar parsera.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * @param {string} mainPath ścieżka bezwzględna pliku głównego sesji (.jsonl)
 * @returns {Array<{ jsonl: string, meta: Record<string, unknown> | null }>}
 */
export function readSubagentSidecars(mainPath) {
  const dir = join(dirname(mainPath), basename(mainPath, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf-8"));
      } catch {
        meta = null; // brak/uszkodzony meta.json — sidecar i tak wchodzi do grafu
      }
      return { jsonl: readFileSync(join(dir, f), "utf-8"), meta };
    });
}
