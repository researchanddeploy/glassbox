# Glassbox — storytelling, skala grafu i głębia węzła

Data: 2026-08-05
Zakres: wątek 1 (język wizualny i narracja) + wątek 4 (kontekst działania w węźle)
Status: raport kierunkowy, read-only wobec kodu źródłowego

> **Uwaga o lokalizacji pliku.** Docelowa ścieżka to
> `docs/plany/2026-08-05-storytelling-i-glebia.md`.
> Sesja pracowała w trybie plan mode, który dopuszcza zapis wyłącznie do pliku planu,
> więc raport powstał tutaj i wymaga skopiowania pod ścieżkę docelową po wyjściu z trybu.

Wersje zweryfikowane w `package.json`: `@xyflow/react` 12.11.2, `elkjs` 0.12.0,
React **19.2.8** (README i opis zadania mówią o React 18 — to nieaktualne).

---

## 1. Diagnoza stanu obecnego

### 1.1 Parser widzi około jednej piątej sesji

To jest ustalenie nadrzędne wobec wszystkich pozostałych: **oba zgłoszone problemy mają
wspólne źródło w modelu danych, nie w warstwie rysowania.**

Transkrypty Claude Code nie są jednym plikiem. Struktura zweryfikowana bezpośrednio
w `~/.claude/projects/` (264 katalogi `subagents/` na dysku):

```
<sessionId>.jsonl                                   wątek główny
<sessionId>/subagents/agent-<agentId>.jsonl         pełny transkrypt subagenta
<sessionId>/subagents/agent-<agentId>.meta.json     {agentType, description, toolUseId,
                                                     parentAgentId, spawnDepth, model}
<sessionId>/tool-results/*.txt                      outputy przepełnione (persistedOutputPath)
<sessionId>/workflows/wf_*.json                     podsumowania faz
```

Sklejenie jest jednoznaczne i nie wymaga heurystyki: `meta.toolUseId` równa się `tool_use.id`
węzła Task/Agent w pliku rodzica, a `meta.parentAgentId` daje krawędź `spawns`.

Konsekwencja liczbowa dla największej zbadanej sesji (35 MB, 5623 linie w pliku głównym):

| Metryka | Plik główny | Subagenci (52) | Razem |
|---|---|---|---|
| `tool_use` | 623 | 2 595 | 3 218 |
| Unikalne `file_path` | 89 | 371 | ~430 |
| Agenci | 1 | 52 | 53 |

Glassbox narysuje z tej sesji około 760 węzłów zamiast około 3 700. **Traci 80 % grafu, w tym
całą pracę subagentów** — czyli dokładnie tę warstwę, która najbardziej potrzebuje wizualizacji.

Powiązane znalezisko: gałąź inline sidechain w `parseSession.ts:234-241` i `:296-304` jest
martwym kodem. Zweryfikowane osobnym przebiegiem na sesji 7117-liniowej: `isSidechain` w pliku
głównym ma wartość `false` (5368 linii) albo brak (1749 linii), **nigdy `true`**. Wartość `true`
występuje wyłącznie w plikach `subagents/*.jsonl`, których parser nie czyta.

### 1.2 Layout jest płaski, więc skaluje się liniowo w poziomie

`elkLayout.ts` układa **wszystkie** węzły jednym przebiegiem `elk.algorithm: layered`,
`direction: DOWN`, przy stałym rozmiarze 220 × 76 px i `spacing.nodeNode: 40`. Kilkaset tool calli
jednego agenta trafia do jednej warstwy, więc warstwa ma szerokość rzędu `N × 260 px`. Dla 350
wywołań Bash to ponad 90 000 px w jednym rzędzie. `fitView` uczciwie mieści to w kadrze — przy
skali, w której karta ma poniżej jednego piksela. To jest bezpośrednia przyczyna problemu (a):
diagram nie mieści się nawet w maksymalnym oddaleniu, bo w oddaleniu nie ma czego czytać.

Grupowanie już w kodzie istnieje (`wrapIsolatedGroups`), ale jest wąskie i warunkowe — obejmuje
wyłącznie subagentów z izolacją `worktree`/`container`, czyli sygnałem, którego w zbadanych
transkryptach praktycznie nie ma. Mechanika jest dobra, kryterium jej uruchomienia — nie.

