import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseSession } from "./parser";
import type { GraphNode, SessionGraph, SessionMeta, SubagentSidecar } from "./parser/types";
import { layoutProjected } from "./layout/elkLayout";
import { MAIN_AGENT_ID, projectGraph } from "./layout/collapse";
import { AgentGroupNode, AgentNode, FileNode, IsolationGroupNode, SessionNode, ToolCallNode } from "./nodes/nodeCards";
import { ChannelEdge } from "./nodes/channelEdge";
import { computeReplayChannel, neighborIdsOf, type ReplayItem } from "./channels";
import { setChannels } from "./channelStore";
import { DetailPanel } from "./DetailPanel";
import { Scrubber } from "./Scrubber";
import { aggregateSessionCost, formatUsd } from "./pricing";
import { toEpoch } from "./time";

const DEFAULT_SERVER_ADDR = "http://localhost:4517";
const SERVER_ADDR_KEY = "glassbox.serverAddr";
const LAST_SESSION_KEY = "glassbox.lastSession";
const LIVE_DEBOUNCE_MS = 500;

interface SessionEntry {
  path: string;
  size: number;
  mtime: number;
}

/** Rozmiar pliku w jednostce czytelnej dla człowieka (B/KB/MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LEGEND_ITEMS = [
  { label: "unsandboxed", color: "#d9455f" },
  { label: "network", color: "#4f7cff" },
  { label: "container", color: "#aa3bff" },
];

/** Legenda badge'y granicy sandboxa, w rogu kanwy. */
function Legend() {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 5,
        background: "#fff",
        border: "1px solid #e5e4e7",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 11,
        color: "#333",
        boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: "#6b6375", textTransform: "uppercase", fontSize: 10 }}>
        Granica sandboxa
      </div>
      {LEGEND_ITEMS.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          {item.label}
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span style={{ width: 14, height: 8, border: "1.5px dashed #4f7cff", flexShrink: 0 }} />
        worktree/container (obrys)
      </div>
    </div>
  );
}

const nodeTypes = {
  session: SessionNode,
  agent: AgentNode,
  tool_call: ToolCallNode,
  file: FileNode,
  isolationGroup: IsolationGroupNode,
  agentGroup: AgentGroupNode,
};

// Domyślna krawędź z kanałami selekcji/replay (klasy gb-* przez store + CSS).
const edgeTypes = { default: ChannelEdge };

const GROUP_TYPES = new Set(["isolationGroup", "agentGroup"]);

