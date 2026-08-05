// Serwer MCP w glassboxie (decyzja D6): JSON-RPC 2.0 na transporcie Streamable
// HTTP, pisany ręcznie na node:http — zero SDK, zgodnie z zasadą zera zależności
// runtime. Cztery narzędzia analizy sesji; parser TS importowany wprost (Node ≥ 22.6
// zdejmuje typy natywnie, potwierdzone przebiegiem w planie endpoint-i-czat.md §1).
// Rejestracja: `claude mcp add --transport http glassbox http://127.0.0.1:4517/mcp`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseSession } from "../src/parser/index.ts";
import { TSV_LEGEND, buildIdMaps, serializeNode, serializeProjection } from "./graphSerializer.mjs";
import { listSessions } from "./sessionsList.mjs";
import { resolveSessionPath } from "./sessionPath.mjs";
import { readSubagentSidecars } from "./subagents.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const LIST_LIMIT_DEFAULT = 10;
const LIST_LIMIT_MAX = 50;

export const TOOLS = [
  {
    name: "list_sessions",
    description:
      "Lista ostatnich sesji Claude Code (ścieżka względna, rozmiar, mtime, liczba węzłów grafu). " +
      "Ścieżka z pola `path` jest parametrem `session` pozostałych narzędzi.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `Ile sesji zwrócić (domyślnie ${LIST_LIMIT_DEFAULT}, max ${LIST_LIMIT_MAX}).` },
      },
    },
  },
  {
    name: "get_session_graph",
    description:
      "Rzut zwinięty grafu sesji w kompaktowym TSV: kręgosłup session → main → subagenci " +
      "zwinięci do jednego wiersza z agregatami (calls/files/errors/cost/pat) — wynik skaluje się " +
      "z liczbą agentów, nie wywołań. Węzły dostają sekwencyjne id n0…nN (stabilne, z pełnego grafu) — " +
      "używaj ich w get_node_detail, highlight_nodes i expand. " +
      "expand=[id agenta] rozwija wskazane poddrzewa; format=full dokłada sekcję detail/output " +
      "widocznych węzłów (drogo — używaj tylko świadomie).",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Ścieżka względna sesji z list_sessions." },
        expand: {
          type: "array",
          items: { type: "string" },
          description: "Id agentów (nX albo oryginalne) do rozwinięcia pełnym poddrzewem.",
        },
        format: { type: "string", enum: ["compact", "full"], description: "Domyślnie compact." },
      },
      required: ["session"],
    },
  },
  {
    name: "get_node_detail",
    description:
      "Pełny detail/output/toolUseResult, sandbox, wzorce i sąsiedztwo jednego węzła (~1200 tokenów). " +
      "node_id to nX z get_session_graph (przyjmuje też oryginalne id).",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Ścieżka względna sesji z list_sessions." },
        node_id: { type: "string", description: "Identyfikator węzła (nX albo oryginalny)." },
      },
      required: ["session", "node_id"],
    },
  },
  {
    name: "highlight_nodes",
    description:
      "Podświetla wskazane węzły w otwartym UI glassboxa (broadcast SSE do podłączonych klientów). " +
      "Puste node_ids gasi podświetlenie. `note` pokazuje się w nagłówku UI.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Ścieżka względna sesji z list_sessions." },
        node_ids: { type: "array", items: { type: "string" }, description: "Identyfikatory nX z get_session_graph." },
        note: { type: "string", description: "Krótka adnotacja wyświetlana przy podświetleniu." },
      },
      required: ["session", "node_ids"],
    },
  },
];

/**
 * @param {{ sessionsDir: string, broadcastHighlight: (absPath: string, payload: object) => number }} deps
 *   broadcastHighlight zwraca liczbę powiadomionych klientów SSE.
 * @returns {(body: unknown) => object | null} handler JSON-RPC; null = notyfikacja (odpowiedź 202 bez treści).
 */
