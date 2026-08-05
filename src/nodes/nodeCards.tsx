import { Handle, Position, useStore, type NodeProps, type ReactFlowState } from "@xyflow/react";
import type { GraphNode } from "../parser/types";
import { lodForZoom, type AgentAggregates } from "../layout/collapse";
import { computeCost, formatUsd } from "../pricing";
import { useNodeChannelClasses } from "../channelStore";

/** Dane węzła karty: graf + stan collapse z projekcji + callback toggle z App. */
export interface CardData {
  node: GraphNode;
  collapsed?: boolean;
  aggregates?: AgentAggregates | null;
  onToggle?: (agentId: string) => void;
}

// Selektor progowy (far/mid/near) — re-render karty tylko przy przejściu progu,
// nigdy useViewport() w karcie (to re-render 60/s przy każdym ruchu kamery).
const lodSelector = (s: ReactFlowState) => lodForZoom(s.transform[2]);

// Czerwień wyłącznie dla awarii (decyzja D5); nowe statusy na palecie bursztyn/pomarańcz/niebieski.
const STATUS_COLOR: Record<string, string> = {
  ok: "#22a06b",
  error: "#d9455f",
  unknown: "#9a97a3",
  in_progress: "#2f80ed",
  interrupted: "#d9a514",
  denied: "#e07b39",
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
  const { node, collapsed, aggregates, onToggle } = data as unknown as CardData;
  const lod = useStore(lodSelector);
  // Kanały selekcji/replay przez store + CSS — krok scrubbera nie przepisuje
  // tablicy węzłów; re-render tylko karty, której klasa faktycznie się zmienia.
  const channelClasses = useNodeChannelClasses(node.id);
  const tokens = node.meta.tokensIn + node.meta.tokensOut;
  const cost = computeCost(node.meta.model, node.meta);
  const isCollapsedAgent = node.type === "agent" && collapsed === true;
  if (import.meta.env.DEV) {
    // Licznik renderów kart (tylko dev) — dowód, że scrub nie renderuje wszystkiego.
    const w = window as unknown as { __gbCardRenders?: number };
    w.__gbCardRenders = (w.__gbCardRenders ?? 0) + 1;
  }
  return (
    <div
      className={channelClasses}
      style={{
        width: 220,
        border: `1.5px solid ${accent}`,
        background: "#fff",
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
            fontSize: lod === "far" ? 15 : 12, // far: sam tytuł + status, czytelny z oddali
          }}
          title={node.label}
        >
          {node.label}
        </span>
        <span
          title={`status: ${node.meta.status}`}
          style={{
            marginLeft: "auto",
            width: lod === "far" ? 12 : 8,
            height: lod === "far" ? 12 : 8,
            borderRadius: "50%",
            background: STATUS_COLOR[node.meta.status],
            flexShrink: 0,
          }}
        />
      </div>
      {lod !== "far" && (
        <>
          {node.meta.model && (
            <div style={{ color: "#6b6375", marginTop: 2 }}>{node.meta.model}</div>
          )}
          {tokens > 0 && (
            <div
              style={{ color: "#6b6375" }}
              title={
                cost !== null
                  ? `we ${formatUsd(cost.input)} · wy ${formatUsd(cost.output)} · cache ${formatUsd(cost.cacheRead + cost.cacheWrite)}`
                  : "koszt nieznany (model bez cennika)"
              }
            >
              ↑{node.meta.tokensIn} ↓{node.meta.tokensOut}
              {cost !== null ? ` · ${formatUsd(cost.total)}` : ""}
            </div>
          )}
          {isCollapsedAgent && aggregates && <AggregatesRow aggregates={aggregates} />}
          {lod === "near" && node.detail && (
            <div
              style={{
                color: "#8d8798",
                marginTop: 2,
                fontFamily: "ui-monospace, monospace",
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {node.detail.split("\n")[0]}
            </div>
          )}
          <BoundaryBadges node={node} />
        </>
      )}
      {isCollapsedAgent && onToggle && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
          style={{
            marginTop: 4,
            cursor: "pointer",
            fontSize: 11,
            color: accent,
            background: "none",
            border: "none",
            padding: 0,
            fontWeight: 700,
          }}
        >
          rozwiń ▸
        </button>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
    </div>
  );
}

/** Wiersz agregatów węzła zbiorczego: „47 wywołań · 3 pliki · 2 błędy” + tokeny/koszt poddrzewa. */
function AggregatesRow({ aggregates }: { aggregates: AgentAggregates }) {
  const { cost } = aggregates;
  return (
    <div style={{ color: "#6b6375", marginTop: 2 }}>
      <div>
        {aggregates.toolCalls} wywołań · {aggregates.files} plików
        {aggregates.errors > 0 && <span style={{ color: "#d9455f", fontWeight: 700 }}> · {aggregates.errors} błędów</span>}
        {aggregates.agents > 0 && ` · ${aggregates.agents} agentów`}
      </div>
      <div>
        ↑{cost.tokensIn} ↓{cost.tokensOut} · {formatUsd(cost.cost.total)}
        {cost.partial ? "+" : ""}
      </div>
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

/**
 * Grupa ROZWINIĘTEGO agenta (collapse ojacie-e0c): kontener React Flow z etykietą
 * i przyciskiem „zwiń”. Kolor obrysu niesie izolację agenta (worktree/container),
 * co zastępuje dawny post-processing wrapIsolatedGroups w widoku hierarchicznym.
 */
export function AgentGroupNode({ data }: NodeProps) {
  const { node, onToggle } = data as unknown as CardData;
  const isolation = node.sandbox.isolation;
  const color = isolation === "worktree" ? "#4f7cff" : isolation === "container" ? "#aa3bff" : "#b9b3c6";
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
          display: "flex",
          gap: 8,
          alignItems: "center",
          pointerEvents: "auto",
        }}
      >
        {isolation === "worktree" || isolation === "container" ? `izolacja: ${isolation} · ` : ""}
        {node.label}
        {onToggle && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{ cursor: "pointer", fontSize: 11, color, background: "none", border: "none", padding: 0, fontWeight: 700 }}
          >
            zwiń ▾
          </button>
        )}
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
