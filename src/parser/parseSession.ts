import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeStatus,
  SessionGraph,
  SessionMeta,
} from "./types.ts";
import { classifySandbox, NO_SANDBOX_INFO } from "./sandbox.ts";

const DETAIL_LIMIT = 2000; // ~2 KB w znakach ASCII

const SPAWN_TOOL_NAMES = new Set(["Task", "Agent"]);
const FILE_TOOL_NAMES = new Set(["Read", "Write", "Edit"]);

function truncate(value: string, limit = DETAIL_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBool(value: unknown): boolean {
  return value === true;
}

/** Zamienia dowolny content blok tool_result/tool_use input na czytelny tekst. */
function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const rec = asRecord(block);
        if (!rec) return "";
        if (rec.type === "text") return asString(rec.text) ?? "";
        if (rec.type === "image") return "[image]";
        return JSON.stringify(rec);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface ContentBlock {
  type: string;
  raw: Record<string, unknown>;
}

interface ParsedLine {
  type: string | null;
  uuid: string | null;
  isSidechain: boolean;
  timestamp: string | null;
  sessionId: string | null;
  role: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  content: ContentBlock[];
}

function parseLine(raw: string): ParsedLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(obj);
  if (!rec) return null;

  const message = asRecord(rec.message);
  const usage = message ? asRecord(message.usage) : null;
  const contentRaw = message ? message.content : null;
  const content: ContentBlock[] = Array.isArray(contentRaw)
    ? contentRaw
        .map((block) => asRecord(block))
        .filter((block): block is Record<string, unknown> => block !== null)
        .map((block) => ({ type: asString(block.type) ?? "unknown", raw: block }))
    : [];

  return {
    type: asString(rec.type),
    uuid: asString(rec.uuid),
    isSidechain: asBool(rec.isSidechain),
    timestamp: asString(rec.timestamp),
    sessionId: asString(rec.sessionId),
    role: message ? asString(message.role) : null,
    model: message ? asString(message.model) : null,
    tokensIn: usage ? asNumber(usage.input_tokens) : 0,
    tokensOut: usage ? asNumber(usage.output_tokens) : 0,
    content,
  };
}

