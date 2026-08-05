// Klasyfikator granicy sandboxa/izolacji dla węzłów grafu sesji. Czysty moduł
// (tool name + input → SandboxInfo), bez zależności od reszty parsera.
//
// Markery — zbadane empirycznie na dwóch realnych transkryptach przed napisaniem
// tego modułu (grep/jq po `tool_use.input` i nazwach narzędzi):
//   ~/.claude/projects/-/81e20c5a-4ba7-4b04-a5f3-c73a7dcfe0cd.jsonl (7.5 MB)
//   ~/.claude/projects/-Users-ojacie/f1743a87-...-68fc4be4468b.jsonl (bieżąca sesja)
//
// Znalezione:
//  - Bash.input.dangerouslyDisableSandbox === true → Bash BEZ sandboxa
//    (unsandboxed). Bez flagi (brak albo false) → sandboxed — Bash zawsze
//    biegnie w jakimś stanie sandboxa, więc to jedyny tool_call z domyślną
//    izolacją inną niż null. Potwierdzone: 3× w transkrypcie 81e20c5a przy
//    próbie zapisu na wolumenie danych poza repo (co dokładnie ilustruje sens
//    tej flagi — świadome zejście z sandboxa).
//  - Bash.input.command zawiera `curl`/`wget` → przekroczenie 'network'.
//    Potwierdzone: 2× curl do registry.npmjs.org w transkrypcie bieżącej sesji.
//  - Narzędzie WebFetch/WebSearch albo dowolne `mcp__*` (w tym tavily) →
//    przekroczenie 'network'. Potwierdzone: 2× WebFetch w transkrypcie
//    bieżącej sesji (dokumentacja JointJS).
//  - Agent.input.isolation === "worktree" → subagent w odizolowanym git
//    worktree, izolacja 'worktree'. Nie zaobserwowane w żadnym z dwóch
//    transkryptów (oba użycia Agent nie ustawiały `isolation`) — obsłużone na
//    podstawie schematu narzędzia Agent (parametr `isolation`), nie empirii.
//  - Agent.input.isolation === "remote" → uruchomienie w zdalnym środowisku
//    chmurowym; enum SandboxInfo nie ma osobnego 'remote', więc mapujemy na
//    najbliższy istniejący typ 'container' (osobne środowisko wykonania) —
//    świadome uproszczenie, nie zaobserwowane empirycznie.
//  - Bash.input.command zawiera `docker`/`orb`/`orbctl` → przekroczenie
//    'container'. Marker ze specyfikacji zadania, NIE zaobserwowany w żadnym
//    z dwóch zbadanych transkryptów — dopasowanie samego słowa, konserwatywnie.
//  - Brak jakiegokolwiek markera → isolation: null. Nie zgadujemy.

export type IsolationType = "sandboxed" | "unsandboxed" | "worktree" | "container" | null;
export type BoundaryCrossing = "network" | "filesystem-out" | "container";

export interface SandboxInfo {
  isolation: IsolationType;
  boundaryCrossings: BoundaryCrossing[];
}

export const NO_SANDBOX_INFO: SandboxInfo = { isolation: null, boundaryCrossings: [] };

const NETWORK_CMD_RE = /\b(curl|wget)\b/;
const CONTAINER_CMD_RE = /\b(docker|orbctl|orb)\b/;

function isNetworkToolName(name: string): boolean {
  return name === "WebFetch" || name === "WebSearch" || name.startsWith("mcp__") || name.toLowerCase().includes("tavily");
}

/** Klasyfikuje jedno wywołanie narzędzia (tool_call albo spawn Agent/Task) po nazwie i inpucie. */
export function classifySandbox(name: string, input: Record<string, unknown>): SandboxInfo {
  const crossings = new Set<BoundaryCrossing>();
  let isolation: IsolationType = null;

  if (name === "Bash") {
    const disabled = input.dangerouslyDisableSandbox === true;
    isolation = disabled ? "unsandboxed" : "sandboxed";
    if (disabled) crossings.add("filesystem-out");
    const command = typeof input.command === "string" ? input.command : "";
    if (NETWORK_CMD_RE.test(command)) crossings.add("network");
    if (CONTAINER_CMD_RE.test(command)) crossings.add("container");
  } else if (name === "Agent" || name === "Task") {
    const iso = input.isolation;
    if (iso === "worktree") isolation = "worktree";
    else if (iso === "remote") isolation = "container";
  } else if (isNetworkToolName(name)) {
    crossings.add("network");
  }

  return { isolation, boundaryCrossings: Array.from(crossings) };
}