export default function App() {
  // Pełny graf sesji żyje poza React Flow; do <ReactFlow> trafia rzut
  // (projectGraph) przeliczony przez ELK po każdej zmianie zwinięcia.
  const [graph, setGraph] = useState<SessionGraph | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([MAIN_AGENT_ID]));
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sidecary subagentów bieżącej sesji (fetch z /subagents przy wyborze sesji).
  const sidecarsRef = useRef<SubagentSidecar[]>([]);
  // Instancja React Flow do fitView({ nodes }) po kliknięciu węzła.
  const rfRef = useRef<ReactFlowInstance | null>(null);

  // Replay: timeline liczona raz przy wczytaniu, layout policzony raz — scrubber
  // zmienia tylko widoczność (opacity), nigdy nie przelicza elk.
  const [timestamps, setTimestamps] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Live mode: SSE do server/live.mjs, akumulacja linii JSONL, reparse debounced.
  const [liveStatus, setLiveStatus] = useState<"off" | "connected" | "disconnected">("off");
  const liveRawRef = useRef("");
  const followRef = useRef(true); // "follow": nowe dane trzymają scrubber na końcu osi
  const esRef = useRef<EventSource | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Katalog sesji: adres serwera + wybrana sesja trzymane w localStorage między wizytami.
  const [serverAddr, setServerAddr] = useState(() => localStorage.getItem(SERVER_ADDR_KEY) ?? DEFAULT_SERVER_ADDR);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [resumeOffer, setResumeOffer] = useState<string | null>(() => localStorage.getItem(LAST_SESSION_KEY));

  useEffect(() => {
    localStorage.setItem(SERVER_ADDR_KEY, serverAddr);
  }, [serverAddr]);

  useEffect(() => {
    if (selectedSession) localStorage.setItem(LAST_SESSION_KEY, selectedSession);
  }, [selectedSession]);

  const fetchSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const res = await fetch(`${serverAddr}/sessions`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      }
      setSessions((await res.json()) as SessionEntry[]);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    }
  }, [serverAddr]);

  const loadJsonl = useCallback(async (text: string, opts?: { follow?: boolean; resetSelection?: boolean }) => {
    const follow = opts?.follow ?? true;
    if (opts?.resetSelection ?? true) {
      setSelected(null);
      // Nowa sesja startuje z widokiem domyślnym: kręgosłup session → main →
      // subagenci zwinięci; rozwinięcie to jawna akcja użytkownika.
      setExpanded(new Set([MAIN_AGENT_ID]));
    }
    setError(null);
    try {
      const parsed = parseSession(text, sidecarsRef.current);
      const ts = Array.from(
        new Set(parsed.nodes.map((n) => toEpoch(n.meta.timestamp)).filter((t): t is number => t !== null)),
      ).sort((a, b) => a - b);
      setGraph(parsed);
      setMeta(parsed.meta);
      setTimestamps(ts);
      if (follow) setIndex(ts.length > 0 ? ts.length - 1 : 0); // domyślnie: pełny graf
      setPlaying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const toggleAgent = useCallback((agentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  // Rzut grafu + layout zagnieżdżony ELK po każdej zmianie grafu albo zwinięcia.
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    const projected = projectGraph(graph.nodes, graph.edges, expanded);
    layoutProjected(projected).then(({ nodes, edges }) => {
      if (cancelled) return;
      setFlowNodes(
        nodes.map((n) =>
          n.type === "agent" || n.type === "agentGroup" ? { ...n, data: { ...n.data, onToggle: toggleAgent } } : n,
        ),
      );
      setFlowEdges(edges);
    });
    return () => {
      cancelled = true;
    };
  }, [graph, expanded, toggleAgent]);

  const stopLive = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setLiveStatus("off");
  }, []);

  const startLive = useCallback(
    (sessionOverride?: string) => {
      const session = sessionOverride ?? selectedSession ?? undefined;
      stopLive();
      setSelected(null);
      liveRawRef.current = "";
      followRef.current = true;
      if (session) setSelectedSession(session);
      // Sidecary subagentów: jeden fetch przy starcie sesji; po nadejściu reparse,
      // bo backlog SSE mógł już zbudować graf bez nich. ponytail: bez tail sidecarów.
      sidecarsRef.current = [];
      const subagentsUrl = session
        ? `${serverAddr}/subagents?session=${encodeURIComponent(session)}`
        : `${serverAddr}/subagents`;
      fetch(subagentsUrl)
        .then((r) => (r.ok ? (r.json() as Promise<SubagentSidecar[]>) : []))
        .then((sidecars) => {
          sidecarsRef.current = sidecars;
          if (sidecars.length > 0 && liveRawRef.current.length > 0) {
            loadJsonl(liveRawRef.current, { follow: followRef.current, resetSelection: false });
          }
        })
        .catch(() => {}); // brak sidecarów ≠ awaria — graf główny działa bez nich
      const url = session ? `${serverAddr}/events?session=${encodeURIComponent(session)}` : `${serverAddr}/events`;
      const es = new EventSource(url);
      esRef.current = es;
      const scheduleUpdate = () => {
        if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
          loadJsonl(liveRawRef.current, { follow: followRef.current, resetSelection: false });
        }, LIVE_DEBOUNCE_MS);
      };
      es.addEventListener("open", () => setLiveStatus("connected"));
      es.addEventListener("error", () => setLiveStatus("disconnected")); // EventSource sam ponawia próbę
      es.addEventListener("backlog", (ev) => {
        const lines = JSON.parse((ev as MessageEvent).data) as string[];
        if (lines.length > 0) liveRawRef.current += lines.join("\n") + "\n";
        scheduleUpdate();
      });
      es.addEventListener("line", (ev) => {
        liveRawRef.current += (ev as MessageEvent).data + "\n";
        scheduleUpdate();
      });
    },
    [loadJsonl, serverAddr, selectedSession, stopLive],
  );

  const toggleLive = useCallback(() => {
    if (esRef.current) stopLive();
    else startLive();
  }, [startLive, stopLive]);

  const selectSession = useCallback(
    (path: string) => {
      if (path) startLive(path);
    },
    [startLive],
  );

  const resumeLastSession = useCallback(() => {
    if (resumeOffer) startLive(resumeOffer);
    setResumeOffer(null);
  }, [resumeOffer, startLive]);

  useEffect(() => () => stopLive(), [stopLive]);

  // Suwak ruszony ręcznie (drag, strzałki, play/pauza) — wyłącz "follow" trybu live.
  const handleIndexChange = useCallback((i: number) => {
    followRef.current = false;
    setIndex(i);
  }, []);

  const currentTime = timestamps[index] ?? null;

  // Kanał replay bez przepisywania tablic: krok scrubbera aktualizuje store
  // kanałów (klasy CSS w kartach/krawędziach), a `flowNodes`/`flowEdges`
  // zachowują tożsamość — React Flow nie rekonsyliuje wtedy żadnego węzła.
  // Obrysy grup nie mają własnego czasu, więc nie uczestniczą w replayu.
  const replayItems = useMemo<ReplayItem[]>(
    () =>
      flowNodes
        .filter((n) => !GROUP_TYPES.has(n.type ?? ""))
        .map((n) => ({ id: n.id, epoch: toEpoch((n.data as { node: GraphNode }).node.meta.timestamp) })),
    [flowNodes],
  );
  const replay = useMemo(() => computeReplayChannel(replayItems, currentTime), [replayItems, currentTime]);
  useEffect(() => {
    setChannels({ replayDimmedIds: replay.dimmedIds, activeId: replay.activeId });
  }, [replay]);

  // Kanał selekcji: obwódka klikniętego + sąsiedzi 1-hop, reszta wygaszona przez CSS.
  const neighborIds = useMemo(
    () => (selected ? neighborIdsOf(flowEdges, selected.id) : new Set<string>()),
    [selected, flowEdges],
  );
  useEffect(() => {
    setChannels({ selectedId: selected?.id ?? null, neighborIds });
  }, [selected, neighborIds]);

  const activeNode = useMemo<GraphNode | null>(() => {
    if (replay.activeId === null) return null;
    const n = flowNodes.find((fn) => fn.id === replay.activeId);
    return n ? (n.data as { node: GraphNode }).node : null;
  }, [replay.activeId, flowNodes]);

  // Handlery React Flow MUSZĄ być memoizowane: nowa referencja trafia do store'u
  // React Flow i re-renderuje wszystkie NodeWrappery przy każdym re-renderze App
  // (zmierzone: 82 karty × krok scrubbera mimo tożsamej tablicy węzłów).
  const onInit = useCallback((inst: ReactFlowInstance) => {
    rfRef.current = inst;
  }, []);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      if (GROUP_TYPES.has(n.type ?? "")) return; // obrys grupy nie ma panelu szczegółów
      setSelected((n.data as { node: GraphNode }).node);
      // Quick win: kadruj kliknięty węzeł z sąsiadami 1-hop (kanał selekcji).
      const ids = [n.id, ...neighborIdsOf(flowEdges, n.id)];
      rfRef.current?.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, duration: 400, maxZoom: 1.2 });
    },
    [flowEdges],
  );

  // Podczas odtwarzania panel szczegółów podąża za aktywnym węzłem.
  useEffect(() => {
    if (playing && activeNode) setSelected(activeNode);
  }, [playing, activeNode]);

  // Koszt liczony z PEŁNEGO grafu, nie z rzutu — zwinięci agenci nie znikają z sumy.
  const costSummary = useMemo(
    () => aggregateSessionCost(graph?.nodes.filter((n) => n.type === "agent") ?? []),
    [graph],
  );

  const onFileInput = useCallback(
    (file: File) => {
      sidecarsRef.current = []; // plik z dysku nie niesie sidecarów — tylko graf główny
      file.text().then((text) => loadJsonl(text));
    },
    [loadJsonl],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) onFileInput(file);
    },
    [onFileInput],
  );

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #e5e4e7",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <strong>Glassbox</strong>
        <label style={{ cursor: "pointer", fontSize: 13, color: "#aa3bff" }}>
          wczytaj .jsonl
          <input
            type="file"
            accept=".jsonl"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFileInput(file);
            }}
          />
        </label>
        <input
          type="text"
          value={serverAddr}
          onChange={(e) => setServerAddr(e.target.value)}
          title="adres serwera live"
          style={{
            width: 170,
            fontSize: 12,
            padding: "3px 6px",
            border: "1px solid #e5e4e7",
            borderRadius: 6,
            color: "#6b6375",
          }}
        />
        <select
          value={selectedSession ?? ""}
          onFocus={fetchSessions}
          onChange={(e) => selectSession(e.target.value)}
          style={{ fontSize: 12, padding: "3px 6px", border: "1px solid #e5e4e7", borderRadius: 6, maxWidth: 260 }}
        >
          <option value="">wybierz sesję…</option>
          {sessions.map((s) => (
            <option key={s.path} value={s.path}>
              {s.path} — {formatBytes(s.size)} — {new Date(s.mtime).toLocaleString()}
            </option>
          ))}
        </select>
        {sessionsError && <span style={{ fontSize: 12, color: "#d9455f" }}>{sessionsError}</span>}
        {resumeOffer && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b6375" }}>
            wznowić ostatnią sesję?
            <button
              onClick={resumeLastSession}
              style={{ cursor: "pointer", fontSize: 12, color: "#aa3bff", border: "none", background: "none" }}
            >
              wznów
            </button>
            <button
              onClick={() => setResumeOffer(null)}
              style={{ cursor: "pointer", fontSize: 12, color: "#6b6375", border: "none", background: "none" }}
            >
              pomiń
            </button>
          </span>
        )}
        <button
          onClick={toggleLive}
          style={{
            cursor: "pointer",
            fontSize: 13,
            color: liveStatus === "off" ? "#aa3bff" : "#fff",
            background: liveStatus === "off" ? "transparent" : "#aa3bff",
            border: "1px solid #aa3bff",
            borderRadius: 6,
            padding: "3px 10px",
          }}
        >
          {liveStatus === "off" ? "Live" : "zatrzymaj live"}
        </button>
        {liveStatus !== "off" && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6b6375" }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: liveStatus === "connected" ? "#22a06b" : "#d9455f",
                display: "inline-block",
              }}
            />
            {liveStatus === "connected" ? "połączono" : "rozłączono"}
          </span>
        )}
        {meta && (
          <span style={{ fontSize: 12, color: "#6b6375" }}>
            agentów: {meta.agentCount} · narzędzi: {meta.toolCallCount} · plików: {meta.fileCount} · tokeny:{" "}
            {meta.totalTokensIn}/{meta.totalTokensOut} · koszt: {formatUsd(costSummary.cost.total)}
            {costSummary.partial ? "+" : ""} (we {formatUsd(costSummary.cost.input)} · wy{" "}
            {formatUsd(costSummary.cost.output)} · cache {formatUsd(costSummary.cost.cacheRead + costSummary.cost.cacheWrite)}
            ) · pominięto linii: {meta.skippedLines}
          </span>
        )}
        {error && <span style={{ fontSize: 12, color: "#d9455f" }}>{error}</span>}
      </header>

      <div
        style={{ flex: 1, position: "relative" }}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {flowNodes.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "#6b6375",
              fontSize: 14,
            }}
          >
            Upuść tu plik .jsonl albo użyj przycisku „wczytaj .jsonl” w nagłówku.
          </div>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={onInit}
            onNodeClick={onNodeClick}
            fitView
            minZoom={0.05} // pułapka: domyślny minZoom 0.5 nie pozwala fitView zmieścić dużego grafu
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
            <Legend />
          </ReactFlow>
        )}
      </div>

      {timestamps.length > 0 && (
        <Scrubber
          timestamps={timestamps}
          index={index}
          playing={playing}
          onIndexChange={handleIndexChange}
          onPlayingChange={setPlaying}
        />
      )}

      <DetailPanel node={selected} onClose={() => setSelected(null)} sessionStartedAt={meta?.startedAt ?? null} />
    </div>
  );
}
