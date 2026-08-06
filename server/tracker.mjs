// Przyrostowy tail jednego pliku .jsonl — stan (offset, backlog, klienci SSE)
// plus odczyt przyrostu. Wydzielone z live.mjs, żeby logika truncate/rotacji
// była testowalna bez serwera HTTP.
import { createReadStream, statSync } from "node:fs";
import { createLineSplitter } from "./lineSplitter.mjs";

export function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

/**
 * @typedef {{
 *   backlog: string[],
 *   clients: Set<import('node:http').ServerResponse>,
 *   offset: number,
 *   reading: boolean,
 *   checkForGrowth: () => void,
 * }} Tracker
 */

/**
 * @param {string} absPath ścieżka bezwzględna śledzonego pliku
 * @returns {Tracker}
 */
export function createTracker(absPath) {
  const tracker = { backlog: [], clients: new Set(), offset: 0, reading: false, splitter: createLineSplitter() };

  function broadcastLine(line) {
    for (const res of tracker.clients) sse(res, "line", line);
  }

  function checkForGrowth() {
    if (tracker.reading) return;
    let size;
    try {
      size = statSync(absPath).size;
    } catch {
      return; // plik chwilowo niedostępny (np. w trakcie rotacji) — spróbujemy przy kolejnym tick/evencie
    }
    if (size < tracker.offset) {
      // Plik skrócony (truncate/rotacja) — bez resetu tail milczałby na zawsze,
      // bo offset > size. Czytamy od zera z czystym stanem: NOWY backlog zastępuje
      // stary (nowi klienci dostają spójną zawartość pliku po skróceniu), a już
      // podłączeni klienci SSE dostają odczytane linie zwykłym `line`.
      // ponytail: bez zdarzenia reset w protokole — UI po truncate dopisze nowe
      // linie do starych; dodać event `reset`, gdy realnie zacznie przeszkadzać.
      tracker.offset = 0;
      tracker.splitter = createLineSplitter();
      tracker.backlog = [];
    }
    if (size <= tracker.offset) return;
    tracker.reading = true;
    const stream = createReadStream(absPath, { start: tracker.offset, end: size - 1, encoding: "utf8" });
    let chunkAcc = "";
    stream.on("data", (chunk) => {
      chunkAcc += chunk;
    });
    stream.on("end", () => {
      tracker.offset = size;
      const newLines = tracker.splitter.push(chunkAcc);
      for (const line of newLines) {
        tracker.backlog.push(line);
        broadcastLine(line);
      }
      tracker.reading = false;
    });
    stream.on("error", (err) => {
      console.error("Błąd odczytu przyrostu:", err.message);
      tracker.reading = false;
    });
  }

  tracker.checkForGrowth = checkForGrowth;
  return tracker;
}
