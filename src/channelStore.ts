/**
 * Miniaturowy store kanałów wizualnych (useSyncExternalStore) — karty i krawędzie
 * subskrybują STRING klas CSS, więc re-renderuje się tylko element, któremu klasa
 * faktycznie się zmieniła. Krok scrubbera aktualizuje store, nie tablicę węzłów.
 * ponytail: jeden globalny store na moduł — wystarcza, bo App renderuje jedną sesję.
 */
import { useSyncExternalStore } from "react";
import {
  EMPTY_CHANNELS,
  edgeChannelClasses,
  nodeChannelClasses,
  type ChannelState,
} from "./channels";

let state: ChannelState = EMPTY_CHANNELS;
const listeners = new Set<() => void>();

/** Scala częściowy stan kanałów i budzi subskrybentów (karty + krawędzie). */
export function setChannels(next: Partial<ChannelState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Klasy CSS karty węzła — re-render tylko przy zmianie stringa (Object.is). */
export function useNodeChannelClasses(nodeId: string): string {
  return useSyncExternalStore(subscribe, () => nodeChannelClasses(state, nodeId));
}

/** Klasy CSS krawędzi — jak wyżej, po parze source/target. */
export function useEdgeChannelClasses(source: string, target: string): string {
  return useSyncExternalStore(subscribe, () => edgeChannelClasses(state, source, target));
}
