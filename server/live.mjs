#!/usr/bin/env node
// Serwer live: śledzi przyrost pliku .jsonl i strumieniuje nowe linie przez SSE.
// Zero zależności runtime — tylko node:http, node:fs, node:path.
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { basename, resolve } from "node:path";
import { createServer } from "node:http";
import { createLineSplitter } from "./lineSplitter.mjs";

const PORT = 4517;
const POLL_MS = 1000; // fallback dla systemów plików, gdzie fs.watch milczy
const HEARTBEAT_MS = 15000;

const filePath = process.argv[2];
if (!filePath) {
  console.error("Użycie: node server/live.mjs <ścieżka-do-transkryptu.jsonl>");
  process.exit(1);
}
const absPath = resolve(filePath);
if (!existsSync(absPath)) {
  console.error(`Plik nie istnieje: ${absPath}`);
  process.exit(1);
}

const splitter = createLineSplitter();
/** @type {string[]} wszystkie kompletne linie widziane od startu serwera — backlog dla nowych klientów. */
const backlog = [];
/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();
let offset = 0;
let reading = false;

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function broadcastLine(line) {
  for (const res of clients) sse(res, "line", line);
}

/** Czyta tylko nowe bajty od `offset`, nigdy plik od zera. */
function checkForGrowth() {
  if (reading) return;
  let size;
  try {
    size = statSync(absPath).size;
  } catch {
    return; // plik chwilowo niedostępny (np. w trakcie rotacji) — spróbujemy przy kolejnym tick/evencie
  }
  if (size <= offset) return;
  reading = true;
  const stream = createReadStream(absPath, { start: offset, end: size - 1, encoding: "utf8" });
  let chunkAcc = "";
  stream.on("data", (chunk) => {
    chunkAcc += chunk;
  });
  stream.on("end", () => {
    offset = size;
    const newLines = splitter.push(chunkAcc);
    for (const line of newLines) {
      backlog.push(line);
      broadcastLine(line);
    }
    reading = false;
  });
  stream.on("error", (err) => {
    console.error("Błąd odczytu przyrostu:", err.message);
    reading = false;
  });
}

watch(absPath, { persistent: true }, () => checkForGrowth());
setInterval(checkForGrowth, POLL_MS);
checkForGrowth(); // odczytaj to, co już jest w pliku, zanim ktokolwiek się podłączy

const server = createServer((req, res) => {
  if (req.url === "/nudge") {
    // Opcjonalny endpoint dla hooks/glassbox-hook.sh: każe natychmiast sprawdzić
    // przyrost pliku zamiast czekać do najbliższego ticka pollingu (do 1s).
    checkForGrowth();
    res.writeHead(204).end();
    return;
  }
  if (req.url !== "/events") {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("\n");
  sse(res, "backlog", JSON.stringify(backlog));
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

setInterval(() => {
  for (const res of clients) res.write(": heartbeat\n\n");
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`Glassbox live server`);
  console.log(`  śledzi: ${absPath}`);
  console.log(`  SSE:    http://localhost:${PORT}/events`);
  console.log(`W UI kliknij „Live” albo połącz ręcznie: curl -N http://localhost:${PORT}/events`);
  console.log(`Plik: ${basename(absPath)}`);
});
