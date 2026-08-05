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
