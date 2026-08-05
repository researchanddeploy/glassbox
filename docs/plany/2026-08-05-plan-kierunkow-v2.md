# Glassbox — kierunki rozwoju po PoC (2026-08-05)

## Kontekst

Epic epiku PoC domknięty technicznie: parser JSONL, graf React Flow + elkjs,
replay, tryb live (SSE), warstwa sandbox boundary, kontener OrbStack, README
z demo. Właściciel wskazał cztery rozrzucone wątki na następny etap:

1. **Storytelling** — UI ma opowiadać historię wykonania; długie sesje nie
   mieszczą się w kadrze nawet przy maksymalnym oddaleniu; język wizualny
   niedopracowany (brak podświetlenia klikniętego węzła — highlight tylko na
   aktywnym w replayu).
2. **Taksonomia** — klasyfikacja obiektów, zdarzeń i wzorców agentowych
   (pętle, saturacja, przekroczenia zakresu, statusy), grupowanie, filtrowanie,
   standaryzacja etykiet — silnie sprzężona z językiem wizualnym.
3. **Endpoint dla Claude Code + czat w UI** — analiza wykonania z asystentem,
   lekcje na przyszłość, czat zintegrowany z językiem wizualnym.
4. **Głębia i kontekst węzła** — parametry wywołań narzędzi, wyniki, tracking
   wykonania przy wejściu w węzeł.

Cel tej sesji: zbadać wykonalność, wybrać kierunki projektowe, zapisać plan.

## Stan badania

Trzy równoległe agenty badawcze (raporty → `docs/plany/` w repo glassbox):

- `gb-story` — wątki 1+4 (storytelling, duże grafy, selekcja, głębia węzła)
  → `docs/plany/2026-08-05-storytelling-i-glebia.md` — GOTOWY
- `gb-taxonomy` — wątek 2 (taksonomia, wzorce, filtry, słownik etykiet)
  → `docs/plany/2026-08-05-taksonomia.md` — GOTOWY
- `gb-chat` — wątek 3 (architektura MCP vs headless claude vs API, lekcje)
  → `docs/plany/2026-08-05-endpoint-i-czat.md` — GOTOWY

## Zadanie dodatkowe (decyzja właściciela 2026-08-05)

**Skill `react-flow-v12`** w `~/.claude/skills/` — budowany procedurą
`skill-creator`, bo React Flow będzie często potrzebny. Zawartość: wzorce v12
(`@xyflow/react`): custom nodes/edges, group nodes (`parentId`+`extent`),
fitView i pułapka domyślnego `minZoom: 0.5` (lekcja z Glassboxa 2026-08-05),
semantic zoom / `onlyRenderVisibleElements`, sterowanie viewportem z
`useReactFlow`, integracja z zewnętrznym layoutem (elkjs), selekcja i
podświetlanie. Źródła: dokumentacja v12 przez context7 + kod Glassboxa jako
przykłady. Niezależne od pozostałych wątków — może iść równolegle.

## Syntezowane wnioski

### Wątek 2 — taksonomia (raport gb-taxonomy, pełny: `docs/plany/2026-08-05-taksonomia.md`)

Ustalenia wywracające założenia (z pomiarów na 3 realnych transkryptach, 17 179 linii):
- **Parser widzi dziś ~⅓ typów rekordów** (tylko te z polem `message`; same
  `attachment` to 2 298 z 7 117 linii w jednej sesji). Rekordy `system`
  (`compact_boundary`, `turn_duration`, `stop_hook_summary`) i `attachment`
  (`diagnostics`, `hook_success`, `task_status`) niosą twarde sygnały wzorców.
- **Inline sidechain (`isSidechain`) to martwa ścieżka** — 0 linii w trzech
  transkryptach; subagenci żyją w sidecarach `subagents/agent-<id>.jsonl`,
  wiązanie deterministyczne po `toolUseResult.agentId`.
- **Tokeny liczone źle** — brak `cache_read/cache_creation_input_tokens`
  (narastanie zmierzone 83 839 → 396 108); warstwa kosztów i saturacji stoi
  na złej podstawie.
