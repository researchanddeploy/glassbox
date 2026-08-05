/**
 * Dwa niezależne kanały wizualne grafu (decyzja D3, ojacie-cja):
 *
 * - `selected`  — obwódka klikniętego węzła + sąsiedzi 1-hop, reszta 0.35;
 * - `active-replay` — glow aktywnego węzła scrubbera + wygaszenie 0.12 przyszłości.
 *
 * Oba mogą działać jednocześnie; styl niesie CSS (index.css, klasy `gb-*`),
 * a nie tablica węzłów — krok scrubbera NIE przepisuje `nodes`/`edges`.
 * Czyste funkcje bez Reacta — testowane w channels.test.ts.
 */

export interface ChannelState {
  /** Kanał selekcji: id klikniętego węzła albo null (kanał wyłączony). */
  selectedId: string | null;
  /** Sąsiedzi 1-hop wybranego węzła (bez niego samego). */
  neighborIds: ReadonlySet<string>;
  /** Kanał replay: węzły z przyszłości względem scrubbera (wygaszone). */
  replayDimmedIds: ReadonlySet<string>;
  /** Ostatni węzeł utworzony do pozycji scrubbera (glow) albo null. */
  activeId: string | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export const EMPTY_CHANNELS: ChannelState = {
  selectedId: null,
  neighborIds: EMPTY_SET,
  replayDimmedIds: EMPTY_SET,
  activeId: null,
};

/** Sąsiedzi 1-hop węzła `id` w obu kierunkach krawędzi (bez samego `id`). */
export function neighborIdsOf(
  edges: readonly { source: string; target: string }[],
  id: string,
): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    else if (e.target === id) out.add(e.source);
  }
  out.delete(id);
  return out;
}

/** Wejście kanału replay: id węzła + epoch utworzenia (null = bez czasu, np. grupa). */
export interface ReplayItem {
  id: string;
  epoch: number | null;
}

/**
 * Kanał replay dla pozycji scrubbera: wygaszone są węzły z przyszłości,
 * aktywny jest ostatni utworzony (remis rozstrzyga późniejszy w tablicy —
 * parytet z dotychczasowym zachowaniem App.tsx).
 */
export function computeReplayChannel(
  items: readonly ReplayItem[],
  currentTime: number | null,
): { dimmedIds: Set<string>; activeId: string | null } {
  const dimmedIds = new Set<string>();
  let activeId: string | null = null;
  if (currentTime === null) return { dimmedIds, activeId };
  let activeEpoch = -Infinity;
  for (const item of items) {
    if (item.epoch === null) continue;
    if (item.epoch > currentTime) {
      dimmedIds.add(item.id);
    } else if (item.epoch >= activeEpoch) {
      activeEpoch = item.epoch;
      activeId = item.id;
    }
  }
  return { dimmedIds, activeId };
}

/**
 * Klasy CSS węzła-karty. Kolejność deklaracji w index.css rozstrzyga nakładanie:
 * `gb-replay-dim` (0.12) deklarowany po `gb-sel-dim` (0.35) wygrywa na opacity.
 */
export function nodeChannelClasses(s: ChannelState, nodeId: string): string {
  let cls = "gb-card";
  if (s.selectedId !== null) {
    if (nodeId === s.selectedId) cls += " gb-selected";
    else if (!s.neighborIds.has(nodeId)) cls += " gb-sel-dim";
  }
  if (nodeId === s.activeId) cls += " gb-replay-active";
  if (s.replayDimmedIds.has(nodeId)) cls += " gb-replay-dim";
  return cls;
}

/** Klasy CSS krawędzi: jasna zostaje tylko incydentna z wybranym węzłem. */
export function edgeChannelClasses(s: ChannelState, source: string, target: string): string {
  let cls = "gb-edge";
  if (s.selectedId !== null && source !== s.selectedId && target !== s.selectedId) {
    cls += " gb-sel-dim";
  }
  if (s.replayDimmedIds.has(source) || s.replayDimmedIds.has(target)) {
    cls += " gb-replay-dim";
  }
  return cls;
}
