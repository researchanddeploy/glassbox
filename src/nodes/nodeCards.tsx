import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "../parser/types";
import { computeCost, formatUsd } from "../pricing";

const STATUS_COLOR: Record<string, string> = {
  ok: "#22a06b",
  error: "#d9455f",
  unknown: "#9a97a3",
};

// Kolory badge'y przekroczenia granicy: unsandboxed czerwonawy (ryzyko), network
// niebieski (informacyjny), container/filesystem-out fioletowy (neutralny, ale widoczny).
const BOUNDARY_BADGE: Record<string, { label: string; color: string }> = {
  network: { label: "network", color: "#4f7cff" },
  container: { label: "container", color: "#aa3bff" },
  "filesystem-out": { label: "fs-out", color: "#d9455f" },
};

interface CardProps extends NodeProps {
  accent: string;
  icon: string;
}

function Card({ data, accent, icon }: CardProps) {
  const node = (data as { node: GraphNode }).node;
  const tokens = node.meta.tokensIn + node.meta.tokensOut;
  const cost = computeCost(node.meta.model, node.meta.tokensIn, node.meta.tokensOut);
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
          {cost !== null ? ` · ${formatUsd(cost)}` : ""}
        </div>
      )}
      <BoundaryBadges node={node} />
      <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
    </div>
  );
}

/** Badge'y przekroczenia granicy sandboxa: unsandboxed (własna izolacja) + boundaryCrossings. */
function BoundaryBadges({ node }: { node: GraphNode }) {
  const badges: { label: string; color: string }[] = [];
  if (node.sandbox.isolation === "unsandboxed") badges.push({ label: "unsandboxed", color: "#d9455f" });
  for (const crossing of node.sandbox.boundaryCrossings) {
    const badge = BOUNDARY_BADGE[crossing];
    if (badge) badges.push(badge);
  }
  if (badges.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
      {badges.map((b) => (
        <span
          key={b.label}
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: "#fff",
            background: b.color,
            borderRadius: 4,
            padding: "1px 5px",
            textTransform: "uppercase",
            letterSpacing: 0.2,
          }}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}

/** Obrys grupy subagenta z izolacją (worktree/container) — bez Handle, sam kontener. */
export function IsolationGroupNode({ data }: NodeProps) {
  const { label, isolation } = data as { label: string; isolation: string };
  const color = isolation === "worktree" ? "#4f7cff" : "#aa3bff";
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        border: `2px dashed ${color}`,
        borderRadius: 14,
        background: `${color}0d`,
        boxSizing: "border-box",
        position: "relative",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: -11,
          left: 12,
          background: "#fff",
          padding: "0 6px",
          fontSize: 11,
          fontWeight: 700,
          color,
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        izolacja: {isolation} · {label}
      </span>
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