/** Wyszukuje tool_result (is_error, content) po całym pliku, indeksowane po tool_use_id. */
function indexToolResults(lines: ParsedLine[]): Map<string, { isError: boolean; text: string }> {
  const index = new Map<string, { isError: boolean; text: string }>();
  for (const line of lines) {
    for (const block of line.content) {
      if (block.type !== "tool_result") continue;
      const toolUseId = asString(block.raw.tool_use_id);
      if (!toolUseId) continue;
      index.set(toolUseId, {
        isError: asBool(block.raw.is_error),
        text: truncate(contentToText(block.raw.content)),
      });
    }
  }
  return index;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeMeta(timestamp: string | null, model: string | null, status: NodeStatus) {
  return { timestamp, tokensIn: 0, tokensOut: 0, model, status };
}

/**
 * Parsuje transkrypt sesji Claude Code (JSONL, jeden obiekt na linię) w graf DAG.
 * Odporny na linie nieparsowalne/nieznane typy — pomija je zamiast się wywalać.
 *
 * Obsługuje dwa empirycznie zaobserwowane sposoby reprezentacji subagentów:
 *  1. inline sidechain — linie `isSidechain: true` między wywołaniem Task/Agent
 *     a jego tool_result, konwencja używana przez część harnessów Claude Code.
 *  2. async spawn — wywołanie Task/Agent zwraca natychmiastowe potwierdzenie
 *     (agentId), a pełny transkrypt subagenta żyje w osobnym pliku poza zasięgiem
 *     tego parsera (per-sesyjny katalog `subagents/`). Węzeł subagenta i tak
 *     powstaje — z opisu/promptu wywołania — tylko bez własnych tool_call dzieci.
 */
export function parseSession(jsonl: string): SessionGraph {
  idCounter = 0;
  const rawLines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  const lines: ParsedLine[] = [];
  let skippedLines = 0;
  for (const raw of rawLines) {
    const parsed = parseLine(raw);
    if (parsed) lines.push(parsed);
    else skippedLines += 1;
  }

  const toolResults = indexToolResults(lines);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const fileNodeByPath = new Map<string, string>();

  const sessionId = lines.find((l) => l.sessionId)?.sessionId ?? null;
  const sessionNodeId = "session";
  nodes.set(sessionNodeId, {
    id: sessionNodeId,
    type: "session",
    label: sessionId ? `sesja ${sessionId.slice(0, 8)}` : "sesja",
    detail: "",
    output: "",
    meta: makeMeta(lines[0]?.timestamp ?? null, null, "unknown"),
    sandbox: NO_SANDBOX_INFO,
  });

  const mainAgentId = "agent-main";
  nodes.set(mainAgentId, {
    id: mainAgentId,
    type: "agent",
    label: "main",
    detail: "",
    output: "",
    meta: makeMeta(lines[0]?.timestamp ?? null, null, "ok"),
    sandbox: NO_SANDBOX_INFO,
  });
  edges.push({ id: nextId("edge"), type: "spawns", source: sessionNodeId, target: mainAgentId });

  function addEdge(type: EdgeType, source: string, target: string) {
    edges.push({ id: nextId("edge"), type, source, target });
  }

  function accumulateUsage(node: GraphNode, tokensIn: number, tokensOut: number, model: string | null, timestamp: string | null) {
    node.meta.tokensIn += tokensIn;
    node.meta.tokensOut += tokensOut;
    if (model) node.meta.model = model;
    if (timestamp && !node.meta.timestamp) node.meta.timestamp = timestamp;
  }

  function fileNodeFor(path: string, timestamp: string | null): string {
    const existing = fileNodeByPath.get(path);
    if (existing) return existing;
    const id = nextId("file");
    fileNodeByPath.set(path, id);
    const shortLabel = path.split("/").pop() ?? path;
    nodes.set(id, {
      id,
      type: "file",
      label: shortLabel,
      detail: path,
      output: "",
      meta: makeMeta(timestamp, null, "unknown"),
      sandbox: NO_SANDBOX_INFO,
    });
    return id;
  }

  function toolInputSummary(name: string, input: Record<string, unknown>): string {
    if (name === "Bash" && typeof input.command === "string") return input.command;
    if ((name === "Read" || name === "Write" || name === "Edit") && typeof input.file_path === "string") {
      return input.file_path;
    }
    return JSON.stringify(input);
  }

  // Aktywny "wątek": main-agent domyślnie; przy inline sidechain przełączamy się
  // na ostatnio zespawnowanego subagenta, dopóki jego tool_result nie wróci.
  let activeAgentId = mainAgentId;
  let pendingSpawn: { agentId: string; toolUseId: string } | null = null;

  for (const line of lines) {
    if (line.isSidechain) {
      // Kontynuacja wątku subagenta (inline sidechain).
      if (pendingSpawn) activeAgentId = pendingSpawn.agentId;
    } else if (activeAgentId !== mainAgentId) {
      // Wróciliśmy do głównego wątku bez jawnego tool_result — reset.
      activeAgentId = mainAgentId;
    }

    const agentNode = nodes.get(activeAgentId);
    if (agentNode && line.role === "assistant") {
      accumulateUsage(agentNode, line.tokensIn, line.tokensOut, line.model, line.timestamp);
    }

    for (const block of line.content) {
      if (block.type === "tool_use") {
        const name = asString(block.raw.name) ?? "unknown";
        const toolUseId = asString(block.raw.id) ?? nextId("tool");
        const input = asRecord(block.raw.input) ?? {};
        const result = toolResults.get(toolUseId);
        const status: NodeStatus = result ? (result.isError ? "error" : "ok") : "unknown";

        if (SPAWN_TOOL_NAMES.has(name)) {
          const subagentId = `agent-${toolUseId}`;
          const description = asString(input.description) ?? asString(input.subagent_type) ?? name;
          const subagentType = asString(input.subagent_type);
          const prompt = asString(input.prompt) ?? "";
          nodes.set(subagentId, {
            id: subagentId,
            type: "agent",
            label: description,
            detail: truncate(prompt),
            output: result?.text ?? "",
            meta: makeMeta(line.timestamp, subagentType, status),
            sandbox: classifySandbox(name, input),
          });
          addEdge("spawns", activeAgentId, subagentId);
          pendingSpawn = { agentId: subagentId, toolUseId };
          continue;
        }

        const toolNodeId = `tool-${toolUseId}`;
        nodes.set(toolNodeId, {
          id: toolNodeId,
          type: "tool_call",
          label: name,
          detail: truncate(toolInputSummary(name, input)),
          output: result?.text ?? "",
          meta: makeMeta(line.timestamp, agentNode?.meta.model ?? null, status),
          sandbox: classifySandbox(name, input),
        });
        addEdge("calls", activeAgentId, toolNodeId);

        if (FILE_TOOL_NAMES.has(name)) {
          const path = asString(input.file_path);
          if (path) {
            const fileId = fileNodeFor(path, line.timestamp);
            addEdge("touches", toolNodeId, fileId);
          }
        }
      } else if (block.type === "tool_result") {
        const toolUseId = asString(block.raw.tool_use_id);
        if (toolUseId && pendingSpawn && pendingSpawn.toolUseId === toolUseId) {
          // Subagent zakończony (sync albo async ack) — wracamy do głównego wątku.
          const spawned = nodes.get(pendingSpawn.agentId);
          if (spawned) {
            spawned.meta.status = asBool(block.raw.is_error) ? "error" : "ok";
          }
          pendingSpawn = null;
          activeAgentId = mainAgentId;
        }
      }
    }
  }

  const nodeList = Array.from(nodes.values());
  const timestamps = nodeList.map((n) => n.meta.timestamp).filter((t): t is string => t !== null).sort();
  const agentNodes = nodeList.filter((n) => n.type === "agent");
  const toolCallNodes = nodeList.filter((n) => n.type === "tool_call");
  const fileNodes = nodeList.filter((n) => n.type === "file");
  const modelsUsed = Array.from(new Set(agentNodes.map((n) => n.meta.model).filter((m): m is string => m !== null)));

  const meta: SessionMeta = {
    sessionId,
    startedAt: timestamps[0] ?? null,
    endedAt: timestamps[timestamps.length - 1] ?? null,
    totalTokensIn: agentNodes.reduce((sum, n) => sum + n.meta.tokensIn, 0),
    totalTokensOut: agentNodes.reduce((sum, n) => sum + n.meta.tokensOut, 0),
    modelsUsed,
    agentCount: agentNodes.length,
    toolCallCount: toolCallNodes.length,
    fileCount: fileNodes.length,
    skippedLines,
  };

  return { nodes: nodeList, edges, meta };
}
