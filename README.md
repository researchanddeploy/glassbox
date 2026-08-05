# Glassbox

Wizualizator wykonania sesji Claude Code jako grafu DAG. Wczytuje transkrypt
`.jsonl` (dokładnie taki, jaki Claude Code zapisuje w `~/.claude/projects/`) i
rysuje graf: sesja → agenci (main + subagenci) → wywołania narzędzi → pliki,
z tokenami, modelem i statusem (ok/error) na każdym węźle.

## Uruchomienie

```bash
npm install
npm run dev       # http://localhost:5173, przeciągnij .jsonl albo użyj przycisku
npm run build      # tsc --noEmit + build produkcyjny
npm test           # vitest — parser na przykładzie syntetycznym + na realnym transkrypcie
```

Wbudowany przykład (`public/sample.jsonl`) jest **syntetyczny** — mała sesja z
main agentem, dwoma subagentami, kilkoma wywołaniami narzędzi i plikami.
Realne transkrypty (dane prywatne) nigdy nie trafiają do repozytorium.

## Architektura

Parser (`src/parser/`) jest czystym modułem TS bez zależności od UI: bierze
string JSONL i zwraca `SessionGraph { nodes, edges, meta }` — węzły typu
`session`/`agent`/`tool_call`/`file`, krawędzie `spawns`/`calls`/`touches`.
Jest odporny na linie nieparsowalne lub o nieznanym typie — pomija je zamiast
się wywalać. Subagentów rozpoznaje na dwa sposoby zaobserwowane empirycznie w
realnych transkryptach: inline `isSidechain: true` między wywołaniem
Task/Agent a jego `tool_result`, oraz asynchroniczny spawn (sam node
powstaje z opisu wywołania, bez zagnieżdżonych dzieci — pełny transkrypt
subagenta w tym trybie żyje poza jednym plikiem `.jsonl`). Warstwa
prezentacji (Vite + React 18 + `@xyflow/react`) układa graf przez `elkjs`
(algorytm warstwowy, kierunek DOWN) i renderuje własne karty węzłów
(`AgentNode`, `ToolCallNode`, `FileNode`) z panelem szczegółów po kliknięciu.

## Replay, oś czasu i koszty

Pasek na dole (`Scrubber`) pozwala odtwarzać sesję event-po-evencie: suwak,
play/pauza (spacja) i strzałki do kroku. Layout jest liczony raz przy
wczytaniu — scrubber tylko zmienia widoczność węzłów/krawędzi (wygaszenie do
opacity 0.12 dla zdarzeń „z przyszłości"), graf „buduje się" chronologicznie
bez ponownego przeliczania elk. Węzeł najbliższy bieżącej pozycji dostaje
podświetlenie, a panel szczegółów podąża za nim podczas odtwarzania.

Koszty liczone są ze statycznej mapy cen (`src/pricing.ts`, USD/1M tokenów,
do ręcznej aktualizacji) — agregacja per agent (main i każdy subagent osobno)
widoczna na kartach węzłów i jako suma w nagłówku; nieznany model daje `null`
(pokazywane są wtedy same tokeny, a suma sesji oznaczona jest `+` jako
częściowa).

## Tryb live

Graf da się oglądać na żywo, w trakcie trwania sesji Claude Code — bez czekania
na jej koniec i bez ręcznego wczytywania pliku po każdej zmianie.

### Uruchomienie

```bash
node server/live.mjs ~/.claude/projects/<projekt>/<sesja>.jsonl
```

Serwer (Node ≥18, zero zależności runtime — tylko `node:http`/`node:fs`) staje
na stałym porcie `4517` i śledzi przyrost wskazanego pliku: `fs.watch` plus
fallback pollingiem co 1s (na wypadek systemów plików, gdzie `fs.watch`
milczy), czytając tylko nowe bajty od ostatniego offsetu — nigdy całego pliku
od zera. Niedokończona ostatnia linia jest buforowana do najbliższego
znaku nowej linii (`server/lineSplitter.mjs`, przetestowany w `vitest`).

Endpoint `GET http://localhost:4517/events` to SSE: najpierw cały dotychczasowy
backlog (jeden event `backlog` z tablicą linii), potem bieżące nowe linie
(event `line` na każdą), plus heartbeat co 15s.

W UI: przycisk **„Live”** obok „wczytaj .jsonl” łączy się z tym adresem
(`EventSource`, auto-reconnect wbudowany w przeglądarkę), pokazuje status
połączenia (zielona kropka „połączono” / „rozłączono”), akumuluje przychodzące
linie i re-parsuje je (debounce 500 ms) — nowe węzły przeliczają layout `elk`
tak samo jak przy zwykłym wczytaniu pliku. Scrubber w trybie live jest domyślnie
przypięty do końca osi czasu („follow”); ręczne przesunięcie suwaka (albo
strzałki/play) wyłącza follow do końca sesji live.

### Opcjonalny forwarder hooków

`hooks/glassbox-hook.sh` to skrypt, który możesz **ręcznie** podpiąć pod
`PostToolUse` we własnym `~/.claude/settings.json` — Glassbox nigdy sam niczego
tam nie zapisuje. Live mode działa bez niego (fs.watch + polling wystarczają);
hook tylko skraca opóźnienie do ~0, każąc serwerowi sprawdzić przyrost
natychmiast po każdym wywołaniu narzędzia zamiast czekać do najbliższego ticka
pollingu:

```json
"hooks": {
  "PostToolUse": [
    { "hooks": [{ "type": "command", "command": "/pelna/sciezka/do/glassbox/hooks/glassbox-hook.sh" }] }
  ]
}
```

Skrypt jest fire-and-forget (`curl` z timeoutem 1s, zawsze `exit 0`) — nigdy
nie blokuje ani nie przerywa wykonania Claude Code, nawet gdy serwer live nie
działa.

## Warstwa izolacji

Każdy węzeł grafu niesie `sandbox: SandboxInfo` (`src/parser/sandbox.ts`) —
typ izolacji i przekroczenia granicy, wyznaczone z markerów w `tool_use.input`
zaobserwowanych empirycznie na realnych transkryptach (nigdy przez zgadywanie —
brak sygnału daje `isolation: null`). Subagenci z izolacją `worktree`/`container`
dostają obrys grupy (React Flow group node, `parentId`+`extent`) obejmujący ich
własne tool_calle i pliki; pojedyncze wywołania mają badge (`unsandboxed` — czerwony,
`network`/`container`/`filesystem-out` — inne kolory), legenda w rogu kanwy, a
panel szczegółów dostał sekcję „Izolacja”.

| Marker | Źródło | Klasyfikacja |
|---|---|---|
| `Bash.input.dangerouslyDisableSandbox === true` | schemat Bash | `isolation: unsandboxed` + `filesystem-out` |
| `Bash.input.command` zawiera `curl`/`wget` | transkrypt bieżącej sesji (curl→npmjs) | `network` |
| `Bash.input.command` zawiera `docker`/`orb`/`orbctl` | specyfikacja zadania (brak w zbadanych transkryptach) | `container` |
| `WebFetch`/`WebSearch`/`mcp__*` (w tym tavily) | transkrypt bieżącej sesji (2× WebFetch) | `network` |
| `Agent.input.isolation === "worktree"` | schemat narzędzia Agent (brak w zbadanych transkryptach) | `isolation: worktree` |
| `Agent.input.isolation === "remote"` | schemat narzędzia Agent | `isolation: container` (mapowanie, uproszczenie) |

Pełna metodologia i cytaty ze zbadanych transkryptów — komentarz na górze
`src/parser/sandbox.ts`.
