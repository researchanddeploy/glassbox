import type {
  EdgeType,
  FullDetail,
  GraphEdge,
  GraphNode,
  NodeStatus,
  SessionGraph,
  SessionMeta,
  SubagentSidecar,
} from "./types.ts";
import { classifySandbox, NO_SANDBOX_INFO } from "./sandbox.ts";
import { detectPatterns, detectRetried, type ToolCallSeqEntry } from "./patterns.ts";

const DETAIL_LIMIT = 2000; // ~2 KB w znakach ASCII — limit KART, nie danych (pełnia w details)

const SPAWN_TOOL_NAMES = new Set(["Task", "Agent"]);
const FILE_TOOL_NAMES = new Set(["Read", "Write", "Edit"]);

/**
 * Porządek restrykcyjności trybów uprawnień — eskalacja (§3.6 taksonomii) to
 * przejście na tryb o WYŻSZEJ randze. Wartości zaobserwowane w realnych
 * transkryptach 2026-08-06: plan, auto, bypassPermissions (101 plików, jedyne
 * realne przejścia to plan ⇄ bypassPermissions); reszta z dokumentacji trybów.
 * Tryb spoza mapy nie generuje eskalacji (brak porządku = brak wniosku).
 */
const PERMISSION_MODE_RANK = new Map<string, number>([
  ["plan", 0],
  ["default", 1],
  ["acceptEdits", 2],
  ["auto", 2],
  ["dontAsk", 3],
  ["bypassPermissions", 4],
]);

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
  /** `agentId` na poziomie linii — obecne w każdej linii sidecara subagenta. */
  agentId: string | null;
  /** `subtype` rekordu `system` (turn_duration, compact_boundary, agents_killed…). */
  subtype: string | null;
  /** `attachment.type` rekordu `attachment` (hook_success, diagnostics…). */
  attachmentType: string | null;
  /** Pole `toolUseResult` na poziomie linii — bogatsze niż blok tool_result. */
  toolUseResult: unknown;
  /** `toolDenialKind` — obecne, gdy użytkownik odmówił wykonania narzędzia. */
  toolDenialKind: string | null;
  /** `isApiErrorMessage` — awaria warstwy API/modelu zapisana jako wiadomość. */
  isApiErrorMessage: boolean;
  /** Cały sparsowany rekord — źródło pól rzadkich (turn_duration, compactMetadata, attachment…). */
  raw: Record<string, unknown>;
  role: string | null;
  model: string | null;
  /** `message.id` — TA SAMA wiadomość bywa rozpisana na wiele linii JSONL. */
  messageId: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  /** Podział zapisu cache po TTL; bez podziału w danych całość liczona jako 5m. */
  cacheCreation5m: number;
  cacheCreation1h: number;
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
  const attachment = asRecord(rec.attachment);
  const contentRaw = message ? message.content : null;
  const content: ContentBlock[] = Array.isArray(contentRaw)
    ? contentRaw
        .map((block) => asRecord(block))
        .filter((block): block is Record<string, unknown> => block !== null)
        .map((block) => ({ type: asString(block.type) ?? "unknown", raw: block }))
    : [];

  const cacheCreation = usage ? asNumber(usage.cache_creation_input_tokens) : 0;
  // Warianty TTL: usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens.
  const cacheCreationSplit = usage ? asRecord(usage.cache_creation) : null;
  const cacheCreation1h = cacheCreationSplit ? asNumber(cacheCreationSplit.ephemeral_1h_input_tokens) : 0;
  const cacheCreation5m = cacheCreationSplit
    ? asNumber(cacheCreationSplit.ephemeral_5m_input_tokens)
    : cacheCreation; // brak podziału → domyślny TTL 5m

  return {
    type: asString(rec.type),
    uuid: asString(rec.uuid),
    isSidechain: asBool(rec.isSidechain),
    timestamp: asString(rec.timestamp),
    sessionId: asString(rec.sessionId),
    agentId: asString(rec.agentId),
    subtype: asString(rec.subtype),
    attachmentType: attachment ? asString(attachment.type) : null,
    toolUseResult: rec.toolUseResult ?? null,
    toolDenialKind: asString(rec.toolDenialKind),
    isApiErrorMessage: asBool(rec.isApiErrorMessage),
    raw: rec,
    role: message ? asString(message.role) : null,
    model: message ? asString(message.model) : null,
    messageId: message ? asString(message.id) : null,
    tokensIn: usage ? asNumber(usage.input_tokens) : 0,
    tokensOut: usage ? asNumber(usage.output_tokens) : 0,
    cacheRead: usage ? asNumber(usage.cache_read_input_tokens) : 0,
    cacheCreation,
    cacheCreation5m,
    cacheCreation1h,
    content,
  };
}

