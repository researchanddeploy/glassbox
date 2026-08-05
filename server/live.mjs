#!/usr/bin/env node
// Serwer live: śledzi przyrost pliku(ów) .jsonl i strumieniuje nowe linie przez SSE.
// Zero zależności runtime — tylko node:http, node:fs, node:path, node:os.
//
// Dwa tryby:
//  - pojedynczy plik (dotychczasowe użycie): `node server/live.mjs <ścieżka.jsonl>`
//    — /events śledzi wskazany plik, /sessions niedostępne.
//  - katalog sesji (domyślny, bez argumentu CLI): GLASSBOX_SESSIONS_DIR (albo
//    ~/.claude/projects) wystawia /sessions (lista *.jsonl) i /events?session=<rel>.
//
// W trybie produkcyjnym (obraz Docker) serwuje też statyczny build z ../dist,
// z fallbackiem na index.html dla nawigacji SPA.
import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { createLineSplitter } from "./lineSplitter.mjs";
import { resolveSessionPath } from "./sessionPath.mjs";
import { listSessions } from "./sessionsList.mjs";

const PORT = 4517;
const POLL_MS = 1000; // fallback dla systemów plików, gdzie fs.watch milczy
const HEARTBEAT_MS = 15000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "../dist");

const singleFileArg = process.argv[2];
/** @type {string | null} w trybie pojedynczego pliku: ścieżka bezwzględna śledzonego pliku. */
let singleFilePath = null;
/** @type {string | null} w trybie katalogu sesji: katalog bazowy. */
let sessionsDir = null;

if (singleFileArg) {
  singleFilePath = resolve(singleFileArg);
  if (!existsSync(singleFilePath)) {
    console.error(`Plik nie istnieje: ${singleFilePath}`);
    process.exit(1);
  }
} else {
  sessionsDir = resolve((process.env.GLASSBOX_SESSIONS_DIR ?? "~/.claude/projects").replace(/^~/, homedir()));
}

/**
 * @typedef {{
 *   backlog: string[],
 *   clients: Set<import('node:http').ServerResponse>,
 *   offset: number,
 *   reading: boolean,
 * }} Tracker
 */

/** @type {Map<string, Tracker>} klucz: ścieżka bezwzględna pliku */
const trackers = new Map();

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

/** Tworzy (albo zwraca istniejący) tracker przyrostowego tail dla danego pliku. */
function getTracker(absPath) {
  let tracker = trackers.get(absPath);
  if (tracker) return tracker;
  tracker = { backlog: [], clients: new Set(), offset: 0, reading: false, splitter: createLineSplitter() };
  trackers.set(absPath, tracker);

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
  watch(absPath, { persistent: true }, () => checkForGrowth());
  checkForGrowth(); // odczytaj to, co już jest w pliku, zanim ktokolwiek się podłączy
  return tracker;
}

if (singleFilePath) getTracker(singleFilePath);

setInterval(() => {
  for (const tracker of trackers.values()) tracker.checkForGrowth();
}, POLL_MS);

setInterval(() => {
  for (const tracker of trackers.values()) {
    for (const res of tracker.clients) res.write(": heartbeat\n\n");
  }
}, HEARTBEAT_MS);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Serwuje statyczny build z DIST_DIR, fallback na index.html (SPA). */
function serveStatic(req, res) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404).end("brak builda produkcyjnego (npm run build)");
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0];
  let filePath = resolve(DIST_DIR, "." + urlPath);
  // ochrona przed traversal poza DIST_DIR — awaria do index.html
  if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html");
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/nudge") {
    // Opcjonalny endpoint dla hooks/glassbox-hook.sh: każe natychmiast sprawdzić
    // przyrost śledzonych plików zamiast czekać do najbliższego ticka pollingu (do 1s).
    for (const tracker of trackers.values()) tracker.checkForGrowth();
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/sessions") {
    if (!sessionsDir) {
      res.writeHead(404).end("tryb pojedynczego pliku — /sessions niedostępne");
      return;
    }
    if (!existsSync(sessionsDir) || !statSync(sessionsDir).isDirectory()) {
      res
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: `Katalog sesji nie istnieje: ${sessionsDir}` }));
      return;
    }
    const sessions = listSessions(sessionsDir);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(sessions));
    return;
  }

  if (url.pathname === "/events") {
    let absPath;
    if (singleFilePath) {
      absPath = singleFilePath;
    } else {
      const session = url.searchParams.get("session");
      if (!sessionsDir || !session) {
        res.writeHead(400).end("brak parametru ?session=");
        return;
      }
      const resolved = resolveSessionPath(sessionsDir, session);
      if (!resolved) {
        res.writeHead(400).end("nieprawidłowa ścieżka sesji");
        return;
      }
      if (!existsSync(resolved)) {
        res.writeHead(404).end("sesja nie istnieje");
        return;
      }
      absPath = resolved;
    }

    const tracker = getTracker(absPath);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("\n");
    sse(res, "backlog", JSON.stringify(tracker.backlog));
    tracker.clients.add(res);
    req.on("close", () => tracker.clients.delete(res));
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`Glassbox live server`);
  if (singleFilePath) {
    console.log(`  śledzi: ${singleFilePath}`);
  } else {
    console.log(`  katalog sesji: ${sessionsDir}`);
    console.log(`  lista:  http://localhost:${PORT}/sessions`);
  }
  console.log(`  SSE:    http://localhost:${PORT}/events`);
  console.log(`W UI kliknij „Live” albo połącz ręcznie: curl -N http://localhost:${PORT}/events`);
});
