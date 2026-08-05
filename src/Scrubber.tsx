import { useEffect } from "react";

interface ScrubberProps {
  /** Posortowane, unikalne znaczniki czasu (epoch ms) wszystkich węzłów grafu. */
  timestamps: number[];
  index: number;
  playing: boolean;
  onIndexChange: (index: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

const STEP_MS = 300;

/** Pasek czasu sesji: suwak + play/pauza, krok event-po-evencie. Bez wpływu na layout grafu. */
export function Scrubber({ timestamps, index, playing, onIndexChange, onPlayingChange }: ScrubberProps) {
  const last = timestamps.length - 1;

  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      onPlayingChange(false);
      return;
    }
    const timer = setTimeout(() => onIndexChange(Math.min(index + 1, last)), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, index, last, onIndexChange, onPlayingChange]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        onPlayingChange(!playing);
      } else if (e.code === "ArrowRight") {
        onIndexChange(Math.min(index + 1, last));
      } else if (e.code === "ArrowLeft") {
        onIndexChange(Math.max(index - 1, 0));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playing, index, last, onIndexChange, onPlayingChange]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 16px",
        borderTop: "1px solid #e5e4e7",
        background: "#fff",
        fontSize: 12,
      }}
    >
      <button
        onClick={() => onPlayingChange(!playing)}
        title="spacja: play/pauza"
        style={{ cursor: "pointer", width: 28 }}
      >
        {playing ? "⏸" : "▶"}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        value={index}
        onChange={(e) => onIndexChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ color: "#6b6375", minWidth: 150, textAlign: "right" }}>
        {new Date(timestamps[index]).toLocaleTimeString()} · {index + 1}/{timestamps.length}
      </span>
    </div>
  );
}