export function createMcpHandler({ sessionsDir, broadcastHighlight }) {
  /** Walidacja sesji WYŁĄCZNIE przez resolveSessionPath — żadnych ścieżek z parametrów wprost. */
  function resolveOrThrow(session) {
    if (typeof session !== "string") throw new Error("Brak parametru `session`.");
    const abs = resolveSessionPath(sessionsDir, session);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`Nieprawidłowa albo nieistniejąca sesja: ${session}`);
    }
    return abs;
  }

  // ponytail: parse per wywołanie (11–36 ms zmierzone), bez cache — sesja live
  // rośnie, a sekwencyjne id pozostają stabilne, bo węzły tylko dochodzą na końcu.
  function loadGraph(session) {
    const abs = resolveOrThrow(session);
    return { abs, graph: parseSession(readFileSync(abs, "utf-8"), readSubagentSidecars(abs)) };
  }

  function toolListSessions(args) {
    const limit = Math.min(Math.max(Math.trunc(Number(args?.limit) || LIST_LIMIT_DEFAULT), 1), LIST_LIMIT_MAX);
    const out = listSessions(sessionsDir, limit).map((s) => {
      let nodes = null;
      try {
        const abs = resolveSessionPath(sessionsDir, s.path);
        if (abs) nodes = parseSession(readFileSync(abs, "utf-8")).nodes.length;
      } catch {
        nodes = null; // sesja nieparsowalna — pokazujemy ją mimo to
      }
      return { path: s.path, size: s.size, mtime: new Date(s.mtime).toISOString(), nodes };
    });
    return JSON.stringify(out, null, 1);
  }

  function toolGetSessionGraph(args) {
    const { graph } = loadGraph(args?.session);
    if (args?.expand !== undefined && !Array.isArray(args.expand)) {
      throw new Error("Parametr `expand` musi być tablicą identyfikatorów agentów.");
    }
    const { idMap } = buildIdMaps(graph);
    const expanded = (args?.expand ?? []).map((id) => toOriginalId(graph, idMap, String(id)));
    const { tsv, reverse, visibleNodes } = serializeProjection(graph, expanded);
    const m = graph.meta;
    const header =
      `# sesja ${m.sessionId ?? "?"} · rzut ${visibleNodes.length}/${graph.nodes.length} węzłów (subagenci zwinięci — rozwiń przez expand)` +
      ` · agentów ${m.agentCount} · narzędzi ${m.toolCallCount} · plików ${m.fileCount}` +
      ` · sidecary ${m.sidecarsAttached} · tokeny ${m.totalTokensIn}/${m.totalTokensOut}`;
    let body = `${header}\n${TSV_LEGEND}\n${tsv}`;
    if (args?.format === "full") {
      const details = visibleNodes
        .map((n) => `${reverse.get(n.id)}\t${n.detail.replace(/[\t\n\r]+/g, " ")}\t${n.output.replace(/[\t\n\r]+/g, " ")}`)
        .join("\n");
      body += `\n# detale (id\tdetail\toutput):\n${details}`;
    }
    return body;
  }

  /** nX → oryginalne id; przyjmuje też oryginalne id (idempotentnie). */
  function toOriginalId(graph, idMap, nodeId) {
    if (idMap.has(nodeId)) return idMap.get(nodeId);
    if (graph.nodes.some((n) => n.id === nodeId)) return nodeId;
    throw new Error(`Nieznany węzeł: ${nodeId}`);
  }

  function toolGetNodeDetail(args) {
    const { graph } = loadGraph(args?.session);
    const { idMap, reverse } = buildIdMaps(graph);
    const orig = toOriginalId(graph, idMap, String(args?.node_id ?? ""));
    return JSON.stringify(serializeNode(graph, orig, reverse), null, 1);
  }

  function toolHighlightNodes(args) {
    const { abs, graph } = loadGraph(args?.session);
    if (!Array.isArray(args?.node_ids)) throw new Error("Parametr `node_ids` musi być tablicą.");
    const { idMap } = buildIdMaps(graph);
    const ids = args.node_ids.map((id) => toOriginalId(graph, idMap, String(id)));
    const clients = broadcastHighlight(abs, {
      ids,
      note: typeof args.note === "string" ? args.note : null,
      ts: new Date().toISOString(),
    });
    return `Podświetlono ${ids.length} węzłów; powiadomieni klienci SSE: ${clients}.`;
  }

  const toolImpls = {
    list_sessions: toolListSessions,
    get_session_graph: toolGetSessionGraph,
    get_node_detail: toolGetNodeDetail,
    highlight_nodes: toolHighlightNodes,
  };

  const result = (id, res) => ({ jsonrpc: "2.0", id, result: res });
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  return function handleMcp(body) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return rpcError(null, -32600, "Oczekiwano pojedynczego obiektu JSON-RPC 2.0.");
    }
    const { id, method, params } = body;
    const isNotification = id === undefined || id === null;

    if (method === "initialize") {
      return result(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "glassbox", version: "0.1.0" },
      });
    }
    if (typeof method === "string" && method.startsWith("notifications/")) return null;
    if (method === "tools/list") return result(id, { tools: TOOLS });
    if (method === "ping") return result(id, {});
    if (method === "tools/call") {
      const impl = toolImpls[params?.name];
      if (!impl) return rpcError(id, -32602, `Nieznane narzędzie: ${params?.name}`);
      try {
        return result(id, { content: [{ type: "text", text: impl(params?.arguments ?? {}) }] });
      } catch (err) {
        // Błąd wykonania narzędzia to wynik dla modelu (isError), nie błąd protokołu.
        return result(id, { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
      }
    }
    if (isNotification) return null;
    return rpcError(id, -32601, `Nieznana metoda: ${method}`);
  };
}
