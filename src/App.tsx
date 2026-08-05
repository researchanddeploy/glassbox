import { useCallback, useState, type DragEvent } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseSession } from "./parser";
import type { GraphNode, SessionMeta } from "./parser/types";
import { layoutGraph } from "./layout/elkLayout";
import { AgentNode, FileNode, SessionNode, ToolCallNode } from "./nodes/nodeCards";
import { DetailPanel } from "./DetailPanel";

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

  const loadJsonl = useCallback(async (text: string) => {
    setError(null);
    try {
      const graph = parseSession(text);
      const { nodes, edges } = await layoutGraph(graph.nodes, graph.edges);
      setFlowNodes(nodes);
      setFlowEdges(edges);
      setMeta(graph.meta);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
        {meta && (
          <span style={{ fontSize: 12, color: "#6b6375" }}>
            agentów: {meta.agentCount} · narzędzi: {meta.toolCallCount} · plików: {meta.fileCount} · tokeny:{" "}
            {meta.totalTokensIn}/{meta.totalTokensOut} · pominięto linii: {meta.skippedLines}
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
            onNodeClick={(_, n) => setSelected((n.data as { node: GraphNode }).node)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        )}
      </div>

      <DetailPanel node={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
