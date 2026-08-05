import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "../parser/types";

const STATUS_COLOR: Record<string, string> = {
  ok: "#22a06b",
  error: "#d9455f",
  unknown: "#9a97a3",
};

interface CardProps extends NodeProps {
  accent: string;
  icon: string;
}

function Card({ data, accent, icon }: CardProps) {
  const node = (data as { node: GraphNode }).node;
  const tokens = node.meta.tokensIn + node.meta.tokensOut;
  return (
    <div
      style={{
        width: 220,
        borderRadius: 10,
        border: `1.5px solid ${accent}`,
        background: "#fff",
        boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: 1.35,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: accent }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: accent }}>
        <span>{icon}</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={node.label}
        >
          {node.label}
        </span>
        <span
          title={`status: ${node.meta.status}`}
          style={{
            marginLeft: "auto",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATUS_COLOR[node.meta.status],
            flexShrink: 0,
          }}
        />
      </div>
      {node.meta.model && (
        <div style={{ color: "#6b6375", marginTop: 2 }}>{node.meta.model}</div>
      )}
      {tokens > 0 && (
        <div style={{ color: "#6b6375" }}>
          ↑{node.meta.tokensIn} ↓{node.meta.tokensOut}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
    </div>
  );
}

export function SessionNode(props: NodeProps) {
  return <Card {...props} accent="#08060d" icon="◆" />;
}

export function AgentNode(props: NodeProps) {
  return <Card {...props} accent="#aa3bff" icon="●" />;
}

export function ToolCallNode(props: NodeProps) {
  return <Card {...props} accent="#4f7cff" icon="▸" />;
}

export function FileNode(props: NodeProps) {
  return <Card {...props} accent="#22a06b" icon="▤" />;
}
