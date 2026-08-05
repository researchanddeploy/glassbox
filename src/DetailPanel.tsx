import type { CSSProperties } from "react";
import type { GraphNode } from "./parser/types";

interface DetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

const TYPE_LABEL: Record<GraphNode["type"], string> = {
  session: "Sesja",
  agent: "Agent",
  tool_call: "Wywołanie narzędzia",
  file: "Plik",
};

export function DetailPanel({ node, onClose }: DetailPanelProps) {
  if (!node) return null;
  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 380,
        background: "#fff",
        borderLeft: "1px solid #e5e4e7",
        padding: 16,
        overflowY: "auto",
        boxShadow: "-4px 0 12px rgba(0,0,0,0.08)",
      }}
    >
      <button onClick={onClose} style={{ float: "right", cursor: "pointer" }}>
        ✕
      </button>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "#aa3bff", fontWeight: 700 }}>
        {TYPE_LABEL[node.type]}
      </div>
      <h2 style={{ fontSize: 16, margin: "4px 0 12px", wordBreak: "break-word" }}>{node.label}</h2>

      <dl style={{ fontSize: 13, color: "#333" }}>
        <Row label="Status" value={node.meta.status} />
        <Row label="Model" value={node.meta.model ?? "—"} />
        <Row label="Czas" value={node.meta.timestamp ?? "—"} />
        <Row label="Tokeny in/out" value={`${node.meta.tokensIn} / ${node.meta.tokensOut}`} />
      </dl>

      {node.detail && (
        <>
          <h3 style={{ fontSize: 13, marginTop: 16 }}>Input</h3>
          <pre style={preStyle}>{node.detail}</pre>
        </>
      )}
      {node.output && (
        <>
          <h3 style={{ fontSize: 13, marginTop: 16 }}>Output</h3>
          <pre style={preStyle}>{node.output}</pre>
        </>
      )}
    </aside>
  );
}

const preStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "#f4f3ec",
  padding: 8,
  borderRadius: 6,
  fontSize: 12,
  maxHeight: 300,
  overflowY: "auto",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
      <dt style={{ color: "#6b6375" }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd>
    </div>
  );
}