- Fan-out NIE objawia się wieloma `tool_use` w jednej wiadomości (rozkład =
  zawsze 1); pewny sygnał to `pendingBackgroundAgentCount` z `turn_duration`.
- Klasyczny retry-loop jest rzadki (0-2/sesję); realna patologia to
  **identyczne wywołanie powtarzane z sukcesem** (32× w jednym transkrypcie).

Taksonomia: 7 obiektów (dziś 4; + `turn`, `task`, `checkpoint`), 9 statusów
(dziś 3; m.in. rozbicie `unknown` na `in_progress`/`unknown`, `denied`,
`interrupted`, `abandoned`), 11 wzorców z heurystykami (`fanout`, `pipeline`,
`retry_loop`, `saturation_repeat/compaction/noprogress`, `tool_streak`,
`escalation`, `gate_block`, `diagnostics_regression`, `scope_drift` — ostatni
słaby, odłożony). Konflikt wizualny: czerwień zajęta przez error I sandbox —
badge bezpieczeństwa do przeniesienia na bursztyn.

Iteracja 1 (zero fałszywych alarmów, same dane wprost): parser czyta `system`
+ `attachment` + `toolUseResult`, naprawa tokenów cache, rozbicie `unknown`,
dowiązanie sidecarów subagentów, węzeł `turn`, filtr „tylko błędy" (redukcja
grafu ~50× przy udziale błędów 1,5-2,4%). Iteracja 2: wzorce pewne. Iteracja 3:
wzorce progowe (kalibracja na większej próbie).

### Wątek 3 — endpoint + czat (raport gb-chat, pełny: `docs/plany/2026-08-05-endpoint-i-czat.md`)

**Rekomendacja: wariant A — serwer MCP w glassboxie** (~250 linii, zero
zależności, JSON-RPC w istniejącym `createServer`, bind 127.0.0.1). Analiza
toczy się w Claude Code (terminal), który MA już Write do `~/.claude/kb` —
zapis lekcji to jedno wywołanie; UI podświetla węzły przez istniejący
broadcast SSE. Czat w UI świadomie odłożony; migracja addytywna: wariant B
(`claude -p --mcp-config`) i C (API) używają TEGO SAMEGO serwera MCP.

- Kontekst grafu: kompaktowy TSV — zmierzone 750-5 900 tokenów dla realnych
  sesji (vs 147 000 pełnego dumpu); druga warstwa `get_node_detail` ~1 200 tok.
- Parser TS ładuje się natywnie w Node 25 (type stripping) — wystarczy dopisać
  `.ts` w reeksportach `src/parser/index.ts`.
- 4 narzędzia MCP: `list_sessions`, `get_session_graph`, `get_node_detail`,
  `highlight_nodes` (→ SSE → obrys w stylu ACTIVE_GLOW w App.tsx).
- Lekcje dwupoziomowo: adnotacje `data/annotations/<session>.json`
  (gitignore) + lekcje kanoniczne `~/.claude/kb/lessons/` w OKF v0.2
  (draft → promocja przez /kb).
- **Znalezisko bezpieczeństwa (stan obecny, do poprawki niezależnie):**
  `live.mjs` słucha na wszystkich interfejsach + `Access-Control-Allow-Origin:
  *` — transkrypty czytelne dla całej sieci lokalnej.

### Wątki 1+4 — storytelling i głębia (raport gb-story, pełny: `docs/plany/2026-08-05-storytelling-i-glebia.md`)

- **Parser traci ~80% grafu**: czyta tylko plik główny; subagenci w sidecarach
  (największa sesja: 1 z 53 agentów, ~760 z ~3218 tool calli). Sklejenie
  jednoznaczne przez `meta.toolUseId` + `meta.parentAgentId`.
- **Pełne input/output SĄ w danych** — ucina dopiero `DETAIL_LIMIT=2000`;
  nieczytane pole `toolUseResult` ma m.in. `stdout/stderr` rozdzielone,
  `structuredPatch` (gotowy diff), metryki subagenta. Zasada: NIE podnosić
  DETAIL_LIMIT — osobna `Map<nodeId, FullDetail>` obok grafu.