interface ToolResultInfo {
  isError: boolean;
  text: string;
  fullText: string;
  /** Pole `toolUseResult` rekordu wyniku (obiekt gdy strukturalne, inaczej surowa wartość). */
  toolUseResult: unknown;
  denied: boolean;
  interrupted: boolean;
  isAsync: boolean;
  /** `toolUseResult.agentId` — deterministyczne dowiązanie sidecara subagenta. */
  agentId: string | null;
  /** Nazwa teammate'a z `toolUseResult.name`/`agent_id` (spawny zespołowe). */
  teammateName: string | null;
}

/** Wyszukuje tool_result po wszystkich plikach (main + sidecary), indeksowane po tool_use_id. */
function indexToolResults(lines: ParsedLine[]): Map<string, ToolResultInfo> {
  const index = new Map<string, ToolResultInfo>();
  for (const line of lines) {
    for (const block of line.content) {
      if (block.type !== "tool_result") continue;
      const toolUseId = asString(block.raw.tool_use_id);
      if (!toolUseId) continue;
      const fullText = contentToText(block.raw.content);
      const result = asRecord(line.toolUseResult);
      const teammateId = result ? asString(result.agent_id) : null;
      index.set(toolUseId, {
        isError: asBool(block.raw.is_error),
        text: truncate(fullText),
        fullText,
        toolUseResult: line.toolUseResult,
        denied: line.toolDenialKind !== null,
        interrupted: result ? asBool(result.interrupted) : false,
        isAsync: result ? asBool(result.isAsync) : false,
        agentId: result ? asString(result.agentId) : null,
        // teammate: `agent_id` ma postać "nazwa@team" — nazwa wiąże spawn z sidecarem
        teammateName: (result ? asString(result.name) : null) ?? teammateId?.split("@")[0] ?? null,
      });
    }
  }
  return index;
}

/**
 * agentId sidecara teammate'a ma postać "a" + nazwa + "-" + sufiks hex
 * (np. "afala-Y-raport-5dd10c9…" → "fala-Y-raport"); anonimowe id ("a004ab…") nie pasują.
 */
