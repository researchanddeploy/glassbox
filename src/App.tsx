import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseSession } from "./parser";
import type { GraphNode, SessionMeta } from "./parser/types";
import { layoutGraph } from "./layout/elkLayout";
import { AgentNode, FileNode, SessionNode, ToolCallNode } from "./nodes/nodeCards";
import { DetailPanel } from "./DetailPanel";
import { Scrubber } from "./Scrubber";
import { aggregateSessionCost, formatUsd } from "./pricing";
import { toEpoch } from "./time";

const DIMMED_OPACITY = 0.12;
const ACTIVE_GLOW = "0 0 0 3px #aa3bff, 0 0 18px 5px rgba(170,59,255,0.55)";
const LIVE_URL = "http://localhost:4517/events";
const LIVE_DEBOUNCE_MS = 500;

const nodeTypes = {
  session: SessionNode,
  agent: AgentNode,
  tool_call: ToolCallNode,
  file: FileNode,
};

export default function App() {
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const loadJsonl = useCallback(async (text: string, opts?: { follow?: boolean; resetSelection?: boolean }) => {
    const follow = opts?.follow ?? true;
    if (opts?.resetSelection ?? true) setSelected(null);
    setError(null);
    try {
      const graph = parseSession(text);
      const { nodes, edges } = await layoutGraph(graph.nodes, graph.edges);
      const ts = Array.from(
        new Set(graph.nodes.map((n) => toEpoch(n.meta.timestamp)).filter((t): t is number => t !== null)),
      ).sort((a, b) => a - b);
      setFlowNodes(nodes);
      setFlowEdges(edges);
      setMeta(graph.meta);
      setTimestamps(ts);
      if (follow) setIndex(ts.length > 0 ? ts.length - 1 : 0); // domyślnie: pełny graf
      setPlaying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopLive = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setLiveStatus("off");
  }, []);

  const startLive = useCallback(() => {
    stopLive();
    setSelected(null);
    liveRawRef.current = "";
    followRef.current = true;
    const es = new EventSource(LIVE_URL);
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
  }, [loadJsonl, stopLive]);

  const toggleLive = useCallback(() => {
    if (esRef.current) stopLive();
    else startLive();
  }, [startLive, stopLive]);

  useEffect(() => () => stopLive(), [stopLive]);

  // Suwak ruszony ręcznie (drag, strzałki, play/pauza) — wyłącz "follow" trybu live.
  const handleIndexChange = useCallback((i: number) => {
    followRef.current = false;
    setIndex(i);
  }, []);

  const currentTime = timestamps[index] ?? null;

  // Dopasowanie widoczności węzłów/krawędzi do pozycji scrubbera + wybór aktywnego węzła
  // (ostatni utworzony w danym momencie replay). Nie dotyka pozycji z layoutu.
  const { styledNodes, styledEdges, activeNode } = useMemo(() => {
    if (currentTime === null) {
      return { styledNodes: flowNodes, styledEdges: flowEdges, activeNode: null as GraphNode | null };
    }
    const dimmed = new Set<string>();
    let active: GraphNode | null = null;
    let activeEpoch = -Infinity;
    for (const n of flowNodes) {
      const gn = (n.data as { node: GraphNode }).node;
      const epoch = toEpoch(gn.meta.timestamp);
      if (epoch !== null && epoch > currentTime) {
        dimmed.add(n.id);
      } else if (epoch !== null && epoch >= activeEpoch) {
        activeEpoch = epoch;
        active = gn;
      }
    }
    const sNodes = flowNodes.map((n) => ({
      ...n,
      style: {
        ...n.style,
        opacity: dimmed.has(n.id) ? DIMMED_OPACITY : 1,
        boxShadow: active?.id === n.id ? ACTIVE_GLOW : undefined,
        borderRadius: 10,
      },
    }));
    const sEdges = flowEdges.map((e) => ({
      ...e,
      style: {
        ...e.style,
        opacity: dimmed.has(e.source) || dimmed.has(e.target) ? DIMMED_OPACITY : 1,
      },
    }));
    return { styledNodes: sNodes, styledEdges: sEdges, activeNode: active };
  }, [flowNodes, flowEdges, currentTime]);

  // Podczas odtwarzania panel szczegółów podąża za aktywnym węzłem.
  useEffect(() => {
    if (playing && activeNode) setSelected(activeNode);
  }, [playing, activeNode]);

  const costSummary = useMemo(() => {
    const agents = flowNodes
      .filter((n) => n.type === "agent")
      .map((n) => (n.data as { node: GraphNode }).node);
    return aggregateSessionCost(agents);
  }, [flowNodes]);

  const onFileInput = useCallback(
    (file: File) => {
      file.text().then(loadJsonl);
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
            {meta.totalTokensIn}/{meta.totalTokensOut} · koszt: {formatUsd(costSummary.cost)}
            {costSummary.partial ? "+" : ""} · pominięto linii: {meta.skippedLines}
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
            nodes={styledNodes}
            edges={styledEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected((n.data as { node: GraphNode }).node)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
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
