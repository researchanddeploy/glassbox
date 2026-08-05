import { describe, expect, it } from "vitest";
import { createLineSplitter } from "./lineSplitter.mjs";

describe("createLineSplitter", () => {
  it("zwraca kompletne linie z jednej porcji", () => {
    const s = createLineSplitter();
    expect(s.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(s.pending()).toBe("");
  });

  it("buforuje niedokończoną ostatnią linię do czasu kolejnego newline", () => {
    const s = createLineSplitter();
    expect(s.push("hello wor")).toEqual([]);
    expect(s.pending()).toBe("hello wor");
    expect(s.push("ld\n")).toEqual(["hello world"]);
    expect(s.pending()).toBe("");
  });

  it("radzi sobie z linią JSON przeciętą w połowie między dwiema porcjami", () => {
    const s = createLineSplitter();
    const line = JSON.stringify({ type: "assistant", text: "hi" });
    const mid = Math.floor(line.length / 2);
    expect(s.push(line.slice(0, mid))).toEqual([]);
    expect(s.push(line.slice(mid) + "\n")).toEqual([line]);
  });

  it("obsługuje wiele linii rozbitych na wiele małych porcji", () => {
    const s = createLineSplitter();
    const all = ["one", "two", "three"].join("\n") + "\n";
    const out = [];
    for (const ch of all) out.push(...s.push(ch));
    expect(out).toEqual(["one", "two", "three"]);
  });

  it("nie zwraca nic dla pustej porcji", () => {
    const s = createLineSplitter();
    expect(s.push("")).toEqual([]);
  });
});