### 1.3 Selekcja nie istnieje jako kanał wizualny

`App.tsx:415-418` ustawia `selected` w stanie Reacta, ale ta wartość zasila **wyłącznie**
`DetailPanel`. W `useMemo` liczącym style (`App.tsx:220-255`) jedynym źródłem podświetlenia jest
`activeNode`, czyli węzeł najbliższy pozycji scrubbera, który dostaje `ACTIVE_GLOW`. Kliknięty
węzeł nie zmienia wyglądu w żaden sposób. Wbudowany mechanizm React Flow (`selected: boolean`
plus automatyczna klasa `.selected`) nie jest używany, bo `styledNodes` nadpisuje `style` w całości.

Drugi problem tego samego fragmentu jest wydajnościowy: `useMemo` zależy od `currentTime`, więc
**każdy krok scrubbera przepisuje całą tablicę węzłów i krawędzi** z nowymi obiektami `style`.
Przy 3 700 węzłach i kroku odtwarzania 300 ms to gwarantowane zacinanie — a przy trybie live
dodatkowo przy każdym debounce.

### 1.4 Głębia węzła: dane są, parser je ucina

Zweryfikowane bezpośrednio: `tool_use.input` w transkryptach jest **pełny i nieucinany**
(`Bash.command` do 13 447 znaków, `Task.prompt` do 12 797, `Workflow.input` do 41 648). Ucinanie
do 2 KB robi sam Glassbox przez `DETAIL_LIMIT` w `parseSession.ts:11`.

Poważniejsza luka: pole **`toolUseResult`** na poziomie linii, którego parser w ogóle nie czyta.
Zweryfikowane na sesji 7117-liniowej — 959 wystąpień, 21 różnych kształtów, w tym:

