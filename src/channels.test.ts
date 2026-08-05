import { describe, expect, it } from "vitest";
import {
  EMPTY_CHANNELS,
  computeReplayChannel,
  edgeChannelClasses,
  neighborIdsOf,
  nodeChannelClasses,
  type ChannelState,
} from "./channels.ts";

const EDGES = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
  { source: "d", target: "b" },
  { source: "x", target: "y" },
];

describe("neighborIdsOf", () => {
  it("zbiera sąsiadów 1-hop w obu kierunkach", () => {
    expect(neighborIdsOf(EDGES, "b")).toEqual(new Set(["a", "c", "d"]));
  });

  it("nie zawiera samego węzła przy pętli własnej", () => {
    expect(neighborIdsOf([{ source: "a", target: "a" }], "a")).toEqual(new Set());
  });

  it("węzeł bez krawędzi → pusty zbiór", () => {
    expect(neighborIdsOf(EDGES, "zzz")).toEqual(new Set());
  });
});

describe("computeReplayChannel", () => {
  const items = [
    { id: "n1", epoch: 100 },
    { id: "grp", epoch: null },
    { id: "n2", epoch: 200 },
    { id: "n3", epoch: 300 },
  ];

  it("currentTime null → kanał wyłączony", () => {
    expect(computeReplayChannel(items, null)).toEqual({ dimmedIds: new Set(), activeId: null });
  });

  it("wygasza przyszłość, aktywny = ostatni utworzony ≤ t; null epoch pomijany", () => {
    expect(computeReplayChannel(items, 200)).toEqual({
      dimmedIds: new Set(["n3"]),
      activeId: "n2",
    });
  });

  it("remis czasów rozstrzyga późniejszy w tablicy (parytet z poprzednim App.tsx)", () => {
    const tie = [
      { id: "n1", epoch: 100 },
      { id: "n2", epoch: 100 },
    ];
    expect(computeReplayChannel(tie, 150).activeId).toBe("n2");
  });
});

describe("nodeChannelClasses", () => {
  const selection: ChannelState = {
    ...EMPTY_CHANNELS,
    selectedId: "b",
    neighborIds: new Set(["a", "c"]),
  };

  it("bez kanałów → sama klasa bazowa", () => {
    expect(nodeChannelClasses(EMPTY_CHANNELS, "a")).toBe("gb-card");
  });

  it("wybrany węzeł dostaje obwódkę, sąsiad zostaje jasny, reszta gaśnie", () => {
    expect(nodeChannelClasses(selection, "b")).toBe("gb-card gb-selected");
    expect(nodeChannelClasses(selection, "a")).toBe("gb-card");
    expect(nodeChannelClasses(selection, "x")).toBe("gb-card gb-sel-dim");
  });

  it("kanał replay: aktywny glow, przyszłość wygaszona", () => {
    const replay: ChannelState = {
      ...EMPTY_CHANNELS,
      replayDimmedIds: new Set(["f"]),
      activeId: "e",
    };
    expect(nodeChannelClasses(replay, "e")).toBe("gb-card gb-replay-active");
    expect(nodeChannelClasses(replay, "f")).toBe("gb-card gb-replay-dim");
  });

  it("kanały współistnieją: selekcja + replay na jednym węźle", () => {
    const both: ChannelState = {
      ...selection,
      replayDimmedIds: new Set(["x"]),
      activeId: "b",
    };
    expect(nodeChannelClasses(both, "b")).toBe("gb-card gb-selected gb-replay-active");
    expect(nodeChannelClasses(both, "x")).toBe("gb-card gb-sel-dim gb-replay-dim");
  });
});

describe("edgeChannelClasses", () => {
  it("jasna zostaje tylko krawędź incydentna z wybranym", () => {
    const s: ChannelState = { ...EMPTY_CHANNELS, selectedId: "b", neighborIds: new Set(["a"]) };
    expect(edgeChannelClasses(s, "a", "b")).toBe("gb-edge");
    expect(edgeChannelClasses(s, "x", "y")).toBe("gb-edge gb-sel-dim");
  });

  it("replay wygasza krawędź, gdy dowolny koniec jest z przyszłości", () => {
    const s: ChannelState = { ...EMPTY_CHANNELS, replayDimmedIds: new Set(["y"]) };
    expect(edgeChannelClasses(s, "x", "y")).toBe("gb-edge gb-replay-dim");
    expect(edgeChannelClasses(s, "x", "z")).toBe("gb-edge");
  });
});