- Koszt w nagłówku systematycznie błędny (2 z 10 pól `usage`; pułapka:
  `cache_read_input_tokens` jest kumulatywny — naiwna suma dała 460 mln).
- React Flow 12.11.2 (React 19, nie 18): semantic zoom natywny przez
  `useStore(selector)`; collapse poddrzew WŁASNY (`useExpandCollapse` tylko
  w Pro); minimapa martwa, bo `pannable/zoomable` domyślnie false (najtańsza
  poprawa); `fitView({nodes})` kadruje podzbiór. Pułapka: pola
  `selectedNodeIds` NIE ma w store 12.11.2 mimo przykładu w dokumentacji.
- **Warunek wydajności**: każdy krok scrubbera przepisuje dziś całą tablicę
  węzłów (`useMemo` po `currentTime`, App.tsx:220) — styl do CSS + lekki
  store; `selected` w ogóle nie dociera do stylu.
- Kierunek: **hierarchia zamiast płaskiego grafu** — domyślnie kręgosłup
  `session → main → agenci` z agentami zwiniętymi do węzłów zbiorczych
  („47 wywołań · 3 pliki · 2 błędy · 4 min"); rozwinięcie = jawna akcja;
  zoom zmienia poziom szczegółu karty (LOD far/mid/near), nigdy zbiór węzłów.
- Selekcja vs replay: dwa niezależne kanały — `selected` = obwódka + sąsiedzi
  1-hop, reszta 0,35; `active-replay` = obecny glow jako shadow; współistnieją.
- Głębia węzła 3 poziomy: karta LOD → panel boczny (+czas, tokeny z cache,
  atrybucja) → pełny kontekst z zakładkami (Input/Output/Diff/Metryki).

## Decyzje kierunkowe (podjęte)

| # | Decyzja | Uzasadnienie |
|---|---|---|
| D1 | **Parser wielopikowy jako fundament** — sidecary subagentów, `toolUseResult`, rekordy `system`+`attachment`, tokeny cache, rozbicie `unknown` na `in_progress`/`unknown` | Wspólny bloker wszystkich 4 wątków; bez tego graf pokazuje 20% prawdy, a taksonomia nie ma danych |
| D2 | **Storytelling = hierarchia + collapse**, nie optymalizacja renderowania | Ograniczenie jest poznawcze (nikt nie odczyta 3000 kart), nie wydajnościowe; kręgosłub sesji JEST narracją |
| D3 | **Selekcja (border) i replay (glow) jako niezależne kanały**; styl przez CSS/store zamiast przepisywania tablicy węzłów | Naprawia zgłoszony brak podświetlenia klikniętego węzła bez kolizji z replayem i bez zacinania |
| D4 | **Taksonomia iteracyjnie: najpierw sygnały pewne** (dane wprost), potem wzorce progowe po kalibracji | Zero fałszywych alarmów w pierwszym wydaniu; progi stroić na próbie >3 transkryptów |
| D5 | **Czerwień wyłącznie dla awarii**; badge sandbox → bursztyn | Konflikt kanału koloru przy 3 nowych statusach awaryjnych |
| D6 | **Analiza+lekcje: serwer MCP w glassboxie (wariant A)**; okno czata w UI = następna faza przez `claude -p --mcp-config` na TYM SAMYM serwerze | Zero sekretów, zero nowego kanału danych, lekcje pisze Claude Code (ma już Write do kb); migracja addytywna zachowuje ideał okna czata |
| D7 | **Lekcje dwupoziomowo**: adnotacje w repo (gitignore) + kanon `~/.claude/kb/lessons/` OKF v0.2, draft → promocja przez `/kb` | Zgodne z CONTRACT.md (zakaz detali jednej sesji w kanonie) |
| D8 | **Poprawka bezpieczeństwa natychmiast**: bind `127.0.0.1` (flaga/env na wyjątek dla kontenera) + zawężenie CORS | Transkrypty czytelne dziś dla całej sieci lokalnej |

## Plan wykonania

Fazy sekwencyjne (każda = osobny branch, testy, merge po zielonej bramce);
zadania → beads pod epikiem epiku PoC (lub nowy epic „Glassbox v2").

**Faza 0 — fundament danych (L)**
1. Poprawka bezpieczeństwa live.mjs (D8) — commit niezależny, od ręki.
2. Parser wielopikowy: sidecary subagentów (`agentId`→plik), `toolUseResult`,
   rekordy `system`/`attachment`, tokeny cache (uwaga na kumulatywność),
   statusy `in_progress`/`interrupted`/`denied`; inline-sidechain zostaje
   jako zgodność wsteczna z komentarzem (no-deletion). `Map<nodeId,FullDetail>`
   obok grafu. Testy na realnym transkrypcie przez `GLASSBOX_REAL_TRANSCRIPT`.
3. Naprawa kosztów: pełne `usage` w `pricing.ts` + rozkład w UI.

**Faza 1 — język wizualny i storytelling (M/L)**
4. Quick wins: minimapa `pannable/zoomable`, `fitView({nodes})` po kliknięciu.
5. Refactor stylu: klasy CSS + selektory zamiast przepisywania tablicy; kanał
   `selected` (obwódka + 1-hop) obok `active-replay` (glow).
6. Layout hierarchiczny ELK (zagnieżdżone children per agent) + collapse
   poddrzew (rzut grafu do React Flow, węzły zbiorcze z licznikami).
7. LOD kart (far/mid/near) przez `useStore` z progami zoomu.

**Faza 2 — taksonomia w UI (M)**
8. Obiekty `turn`/`task`/`checkpoint`, 9 statusów, słownik etykiet PL/EN.
9. Filtr „tylko błędy" + filtry po atrybucji (skill/plugin/MCP).
10. Badge wzorców pewnych: `fanout`, `saturation_compaction`, `escalation`,
    `gate_block`, `interrupted`, `diagnostics_regression`.
11. (później, po kalibracji) wzorce progowe: `saturation_repeat`,
    `tool_streak`, `retry_loop`, `pipeline`.

**Faza 3 — MCP i lekcje (M)**
12. `.ts` w reeksportach parsera (Node type stripping) + `graphSerializer.mjs`
    (kompakt TSV 750-5900 tok., test budżetu tokenów).
13. `POST /mcp` w live.mjs: `list_sessions`, `get_session_graph`,
    `get_node_detail`, `highlight_nodes` (walidacja przez `resolveSessionPath`).
14. Obsługa `highlight` w App.tsx (SSE → obrys) + akapit w README.
15. Format lekcji: adnotacje + szablon OKF; pierwsza lekcja pilotażowa.
16. (faza kolejna) okno czata w UI przez `claude -p --mcp-config`.

**Równolegle (niezależne)**
17. Skill `react-flow-v12` (`skill-creator`; wzorce v12, pułapki: minZoom
    przy fitView, brak `selectedNodeIds` w store, Pro-only `useExpandCollapse`,
    koszt `hidden`, `parentId` przed dzieckiem; źródła: context7 + kod
    glassboxa).
18. Aktualizacja README (React 19, nie 18) + kb `projects/glassbox` po fazach.

## Weryfikacja

- Parser: testy vitest na syntetyku + realnym transkrypcie (env), asercja
  liczby agentów/tool calli sklejonej sesji (dziś 1/53 → po zmianie 53/53).
- UI: E2E Playwright — klik = podświetlenie + sąsiedzi, replay + selekcja
  naraz, collapse/expand, filtr błędów; dark/light + resize (reguła
  dowod-wykonania).
- Koszty: porównanie sumy z `usage` względem znanych wartości sesji.
- MCP: realny przebieg `claude mcp add` + analiza sesji + zapis lekcji
  draft do kb + highlight widoczny w UI.
- Bezpieczeństwo: `curl` z innego hosta w LAN → odmowa; z localhost → działa.