| Narzędzie | Klucze `toolUseResult` | Liczba |
|---|---|---|
| Bash | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` (+ `gitOperation`) | 732 |
| Edit | `filePath`, `oldString`, `newString`, `originalFile`, `replaceAll`, `structuredPatch`, `userModified` | 63 |
| Task/Agent | `agentId`, `agentType`, `description`, `prompt`, `resolvedModel`, `status`, `isAsync`, `outputFile` | 37 |
| Agent (team) | `agent_id`, `agent_type`, `model`, `team_name`, `teammate_id`, `tmux_pane_id`, `plan_mode_required` | 26 |

Dziś to wszystko przechodzi przez `contentToText()` do jednego płaskiego stringa i zostaje ucięte.
`structuredPatch` to gotowy unified diff dla każdej edycji pliku — najbogatszy pojedynczy element
kontekstu w całym zbiorze, obecnie wyrzucany.

Trzy dalsze luki tej samej klasy:

- **Czas trwania.** Parowanie `tool_use.id` → `tool_result.tool_use_id` jest stuprocentowe
  (623/623 i 977/977 w zbadanych sesjach), więc różnica timestampów daje czas wykonania bez
  żadnych dodatkowych danych. Mediana 0,2 s, p90 8-9 s. Zastrzeżenie: dla agentów asynchronicznych
  różnica mierzy latencję dostarczenia wyniku, nie pracę (obserwowane maksimum 40 557 s) — te węzły
  trzeba oznaczać osobno, po `toolUseResult.isAsync`.
- **Pełny `usage`.** Zweryfikowane: 1952/1952 linii assistant niosą komplet
  `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
  cache_creation, service_tier, speed, iterations, server_tool_use, inference_geo`.
  Glassbox bierze dwa pola z dziesięciu, więc **koszt liczony w `pricing.ts` jest systematycznie
  błędny** — tokeny cache to zwykle większość wejścia. Pułapka: `cache_read_input_tokens` jest
  kumulatywny per request, naiwna suma po liniach dała w teście 460 mln tokenów.
- **`thinking` jest ślepą uliczką.** 612 bloków w zbadanej sesji, długość treści **zawsze zero** —
  niesie tylko zaszyfrowaną `signature`. Rozumowania modelu nie da się pokazać, i nie ma sensu
  tego planować.

Metadane kontekstowe dostępne, a nietknięte: `cwd`, `gitBranch`, `version`, `slug`, `effort`,
`permissionMode`, `attributionSkill`, `attributionMcpServer` + `attributionMcpTool`, `agentName`,
`agentColor`. Atrybucja wywołania do skilla albo serwera MCP jest gotowa w danych.

### 1.5 Podsumowanie diagnozy

Glassbox rysuje poprawnie zbyt mało danych w zbyt płaskiej strukturze. Diagram nie mieści się
w kadrze nie dlatego, że danych jest za dużo, tylko dlatego, że wszystkie leżą na jednym poziomie
i mają jednakową wagę wizualną. Ten sam brak hierarchii odbiera narrację i odbiera głębię.

---

## 2. Opcje z oceną wykonalności

Werdykty React Flow zweryfikowane w `node_modules/@xyflow/react/dist/esm/` (wersja 12.11.2)
i w dokumentacji xyflow.

### 2.1 Skala grafu

| Technika | Wsparcie React Flow | Wykonalność | Rozmiar | Uwagi |
|---|---|---|---|---|
| **Zwijanie poddrzew** (collapse agenta do jednego węzła) | brak API; budulec `hidden?: boolean` na `Node`/`Edge`; oficjalny `useExpandCollapse` jest w płatnych Pro examples | wysoka | **M** | `hidden` usuwa DOM, ale węzeł zostaje w `nodeLookup` i kosztuje. Przy tysiącach lepiej nie podawać go w tablicy `nodes` w ogóle — pełny graf trzymać poza React Flow, do komponentu podawać rzut. Krawędzie trzeba ukrywać ręcznie i syntezować krawędzie proxy |
| **Semantic zoom** (LOD karty) | natywne: `useStore(selector, equalityFn)`, `useViewport()`; wzorzec Contextual Zoom | wysoka | **S** | Kluczowe: selektor **progowy** zwracający wartość stabilną referencyjnie (`z < 0.5 ? 'far' : z < 1.5 ? 'mid' : 'near'`). Wtedy węzeł renderuje się tylko przy przejściu progu, nie co klatkę. `useViewport()` wprost w karcie = re-render 60 razy na sekundę, tego nie wolno |
| **Wirtualizacja** `onlyRenderVisibleElements` | natywne, ale dziurawe | średnia | **S** | `isEdgeVisible` liczy bounding box źródła i celu, nie ścieżkę — w głębokim DAG długie krawędzie są „widoczne” zawsze. Filtr to pętla O(N) po `nodeLookup` na każdą zmianę transformu. Pomaga przy bogatych kartach i setkach węzłów, szkodzi przy tysiącach lekkich w oddaleniu |
| **Grupowanie** `parentId` + `extent` | natywne | wysoka | **S** | Już użyte w `wrapIsolatedGroups`. Twarde wymogi: rodzic przed dzieckiem w tablicy, pozycja dziecka relatywna do rodzica. Grupa **nie jest natywnie zwijalna** ani auto-wymiarowana |
| **Kadrowanie i minimapa** | natywne w komplecie | wysoka | **S** | `fitView({ nodes: [{id}], duration })` kadruje na podzbiorze; dalej `fitBounds`, `setCenter`, `getNodesBounds`, `useNodesInitialized`. MiniMap wymaga jawnego `pannable` i `zoomable` (oba domyślnie `false`) — nawigacja po minimapie jest dziś wyłączona |
| **Layout hierarchiczny w ELK** | poza React Flow | wysoka | **M** | ELK obsługuje zagnieżdżone `children`, więc układ per agent liczony osobno rozwiązuje problem szerokiej warstwy u źródła. Wymaga przebudowy `layoutGraph` z płaskiej listy na drzewo |
| **Ścieżka krytyczna / spine sesji** | własna implementacja | wysoka | **M** | Dane są: `parentUuid` daje spójne drzewo linii (5362/5362 wskazań trafia w istniejący `uuid`), czas trwania liczalny z pary timestampów. Spine = ścieżka o największym skumulowanym czasie albo po prostu łańcuch `session → main → agenci` |

**Odrzucone:** canvas/WebGL zamiast React Flow (przepisanie całej warstwy prezentacji, rozmiar XL,
traci `nodeTypes`, minimapę i całą mechanikę izolacji — nieproporcjonalne do problemu).

### 2.2 Selekcja i język wizualny

| Technika | Wsparcie | Wykonalność | Rozmiar |
|---|---|---|---|
| Selekcja z podświetleniem przez klasę CSS | natywne `selected` + klasa `.selected`; `onNodeClick`, `useOnSelectionChange` | wysoka | **S** |
| Podświetlenie sąsiedztwa 1-hop | `getConnectedEdges` istnieje, ale to `edges.filter(...)`, czyli O(E) na klik | wysoka | **S** |
| Rozdzielenie kanałów selected vs active-replay | czysto wizualne | wysoka | **S** |

Ostrzeżenie zweryfikowane w typach: dokumentacja wydajnościowa xyflow pokazuje
`useStore(s => s.selectedNodeIds)` — **takiego pola w store 12.11.2 nie ma**
(`types/store.d.ts` go nie deklaruje). Nie opierać implementacji na tym wzorcu.

Wydajny wariant 1-hop: zbudować mapę `nodeId → edgeIds` raz po layoucie i podświetlać
**klasami CSS**, nie przez `setNodes` całej tablicy. Alternatywa per węzeł: `useNodeConnections({ id })`,
który czyta `connectionLookup` (indeks, nie skan).

### 2.3 Głębia węzła

| Warstwa | Źródło danych | Wykonalność | Rozmiar |
|---|---|---|---|
| Czas trwania tool calla | para timestampów, parowalność 100 % | wysoka | **S** |
| Pełny `usage` z tokenami cache | `message.usage`, pokrycie 100 % | wysoka | **S**, ale `pricing.ts` wymaga rewizji stawek cache |
| `toolUseResult` typowany per narzędzie | pole top-level, 21 kształtów | wysoka | **M** |
| `structuredPatch` jako diff w panelu | `toolUseResult.structuredPatch` | wysoka | **M** |
| Pełny input/output bez ucinania | dane pełne, limit jest po naszej stronie | średnia | **M** — trzymać poza `GraphNode`, patrz 4.9 |
| Outputy przepełnione | `persistedOutputPath` → `tool-results/*.txt` | średnia | **S** (tryb live/serwer), niewykonalne przy wczytaniu pojedynczego pliku z dysku przez przeglądarkę |
| `thinking` | treść pusta | **niewykonalne** | — |

---

## 3. Rekomendowany kierunek

**Hierarchia zamiast płaskiego grafu — jeden model danych, trzy poziomy czytania.**

Graf domyślnie pokazuje **kręgosłup sesji**: `session → main → agenci`, z pracą każdego agenta
zwiniętą do jednego węzła zbiorczego opisanego liczbami („47 wywołań · 3 pliki · 2 błędy · 4 min").
Rozwinięcie agenta jest jawną akcją użytkownika i dokłada jego tool calle oraz pliki. Poziom
szczegółu karty dodatkowo zależy od zoomu, ale **zoom nigdy nie zmienia zbioru węzłów** — tylko
zwijanie to robi. To rozdzielenie jest istotne: gdy widok zmienia się sam, użytkownik gubi orientację.

Dlaczego ten kierunek, a nie „zoptymalizować rysowanie 3 700 węzłów”: pełny graf największej sesji
jest nieczytelny niezależnie od wydajności. Człowiek nie odczyta trzech tysięcy kart. Ograniczenie
jest poznawcze, nie techniczne, więc rozwiązanie musi redukować liczbę rzeczy na ekranie, a nie
przyspieszać ich rysowanie. Wydajność wchodzi jako konsekwencja, nie jako cel.

Ten sam ruch daje narrację. Kręgosłup sesji **jest** historią wykonania: co zleciłem, komu, ile to
kosztowało, gdzie poszło źle. Szczegół wywołań to przypisy, a przypisów nie drukuje się w treści.

Trzy poziomy głębi, jednolicie dla wątku 1 i 4:

1. **Karta na kanwie** — tożsamość i stan: typ, etykieta, status, czas trwania, tokeny, badge izolacji.
   Trzy warianty LOD sterowane progiem zoomu (`far`: kropka statusu i typ; `mid`: obecna karta;
   `near`: karta plus pierwsza linia inputu).
2. **Panel boczny** — obecny `DetailPanel` rozbudowany o czas trwania, pełny rozkład tokenów z cache,
   atrybucję (`attributionSkill` / `attributionMcpTool`), i skrócony input/output z jawnym przyciskiem
   rozwinięcia.
3. **Pełny kontekst** — panel na całą szerokość albo modal z zakładkami zależnymi od narzędzia:
   Input (sformatowany JSON), Output (`stdout` i `stderr` rozdzielone), Diff (`structuredPatch`
   dla Edit), Metryki (`toolStats`, `totalDurationMs`, `totalTokens` dla Task/Agent).

Język wizualny selekcji rozdzielony na dwa niezależne kanały, żeby nie kolidowały podczas replay:

| Stan | Sygnał wizualny |
|---|---|
| **selected** (kliknięty przez użytkownika) | ciągła obwódka 2 px w kolorze akcentu + podniesienie cienia; sąsiedzi 1-hop dostają pełną nieprzezroczystość i pogrubioną krawędź; reszta grafu przygaszona do 0,35 |
| **active-replay** (bieżąca pozycja scrubbera) | obecny `ACTIVE_GLOW` (poświata), bez zmiany obwódki |
| **oba naraz** | obwódka i poświata współistnieją — dlatego jeden jest borderem, a drugi shadowem |
| **przyszłość** (za scrubberem) | obecne `opacity: 0.12` |

---

## 4. Lista konkretnych zmian

Kolejność jest zależnościowa. Etap A jest warunkiem koniecznym pozostałych.

### Etap A — model danych (fundament)

**A.1. Parser wielopikowy: wczytywanie subagentów.** `parseSession.ts` przyjmuje dziś jeden string.
Zmienić kontrakt na zestaw plików: `{ main: string, subagents: Array<{ meta, jsonl }> }`. Sklejenie
po `meta.toolUseId` = `tool_use.id` węzła Task w rodzicu; krawędź `spawns` z `meta.parentAgentId`;
poziom z `meta.spawnDepth`. Wymaga rozszerzenia `server/live.mjs` o wykrywanie katalogu
`<sessionId>/subagents/` i wysyłanie ich przez SSE jako osobne strumienie.
*Wykonalność wysoka · rozmiar **L** · zależności: brak.*

**A.2. Usunąć martwą gałąź inline sidechain** (`parseSession.ts:234-241, 296-304`) po wdrożeniu A.1.
Zgodnie z regułą no-deletion: nie kasować, tylko oznaczyć jako nieosiągalną i przenieść wraz z
komentarzem metodologicznym — README opisuje ją jako zaobserwowaną empirycznie, więc trzeba tam
dopisać sprostowanie.
*Wykonalność wysoka · rozmiar **S** · zależy od A.1.*

**A.3. Odczyt `toolUseResult`.** Nowe pole w `GraphNode`: `result: ToolResultDetail | null`
z unią typów per narzędzie (bash / edit / read / task / generic). Zachować `output: string` dla
zgodności wstecznej.
*Wykonalność wysoka · rozmiar **M** · zależności: brak.*

**A.4. Czas trwania.** `NodeMeta.durationMs: number | null` liczony z pary timestampów
`tool_use` → `tool_result`. Węzły z `toolUseResult.isAsync === true` oznaczyć flagą
`durationIsLatency: true` — inaczej pojedynczy agent asynchroniczny (obserwowane 40 557 s)
zdominuje każdą skalę czasu w interfejsie.
*Wykonalność wysoka · rozmiar **S** · zależy od A.3.*

**A.5. Pełny `usage` i korekta kosztów.** Dodać `cacheCreationTokens` i `cacheReadTokens` do
`NodeMeta`; zrewidować `pricing.ts` o stawki cache write i cache read. Uwaga implementacyjna:
`cache_read_input_tokens` jest kumulatywny per request — sumowanie po liniach daje wynik zawyżony
o rzędy wielkości. Bez tej zmiany liczby kosztu w nagłówku są po prostu nieprawdziwe.
*Wykonalność wysoka · rozmiar **M** · zależności: brak. **Priorytet — obecny koszt wprowadza w błąd.***

**A.6. Metadane sesji.** `SessionMeta` o `cwd`, `gitBranch`, `version`, `slug`, `permissionMode`;
`GraphNode` o `attribution: { skill?, mcpServer?, mcpTool?, agentName?, agentColor? }`.
*Wykonalność wysoka · rozmiar **S**.*

### Etap B — skala i narracja

**B.1. Layout hierarchiczny.** Przebudować `layoutGraph` na zagnieżdżony graf ELK: `children`
per agent zamiast jednej płaskiej listy. Rozwiązuje szeroką warstwę u źródła i jest warunkiem
sensownego zwijania.
*Wykonalność wysoka · rozmiar **M** · zależy od A.1.*

**B.2. Zwijanie i rozwijanie agentów.** Stan `collapsedAgents: Set<string>` w `App.tsx`. Do
`<ReactFlow>` podawać **rzut** pełnego grafu, nie pełny graf z `hidden: true` — węzeł ukryty nadal
siedzi w `nodeLookup` i kosztuje. Dla zwiniętego agenta syntezować węzeł zbiorczy z agregatami
(liczba wywołań, plików, błędów, suma czasu i tokenów) oraz krawędzie proxy do węzłów zewnętrznych.
Domyślnie zwinięte wszystko poza `main`.
*Wykonalność wysoka · rozmiar **L** · zależy od B.1.*

**B.3. Semantic zoom.** Selektor progowy w `useStore` wewnątrz `Card`, zwracający `'far' | 'mid' | 'near'`.
Nigdy `useViewport()` w karcie. Trzy warianty renderu jak w sekcji 3.
*Wykonalność wysoka · rozmiar **S** · zależy od C.1 (memoizacja) dla sensownej wydajności.*

**B.4. Minimapa nawigacyjna.** Dodać `pannable` i `zoomable` do `<MiniMap>` (oba domyślnie `false`,
dlatego minimapa jest dziś martwa) plus `nodeColor` mapujący typ węzła na kolor akcentu karty.
*Wykonalność wysoka · rozmiar **S** · zależności: brak. Najtańsza pojedyncza poprawa nawigacji.*

**B.5. Kręgosłup sesji jako oś narracji.** Wyróżnić wizualnie ścieżkę `session → main → agenci`
(grubsze krawędzie, pełne nasycenie) i dodać w nagłówku nawigację „poprzedni / następny agent”
z `fitView({ nodes: [{ id }], duration: 400 })`.
*Wykonalność wysoka · rozmiar **M** · zależy od B.1.*

### Etap C — selekcja i wydajność

**C.1. Rozdzielić styl od stanu replay.** To jest kluczowa zmiana architektoniczna warstwy widoku.
Wyjąć obliczanie stylu z `useMemo` zależnego od `currentTime` (`App.tsx:220-255`) i przenieść
sterowanie wyglądem do **klas CSS** ustawianych przez `className` węzła, a stan przygaszenia
i selekcji trzymać w lekkim store czytanym selektorem wewnątrz karty. Dziś każdy krok scrubbera
przepisuje całą tablicę węzłów i krawędzi; po zmianie krok scrubbera nie dotyka tablicy `nodes` w ogóle.
*Wykonalność wysoka · rozmiar **M** · zależności: brak. **Warunek konieczny dla grafów powyżej ~500 węzłów.***

**C.2. Selekcja klikiem.** `onNodeClick` ustawia `selectedId`; karta odczytuje go selektorem i
renderuje ciągłą obwódkę. Sąsiedztwo 1-hop z mapy `nodeId → edgeIds` zbudowanej raz po layoucie
(nie `getConnectedEdges`, które jest O(E) na każde kliknięcie). Klik w tło czyści selekcję.
*Wykonalność wysoka · rozmiar **S** · zależy od C.1.*

**C.3. Higiena wydajności React Flow.** `memo()` na `Card` i wszystkich komponentach węzłów;
`elevateNodesOnSelect={false}` (domyślnie `true`, przy selekcji przepisuje z-index);
`nodesDraggable={false}` (graf i tak jest wynikiem layoutu, przeciąganie nie ma zastosowania);
`onlyRenderVisibleElements` włączone dopiero po B.2 i zmierzone — przy grafach zwiniętych do
kilkudziesięciu węzłów tylko dokłada koszt.
*Wykonalność wysoka · rozmiar **S** · zależy od C.1.*

### Etap D — głębia węzła

**D.1. Pełny input i output poza `GraphNode`.** Nie podnosić `DETAIL_LIMIT`. Parser zwraca obok
grafu mapę `Map<nodeId, FullDetail>` z pełną treścią; `GraphNode` zachowuje skrót do 2 KB na kartę
i panel. Pełna treść doczytywana z mapy dopiero przy otwarciu pełnego kontekstu. Inaczej węzeł
grafu puchnie do dziesiątek kilobajtów i przeciąga za sobą całą tablicę `nodes` przy każdym renderze.
*Wykonalność średnia · rozmiar **M** · zależy od A.3.*

**D.2. Trzeci poziom głębi — pełny kontekst.** Rozszerzyć `DetailPanel` o tryb pełnej szerokości
z zakładkami zależnymi od narzędzia: Input, Output (`stdout` i `stderr` rozdzielone), Diff
(`structuredPatch` dla Edit), Metryki (`toolStats`, `totalDurationMs`, `totalTokens` dla Task).
*Wykonalność wysoka · rozmiar **L** · zależy od A.3 i D.1.*

**D.3. Karta bogatsza o czas i atrybucję.** Czas trwania na karcie w wariancie LOD `near`,
badge skilla albo narzędzia MCP z `attribution`.
*Wykonalność wysoka · rozmiar **S** · zależy od A.4 i A.6.*

**D.4. Outputy przepełnione.** Gdy `toolUseResult.persistedOutputPath` jest obecne, dociągać treść
przez nowy endpoint serwera live. Ograniczenie: działa tylko w trybie serwera, nie przy wczytaniu
pliku z dysku przez przeglądarkę — w tym drugim przypadku pokazać jawny komunikat o niedostępności
zamiast pustego pola.
*Wykonalność średnia · rozmiar **M** · zależy od A.3.*

### Poza zakresem

**Wizualizacja `thinking`** — 612 bloków w zbadanej sesji, długość treści zawsze zero, niesie tylko
zaszyfrowaną `signature`. Nie planować.

---

## 5. Kolejność wdrożenia

Gdyby robić po jednej rzeczy naraz, kolejność jest następująca:

1. **A.5** (koszt) i **B.4** (minimapa) — najtańsze, natychmiast widoczne, bez zależności.
2. **C.1** → **C.2** → **C.3** — naprawia zgłoszony problem selekcji i zdejmuje sufit wydajnościowy.
3. **A.1** → **A.2** → **B.1** → **B.2** — właściwe rozwiązanie problemu skali; największy nakład,
   największy zwrot.
4. **A.3** → **A.4** → **D.1** → **D.2** — głębia węzła.
5. **B.3**, **B.5**, **D.3**, **D.4** — dopracowanie.

Uwaga o kolejności: kuszące jest zacząć od głębi węzła, bo to zmiana lokalna i efektowna. Byłby to
błąd — bez A.1 pełny kontekst dotyczyłby wyłącznie tych 20 % sesji, które parser dziś widzi, i
pogłębiałby wrażenie, że praca subagentów gdzieś znika.

## 6. Metodologia i weryfikacja

Wszystkie twierdzenia o danych zweryfikowane własnym przebiegiem na realnych transkryptach
z `~/.claude/projects/` (sesje 35 MB / 5623 linie, 25 MB / 796 linii, 13 MB / 7117 linii oraz
katalog 53 subagentów), nie przyjęte z raportów pośrednich. Twierdzenia o React Flow zweryfikowane
w deklaracjach typów `node_modules/@xyflow/react/dist/esm/` wersji 12.11.2 zainstalowanej w projekcie.

Kod źródłowy Glassboxa nie był modyfikowany.
