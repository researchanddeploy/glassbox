import type { CSSProperties } from "react";
import type { GraphNode } from "./parser/types";
import { computeCost, formatUsd } from "./pricing";
import { formatRelative } from "./time";

interface DetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
  /** Start sesji (ISO) — do liczenia czasu względnego mm:ss. */
  sessionStartedAt: string | null;
}

const TYPE_LABEL: Record<GraphNode["type"], string> = {
  session: "Sesja",
  agent: "Agent",
  tool_call: "Wywołanie narzędzia",
  file: "Plik",
};

export function DetailPanel({ node, onClose, sessionStartedAt }: DetailPanelProps) {
  if (!node) return null;
  const cost = computeCost(node.meta.model, node.meta);
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
        <Row label="Czas względny" value={formatRelative(sessionStartedAt, node.meta.timestamp)} />
        <Row label="Tokeny in/out" value={`${node.meta.tokensIn} / ${node.meta.tokensOut}`} />
        <Row
          label="Tokeny cache (odczyt/zapis)"
          value={`${node.meta.cacheReadTokens} / ${node.meta.cacheCreationTokens}`}
        />
        <Row label="Koszt" value={cost !== null ? formatUsd(cost.total) : "—"} />
        {cost !== null && (
          <Row
            label="— rozbicie"
            value={`we ${formatUsd(cost.input)} · wy ${formatUsd(cost.output)} · cache odczyt ${formatUsd(cost.cacheRead)} · cache zapis ${formatUsd(cost.cacheWrite)}`}
          />
        )}
      </dl>

      <h3 style={{ fontSize: 13, marginTop: 16 }}>Izolacja</h3>
      <dl style={{ fontSize: 13, color: "#333" }}>
        <Row label="Typ" value={node.sandbox.isolation ?? "—"} />
        <Row
          label="Przekroczenia granicy"
          value={node.sandbox.boundaryCrossings.length > 0 ? node.sandbox.boundaryCrossings.join(", ") : "—"}
        />
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