function teammateNameFromAgentId(agentId: string): string | null {
  const m = /^a(.+)-[0-9a-f]{12,}$/.exec(agentId);
  return m ? m[1] : null;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeMeta(timestamp: string | null, model: string | null, status: NodeStatus) {
  return {
    timestamp,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    model,
    status,
  };
}

function statusFromResult(result: ToolResultInfo | undefined): NodeStatus {
  if (!result) return "unknown";
  if (result.denied) return "denied";
  if (result.interrupted) return "interrupted";
  if (result.isError) return "error_tool";
  // Spawn asynchroniczny: ack "async_launched" to nie koniec pracy — status domyka
  // dopiero dowiązany sidecar (patrz attachSidecars).
  if (result.isAsync) return "in_progress";
  return "ok";
}

/**
 * Parsuje transkrypt sesji Claude Code (JSONL, jeden obiekt na linię) w graf DAG.
 * Odporny na linie nieparsowalne/nieznane typy — pomija je zamiast się wywalać.
 *
 * Subagenci — dwa empirycznie występujące warianty, oba obsługiwane:
 *  1. sidecar (format współczesny, dominujący) — pełny transkrypt subagenta żyje w
 *     `<sessionId>/subagents/agent-<agentId>.jsonl` obok pliku sesji; wiązanie
 *     deterministyczne po `toolUseResult.agentId` spawnu (albo `meta.toolUseId`),
 *     dla teammate'ów po nazwie. Sidecary podaje drugi argument.
 *  2. inline sidechain (zgodność wsteczna) — linie `isSidechain: true` w pliku
 *     głównym między wywołaniem Task/Agent a jego tool_result. We współczesnych
 *     transkryptach głównych nie występuje (0 linii na 17 179 zbadanych), ale
 *     starsze harnessy tak pisały — ścieżka zostaje (no-deletion).
 *
 * Pułapka tokenów: jedna wiadomość asystenta bywa rozpisana na wiele linii JSONL
 * (jedna na blok treści), a KAŻDA linia powtarza ten sam pełny `usage` — w tym
 * `cache_read_input_tokens`, zwykle największy składnik. Naiwna suma po liniach
 * zawyża o rzędy wielkości (zmierzone 460 mln tokenów). Dlatego usage liczymy
 * raz per `message.id`.
 */
export function parseSession(jsonl: string, subagents: SubagentSidecar[] = []): SessionGraph {
  idCounter = 0;
  let skippedLines = 0;

  function parseLines(raw: string): ParsedLine[] {
    const out: ParsedLine[] = [];
    for (const rawLine of raw.split("\n")) {
      if (rawLine.trim().length === 0) continue;
      const parsed = parseLine(rawLine);
      if (parsed) out.push(parsed);
      else skippedLines += 1;
    }
    return out;
  }

  const mainLines = parseLines(jsonl);
  const sidecars = subagents.map((s) => ({
    lines: parseLines(s.jsonl),
    meta: asRecord(s.meta ?? null),
  }));

  // Indeks wyników po wszystkich plikach — wyniki zagnieżdżonych spawnów żyją w sidecarach.
  const toolResults = indexToolResults([...mainLines, ...sidecars.flatMap((s) => s.lines)]);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const details = new Map<string, FullDetail>();
  const fileNodeByPath = new Map<string, string>();
  const systemSubtypeCounts: Record<string, number> = {};
  const attachmentTypeCounts: Record<string, number> = {};

  // Dowiązania sidecarów: agentId → węzeł, tool_use.id spawnu → węzeł, nazwa teammate'a → węzły.
  const agentIdToNode = new Map<string, string>();
  const toolUseIdToAgentNode = new Map<string, string>();
  const teammateNameNodes = new Map<string, string[]>();

  // Usage liczone raz per message.id (patrz komentarz nad parseSession).
  const seenUsageKeys = new Set<string>();

  // Taksonomia (ojacie-5hn): węzły task per taskId, ścieżki odczytane Readem
  // (detekcja `abandoned`) i sekwencja wywołań (detekcja `retried`).
  const taskNodeByTaskId = new Map<string, string>();
  const readPaths = new Set<string>();
  const toolCallSeq: ToolCallSeqEntry[] = [];

  const sessionId = mainLines.find((l) => l.sessionId)?.sessionId ?? null;
  const sessionNodeId = "session";
  nodes.set(sessionNodeId, {
    id: sessionNodeId,
    type: "session",
    label: sessionId ? `sesja ${sessionId.slice(0, 8)}` : "sesja",
    detail: "",
    output: "",
    meta: makeMeta(mainLines[0]?.timestamp ?? null, null, "unknown"),
    sandbox: NO_SANDBOX_INFO,
    patterns: [],
  });

  const mainAgentId = "agent-main";
  nodes.set(mainAgentId, {
    id: mainAgentId,
    type: "agent",
    label: "main",
    detail: "",
    output: "",
    meta: makeMeta(mainLines[0]?.timestamp ?? null, null, "ok"),
    sandbox: NO_SANDBOX_INFO,
    patterns: [],
  });
  edges.push({ id: nextId("edge"), type: "spawns", source: sessionNodeId, target: mainAgentId });

  function addEdge(type: EdgeType, source: string, target: string) {
    edges.push({ id: nextId("edge"), type, source, target });
  }

  function accumulateUsage(node: GraphNode, line: ParsedLine) {
    const key = line.messageId ?? line.uuid;
    if (key) {
      if (seenUsageKeys.has(key)) return;
      seenUsageKeys.add(key);
    }
    node.meta.tokensIn += line.tokensIn;
    node.meta.tokensOut += line.tokensOut;
    node.meta.cacheReadTokens += line.cacheRead;
    node.meta.cacheCreationTokens += line.cacheCreation;
    node.meta.cacheCreation5mTokens += line.cacheCreation5m;
    node.meta.cacheCreation1hTokens += line.cacheCreation1h;
    if (line.model) node.meta.model = line.model;
    if (line.timestamp && !node.meta.timestamp) node.meta.timestamp = line.timestamp;
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
    patterns: [],
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

  function registerSpawnLinks(nodeId: string, toolUseId: string, result: ToolResultInfo | undefined) {
    toolUseIdToAgentNode.set(toolUseId, nodeId);
    if (!result) return;
    if (result.agentId) agentIdToNode.set(result.agentId, nodeId);
    if (result.teammateName) {
      const list = teammateNameNodes.get(result.teammateName) ?? [];
      list.push(nodeId);
      teammateNameNodes.set(result.teammateName, list);
    }
  }

  /**
   * Przetwarza jeden plik transkryptu, przypisując pracę do `rootAgentId`.
   * `allowInlineSidechain` włącza historyczną mechanikę przełączania wątku w pliku
   * głównym; w sidecarach KAŻDA linia ma `isSidechain: true`, więc tam jest wyłączona.
   */
  function processFile(lines: ParsedLine[], rootAgentId: string, allowInlineSidechain: boolean) {
    let activeAgentId = rootAgentId;
    let pendingSpawn: { agentId: string; toolUseId: string } | null = null;

    // Stan tury (taksonomia): `turn_duration` domyka turę i tworzy węzeł `turn`;
    // do tego czasu zbieramy sygnały błędu API i blokady bramki (stop hook).
    // ponytail: tura urwana bez turn_duration (koniec pliku) nie dostaje węzła.
    let turnIndex = 0;
    let apiErrorInTurn = false;
    let gateBlockedInTurn = false;
    // Tryb uprawnień (§3.6): rekordy `permission-mode` niosą wyłącznie
    // {type, permissionMode, sessionId} — bez uuid i timestampu, więc jedynym
    // kotwiczeniem jest pozycja w pliku. Zmianę na tryb luźniejszy przypinamy
    // do tury, w której zaszła (taxo.permEscalation węzła turn).
    let permMode: string | null = null;
    let permEscalationInTurn: string | null = null;
    // Okno ostatnich 5 wywołań — wiązanie `diagnostics.isNew` z edycją (§3.8).
    const recentTools: { nodeId: string; name: string; path: string | null }[] = [];

    function emitTaxoNode(
      type: "turn" | "task" | "checkpoint",
      id: string,
      label: string,
      detail: string,
      line: ParsedLine,
      status: NodeStatus,
      taxo?: GraphNode["taxo"],
    ): GraphNode {
      const node: GraphNode = {
        id,
        type,
        label,
        detail,
        output: "",
        meta: makeMeta(line.timestamp, null, status),
        sandbox: NO_SANDBOX_INFO,
        patterns: [],
        ...(taxo ? { taxo } : {}),
      };
      nodes.set(id, node);
      addEdge("calls", activeAgentId, id);
      return node;
    }

    for (const line of lines) {
      if (line.isApiErrorMessage) apiErrorInTurn = true;

      if (line.type === "system") {
        const key = line.subtype ?? "unknown";
        systemSubtypeCounts[key] = (systemSubtypeCounts[key] ?? 0) + 1;
        if (line.subtype === "turn_duration") {
          turnIndex += 1;
          const durationMs = asNumber(line.raw.durationMs);
          const pending = asNumber(line.raw.pendingBackgroundAgentCount);
          const messageCount = asNumber(line.raw.messageCount);
          const parts = [`${Math.round(durationMs / 1000)} s`, `${messageCount} wiadomości`];
          if (pending > 0) parts.push(`${pending} w tle`);
          emitTaxoNode("turn", nextId("turn"), `tura ${turnIndex}`, parts.join(" · "), line,
            apiErrorInTurn ? "error_api" : "ok",
            {
              durationMs,
              pendingBackgroundAgents: pending,
              ...(gateBlockedInTurn ? { gateBlocked: true } : {}),
              ...(permEscalationInTurn !== null ? { permEscalation: permEscalationInTurn } : {}),
            });
          apiErrorInTurn = false;
          gateBlockedInTurn = false;
          permEscalationInTurn = null;
        } else if (line.subtype === "compact_boundary") {
          const cm = asRecord(line.raw.compactMetadata);
          const dropped = cm ? asNumber(cm.cumulativeDroppedTokens) : 0;
          const detail = cm ? `pre ${asNumber(cm.preTokens)} → post ${asNumber(cm.postTokens)} · odrzucono ${dropped}` : "";
          emitTaxoNode("checkpoint", nextId("chk"), "kompakcja", detail, line, "ok", { droppedTokens: dropped });
        } else if (line.subtype === "stop_hook_summary") {
          const hookErrors = line.raw.hookErrors;
          if (asBool(line.raw.preventedContinuation) || (Array.isArray(hookErrors) && hookErrors.length > 0)) {
            gateBlockedInTurn = true;
          }
        }
        continue;
      }
      if (line.type === "attachment") {
        const key = line.attachmentType ?? "unknown";
        attachmentTypeCounts[key] = (attachmentTypeCounts[key] ?? 0) + 1;
        const att = asRecord(line.raw.attachment);
        if (line.attachmentType === "diagnostics" && att && asBool(att.isNew)) {
          // Regresja diagnostyczna: nowa diagnostyka LSP → ostatni Edit/Write
          // w oknie 5 wywołań (preferencja: zgodność ścieżki z attachment.files).
          const files = Array.isArray(att.files) ? att.files.filter((f): f is string => typeof f === "string") : [];
          const edits = recentTools.filter((t) => t.name === "Edit" || t.name === "Write");
          const target = edits.findLast((t) => t.path !== null && files.includes(t.path)) ?? edits.at(-1);
          const targetNode = target ? nodes.get(target.nodeId) : undefined;
          if (targetNode) targetNode.taxo = { ...targetNode.taxo, newDiagnostics: true };
        } else if (line.attachmentType === "hook_cancelled") {
          gateBlockedInTurn = true;
        } else if (line.attachmentType === "task_status" && att) {
          const taskId = asString(att.taskId);
          if (taskId) {
            const rawStatus = asString(att.status) ?? "";
            const status: NodeStatus =
              rawStatus === "completed" ? "ok"
              : rawStatus === "failed" || rawStatus === "error" ? "error_tool"
              : rawStatus === "cancelled" ? "interrupted"
              : "in_progress";
            const label = asString(att.description) ?? `zadanie ${taskId.slice(0, 8)}`;
            const detail = [asString(att.taskType), rawStatus, asString(att.deltaSummary)].filter(Boolean).join(" · ");
            const existingId = taskNodeByTaskId.get(taskId);
            const existing = existingId ? nodes.get(existingId) : undefined;
            if (existing) {
              // Kolejny task_status tego samego zadania: ostatni stan wygrywa, bez nowego węzła.
              existing.meta.status = status;
              existing.detail = detail;
              existing.label = label;
            } else {
              const id = `task-${taskId}`;
              taskNodeByTaskId.set(taskId, id);
              emitTaxoNode("task", id, label, detail, line, status);
            }
          }
        }
        continue;
      }
      if (line.type === "file-history-snapshot") {
        // Drugie źródło checkpointów wg słownika (§2): snapshot historii plików.
        emitTaxoNode("checkpoint", nextId("chk"), "snapshot plików", "", line, "ok");
        continue;
      }
      if (line.type === "permission-mode") {
        // Rekord stanu, powtarzany wielokrotnie z tą samą wartością — interesuje
        // nas wyłącznie ZMIANA na tryb luźniejszy (wyższa ranga). Pierwszy rekord
        // to stan początkowy sesji, nie eskalacja.
        const mode = asString(line.raw.permissionMode);
        if (mode !== null && mode !== permMode) {
          const prev = permMode !== null ? PERMISSION_MODE_RANK.get(permMode) : undefined;
          const next = PERMISSION_MODE_RANK.get(mode);
          if (prev !== undefined && next !== undefined && next > prev) {
            permEscalationInTurn = `${permMode} → ${mode}`;
          }
          permMode = mode;
        }
        continue;
      }

      if (allowInlineSidechain) {
        if (line.isSidechain) {
          // Kontynuacja wątku subagenta (inline sidechain).
          if (pendingSpawn) activeAgentId = pendingSpawn.agentId;
        } else if (activeAgentId !== rootAgentId) {
          // Wróciliśmy do głównego wątku bez jawnego tool_result — reset.
          activeAgentId = rootAgentId;
        }
      }

      const agentNode = nodes.get(activeAgentId);
      if (agentNode && line.role === "assistant") {
        accumulateUsage(agentNode, line);
      }

      for (const block of line.content) {
        if (block.type === "tool_use") {
          const name = asString(block.raw.name) ?? "unknown";
          const toolUseId = asString(block.raw.id) ?? nextId("tool");
          const input = asRecord(block.raw.input) ?? {};
          const result = toolResults.get(toolUseId);
          const status = statusFromResult(result);

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
            patterns: [],
            });
            details.set(subagentId, {
              input: prompt,
              output: result?.fullText ?? "",
              toolUseResult: result?.toolUseResult ?? null,
            });
            addEdge("spawns", activeAgentId, subagentId);
            registerSpawnLinks(subagentId, toolUseId, result);
            pendingSpawn = { agentId: subagentId, toolUseId };
            continue;
          }

          const toolNodeId = `tool-${toolUseId}`;
          const inputSummary = toolInputSummary(name, input);
          nodes.set(toolNodeId, {
            id: toolNodeId,
            type: "tool_call",
            label: name,
            detail: truncate(inputSummary),
            output: result?.text ?? "",
            meta: makeMeta(line.timestamp, agentNode?.meta.model ?? null, status),
            sandbox: classifySandbox(name, input),
            patterns: [],
          });
          details.set(toolNodeId, {
            input: inputSummary,
            output: result?.fullText ?? "",
            toolUseResult: result?.toolUseResult ?? null,
          });
          addEdge("calls", activeAgentId, toolNodeId);

          // Taksonomia: sekwencja wywołań (retried), okno diagnostyki, odczyty (abandoned).
          toolCallSeq.push({ nodeId: toolNodeId, key: `${name} ${JSON.stringify(input)}`, isError: result?.isError ?? false });
          const toolPath = asString(input.file_path);
          recentTools.push({ nodeId: toolNodeId, name, path: toolPath });
          if (recentTools.length > 5) recentTools.shift();
          if (name === "Read" && toolPath) readPaths.add(toolPath);

          if (FILE_TOOL_NAMES.has(name)) {
            const path = asString(input.file_path);
            if (path) {
              const fileId = fileNodeFor(path, line.timestamp);
              addEdge("touches", toolNodeId, fileId);
            }
          }
        } else if (block.type === "tool_result" && allowInlineSidechain) {
          const toolUseId = asString(block.raw.tool_use_id);
          if (toolUseId && pendingSpawn && pendingSpawn.toolUseId === toolUseId) {
            // Subagent inline zakończony — wracamy do głównego wątku.
            const spawned = nodes.get(pendingSpawn.agentId);
            if (spawned && spawned.meta.status !== "in_progress") {
              spawned.meta.status = asBool(block.raw.is_error) ? "error_tool" : "ok";
            }
            pendingSpawn = null;
            activeAgentId = rootAgentId;
          }
        }
      }
    }
  }

  processFile(mainLines, mainAgentId, true);

  // --- Sklejanie sidecarów subagentów ---------------------------------------
  // Kolejność rozwiązywania: agentId spawnu → meta.toolUseId → nazwa teammate'a →
  // rodzic z meta.parentAgentId → main. Pętla do punktu stałego, bo węzeł-rodzic
  // zagnieżdżonego sidecara (spawnDepth > 1) powstaje dopiero przy przetwarzaniu
  // sidecara nadrzędnego.
  let sidecarsAttached = 0;

  function sidecarAgentId(sc: { lines: ParsedLine[]; meta: Record<string, unknown> | null }): string | null {
    return sc.lines.find((l) => l.agentId)?.agentId ?? null;
  }

  function resolveExistingNode(sc: { lines: ParsedLine[]; meta: Record<string, unknown> | null }): string | null {
    const agentId = sidecarAgentId(sc);
    if (agentId) {
      const byAgentId = agentIdToNode.get(agentId);
      if (byAgentId) return byAgentId;
    }
    const toolUseId = sc.meta ? asString(sc.meta.toolUseId) : null;
    if (toolUseId) {
      const byToolUse = toolUseIdToAgentNode.get(toolUseId);
      if (byToolUse) return byToolUse;
    }
    const name = (sc.meta ? asString(sc.meta.name) : null) ?? (agentId ? teammateNameFromAgentId(agentId) : null);
    if (name) {
      const candidates = teammateNameNodes.get(name);
      if (candidates && candidates.length > 0) return candidates.shift() ?? null;
    }
    return null;
  }

  function attachSidecar(sc: { lines: ParsedLine[]; meta: Record<string, unknown> | null }, nodeId: string) {
    const node = nodes.get(nodeId);
    if (node && node.meta.status === "in_progress") {
      // Brak twardego sygnału końca pracy asynchronicznej — obecność pełnego
      // sidecara traktujemy jako domknięcie. ponytail: heurystyka; upgrade =
      // attachment task_status / system agents_killed per agent.
      node.meta.status = "ok";
    }
    const agentId = sidecarAgentId(sc);
    if (agentId) agentIdToNode.set(agentId, nodeId);
    processFile(sc.lines, nodeId, false);
    sidecarsAttached += 1;
  }

  function createSidecarNode(sc: { lines: ParsedLine[]; meta: Record<string, unknown> | null }, parentNodeId: string): string {
    const agentId = sidecarAgentId(sc) ?? nextId("sidecar");
    const meta = sc.meta;
    const label =
      (meta ? asString(meta.description) ?? asString(meta.name) ?? asString(meta.agentType) : null) ??
      `agent ${agentId.slice(0, 10)}`;
    const nodeId = `agent-${agentId}`;
    nodes.set(nodeId, {
      id: nodeId,
      type: "agent",
      label,
      detail: "",
      output: "",
      meta: makeMeta(sc.lines[0]?.timestamp ?? null, meta ? asString(meta.agentType) : null, "ok"),
      sandbox: NO_SANDBOX_INFO,
    patterns: [],
    });
    addEdge("spawns", parentNodeId, nodeId);
    return nodeId;
  }

  let pendingSidecars = [...sidecars];
  while (pendingSidecars.length > 0) {
    // Najpierw WSZYSTKIE dowiązania do istniejących węzłów spawnu (fixpoint) —
    // fallback po parentAgentId nie może ubiec węzła spawnu, który powstanie
    // dopiero przy przetwarzaniu sidecara nadrzędnego.
    let progress = true;
    while (progress) {
      progress = false;
      pendingSidecars = pendingSidecars.filter((sc) => {
        const existing = resolveExistingNode(sc);
        if (!existing) return true;
        attachSidecar(sc, existing);
        progress = true;
        return false;
      });
    }
    if (pendingSidecars.length === 0) break;

    // Dopiero teraz jedno utworzenie węzła z meta.parentAgentId (np. teammate
    // bez toolUseId) — i powrót do dowiązań, bo mogło odblokować kolejne.
    const idx = pendingSidecars.findIndex((sc) => {
      const parentAgentId = sc.meta ? asString(sc.meta.parentAgentId) : null;
      return parentAgentId !== null && agentIdToNode.has(parentAgentId);
    });
    if (idx >= 0) {
      const [sc] = pendingSidecars.splice(idx, 1);
      const parentAgentId = asString(sc.meta?.parentAgentId ?? null) as string;
      attachSidecar(sc, createSidecarNode(sc, agentIdToNode.get(parentAgentId) ?? mainAgentId));
      continue;
    }

    // Reszta bez żadnego dowiązania — uczciwie pod main, nie gubimy transkryptów.
    for (const sc of pendingSidecars) {
      attachSidecar(sc, createSidecarNode(sc, mainAgentId));
    }
    pendingSidecars = [];
  }

  // --- Statusy pochodne i wzorce (taksonomia, ojacie-5hn) ---------------------
  // `retried`: błędne wywołanie z późniejszym identycznym bliźniakiem (§4).
  for (const nodeId of detectRetried(toolCallSeq)) {
    const node = nodes.get(nodeId);
    if (node && node.meta.status === "error_tool") node.meta.status = "retried";
  }
  // `abandoned`: spawn async bez sidecara, którego outputFile nie został odczytany
  // do końca sesji. ponytail: „odczyt" = Read po dokładnej ścieżce; w sesji live
  // świeży spawn może chwilowo nosić `abandoned`, zanim ktoś odbierze wynik.
  for (const node of nodes.values()) {
    if (node.meta.status !== "in_progress") continue;
    const tur = asRecord(details.get(node.id)?.toolUseResult ?? null);
    const outputFile = tur ? asString(tur.outputFile) : null;
    if (outputFile && !readPaths.has(outputFile)) node.meta.status = "abandoned";
  }
  const nodeList = Array.from(nodes.values());
  for (const [nodeId, patterns] of detectPatterns(nodeList)) {
    const node = nodes.get(nodeId);
    if (node) node.patterns = patterns;
  }
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
    totalCacheReadTokens: agentNodes.reduce((sum, n) => sum + n.meta.cacheReadTokens, 0),
    totalCacheCreationTokens: agentNodes.reduce((sum, n) => sum + n.meta.cacheCreationTokens, 0),
    modelsUsed,
    agentCount: agentNodes.length,
    toolCallCount: toolCallNodes.length,
    fileCount: fileNodes.length,
    sidecarsAttached,
    systemSubtypeCounts,
    attachmentTypeCounts,
    skippedLines,
  };

  return { nodes: nodeList, edges, meta, details };
}
