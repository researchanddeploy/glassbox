// Rekurencyjne listowanie plików *.jsonl w katalogu sesji. Czysta logika na fs —
// testowalna bez serwera HTTP.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DEFAULT_LIMIT = 500;

/**
 * @param {string} sessionsDir
 * @param {number} [limit]
 * @returns {{ path: string, size: number, mtime: number }[]} posortowane po mtime malejąco
 */
export function listSessions(sessionsDir, limit = DEFAULT_LIMIT) {
  const out = [];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // katalog nieczytelny (uprawnienia, race z usunięciem) — pomiń
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Sidecary subagentów (<sesja>/subagents/agent-*.jsonl) to nie sesje
        // główne — bez wykluczenia zapychają listę i wypychają realne sesje
        // z limitu. Do grafu dokleja je parser (readSubagentSidecars), nie lista.
        if (entry.name === "subagents") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size === 0) continue;
        out.push({ path: relative(sessionsDir, full).split(sep).join("/"), size: st.size, mtime: st.mtimeMs });
      }
    }
  }

  walk(sessionsDir);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}
