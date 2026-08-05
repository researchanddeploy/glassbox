# Glassbox — taksonomia obiektów, zdarzeń i statusów sesji agentowej

Data: 2026-08-05
Autor: agent badawczy (wątek 2)
Status: raport badawczy, read-only wobec kodu źródłowego

> **Uwaga o lokalizacji pliku.** Zleceniodawca wskazał ścieżkę docelową
> `docs/plany/2026-08-05-taksonomia.md`.
> Sesja działa w trybie planu, który pozwala zapisywać wyłącznie do pliku planu,
> więc raport powstał tutaj. Przeniesienie go pod ścieżkę docelową to jedna
> operacja kopiowania po wyjściu z trybu planu — treść jest kompletna i gotowa.

> **Uwaga o prywatności.** Transkrypty w `~/.claude/projects/` są prywatne.
> Poniżej występują wyłącznie wnioski strukturalne: nazwy pól, typy rekordów,
> liczności i rozkłady. Zero cytatów treści, zero nazw projektów, zero ścieżek
> prywatnych. Badane transkrypty oznaczono neutralnie jako T1, T2, T3.

---

## 1. Co dane faktycznie umożliwiają

Metodologia jest ta sama, co w `src/parser/sandbox.ts`: klasyfikator budowany
z markerów potwierdzonych empirycznie, a nie z wyobrażeń o formacie. Zbadałem
strukturalnie trzy największe transkrypty oraz przekrój 25 największych plików
korpusu i jeden transkrypt subagenta.

Próba:

| Transkrypt | Linii | Wywołań narzędzi | Modele |
|---|---|---|---|
| T1 | 5 623 | 623 | jedna rodzina, jeden model dominujący |
| T2 | 7 117 | 977 | dwa modele w jednej sesji |
| T3 | 4 439 | 619 | jeden model |

Przekrój 25 największych plików: 5 429 wywołań `Bash`, 986 `Read`, 971 `Edit`,
352 `Agent`, 218 `Write`, 114 `SendMessage`, 111 `AskUserQuestion`, 103
`ToolSearch`, 95 `Workflow`, 24 `Skill`, oraz cała rodzina `mcp__*` (Playwright
dominuje: 151 nawigacji, 103 evaluate, 99 zrzutów ekranu).

### 1.1 Parser widzi dziś ułamek dostępnego sygnału

Obecny `parseSession.ts` czyta wyłącznie rekordy z polem `message` i wyciąga
z nich `tool_use` oraz `tool_result`. Tymczasem transkrypt zawiera **dziewięć do
trzynastu różnych typów rekordu**, a większość linii to nie wiadomości.

Rozkład typów rekordu (T2, 7 117 linii):

| `type` | Liczność | Co niesie | Czy parser to widzi |
|---|---|---|---|
| `attachment` | 2 298 | hooki, przypomnienia zadań, diagnostyka LSP | nie |
| `assistant` | 1 952 | treść modelu, `tool_use`, `usage` | częściowo |
| `user` | 1 044 | prompty i `tool_result` | tak |
| `ai-title` | 265 | tytuł nadany sesji przez model | nie |
| `agent-name` | 265 | nazwa aktywnego agenta | nie |
| `mode` | 264 | tryb pracy sesji | nie |
| `permission-mode` | 264 | tryb uprawnień | nie |
| `last-prompt` | 264 | wskaźnik ostatniego promptu | nie |
| `agent-color` | 238 | kolor agenta w UI | nie |
| `queue-operation` | 146 | kolejkowanie poleceń użytkownika | nie |
| `system` | 74 | granice kompakcji, czasy tur, hooki blokujące | nie |
| `file-history-snapshot` / `-delta` | 19 / 24 | snapshoty i backupy plików | nie |

Wniosek pierwszego rzędu: **rozszerzenie parsera o rekordy `system` i
`attachment` odblokowuje większość taksonomii zdarzeń bez żadnej heurystyki** —
to są dane wprost, z licznikami i czasami.

### 1.2 Pole `toolUseResult` — bogatsze niż blok `tool_result`

Każde wywołanie narzędzia ma odpowiadający mu rekord z polem `toolUseResult`
na poziomie głównym obiektu (nie w `message.content`), powiązany przez
`sourceToolAssistantUUID`. Parser go dziś ignoruje, a niesie znacznie więcej niż
sam tekst wyniku:

| Narzędzie | Klucze `toolUseResult` | Wartość dla taksonomii |
|---|---|---|
| `Bash` | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` | rozdzielenie „błąd" od „przerwane" i od „bez oczekiwanego wyjścia" |
| `Edit` | `filePath`, `originalFile`, `structuredPatch`, `oldString`, `newString`, `replaceAll`, `userModified` | realna diff-owa miara zmiany; `userModified` = plik ruszony poza agentem |
| `Agent` (sync) | `agentId`, `agentType`, `resolvedModel`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage`, `toolStats`, `content` | **komplet metryk subagenta gotowy do odczytu** |
| `Agent` (async) | `agentId`, `isAsync`, `status`, `outputFile`, `canReadOutputFile`, `description` | rozpoznanie spawnu w tle i wskaźnik do wyniku |
| `Workflow` | `taskId`, `taskType`, `workflowName`, `runId`, `summary`, `transcriptDir`, `scriptPath` | osobna oś: przebiegi workflow jako obiekty |
| dowolne | `gitOperation` | operacje gitowe jako klasa zdarzeń |

`toolStats` i `totalTokens` przy spawnie synchronicznym oznaczają, że dla
subagenta **nie trzeba niczego szacować** — harness sam podaje sumy.

### 1.3 Subagenci: sidecar zamiast sidechain

To najważniejsza korekta wobec założeń obecnego parsera. W **żadnym** ze
zbadanych transkryptów głównych nie ma ani jednej linii `isSidechain: true`
(T1: 0, T2: 0, T3: 0). Ścieżka „inline sidechain" w `parseSession.ts` jest
w praktyce martwa dla współczesnego formatu.

Zamiast tego: subagent dostaje **własny plik** pod
`<projekt>/<sessionId>/subagents/agent-<id>.jsonl`. W korpusie jest ich **5 946**.
Zbadany plik subagenta ma 361 linii, **wszystkie** z `isSidechain: true`, i każda
niesie pole `agentId` — dokładnie to samo, które rodzic zapisał w
`toolUseResult.agentId`. Powiązanie rodzic → dziecko jest więc **deterministyczne**,
nie heurystyczne.

Linie subagenta niosą dodatkowo `attributionAgent`, `attributionPlugin`,
`attributionMcpServer`, `attributionMcpTool` — gotowe wymiary atrybucji.

### 1.4 Równoległość nie wygląda tak, jak się zwykle zakłada

Sprawdziłem rozkład liczby bloków `tool_use` w pojedynczej wiadomości
asystenta. W T2 i T3 wynik jest jednoznaczny: **zawsze dokładnie 1**
(977/977 oraz 619/619). Heurystyka „fan-out = wiele `tool_use` w jednej
wiadomości" znalazłaby w tym korpusie **zero** przypadków, choć równoległość
niewątpliwie zachodzi.

Prawdziwe markery równoległości:

- `Agent.input.run_in_background === true` — w T2 na 68 spawnów: 44 w tle,
  5 synchronicznych, 19 bez pola.
- `system.subtype === "turn_duration"` niesie `pendingBackgroundAgentCount`
  — zaobserwowane wartości do **7 agentów jednocześnie**, oraz
  `pendingWorkflowCount`.
- Skupienie czasowe spawnów: mediana odstępu między kolejnymi spawnami
  w T2 to 32,9 s, a 41 z 67 odstępów mieści się poniżej 120 s.

`pendingBackgroundAgentCount` daje poziom współbieżności **wprost, jako liczbę** —
to jest pewna wykrywalność, nie heurystyka.

### 1.5 Kompakcja kontekstu jest zdarzeniem pierwszej klasy

`system.subtype === "compact_boundary"` (T1: 8×, T2: 5×) niesie
`compactMetadata` z kluczami: `preTokens`, `postTokens`, `cumulativeDroppedTokens`,
`trigger`, `preservedMessages`, `preservedSegment`, `durationMs`. Towarzyszą mu
`logicalParentUuid` (przeskok logicznego rodzica ponad granicą) oraz
`isCompactSummary` na rekordzie streszczenia.

To jest najmocniejszy pojedynczy sygnał dla „saturacji" — nie trzeba jej
zgadywać z tokenów, harness sam mówi, kiedy kontekst się przelał i ile
zgubiono.

### 1.6 Warstwa hooków i bramek

`attachment.type === "hook_success"` to najliczniejszy pojedynczy typ rekordu
w każdym transkrypcie (T1: 1 367, T2: 1 936, T3: 1 314). Klucze: `hookName`,
`toolUseID`, `hookEvent`, `exitCode`, `durationMs`, `stdout`, `stderr`, `command`.
Występuje też `hook_cancelled`.

Osobno `system.subtype === "stop_hook_summary"` (T1: 92, T2: 39) z kluczami
`hookCount`, `hookErrors`, `preventedContinuation`, `stopReason`,
`hasOutput`. Pole `preventedContinuation` to **bezpośredni marker hooka, który
zablokował zakończenie tury** — czyli mechaniki opisanej w regule `hook-loop`.

### 1.7 Diagnostyka i uprawnienia

- `attachment.type === "diagnostics"` z kluczami `files`, `isNew` (T2: 86, T3: 7)
  — diagnostyka LSP/kompilatora po edycji. Bezpośrednia odpowiedź na pytanie
  „czy ta edycja coś zepsuła".
- `permissionMode` oraz rekordy `permission-mode` (T2: 264) — zmiana trybu
  uprawnień w trakcie sesji.
- `toolDenialKind` (T2: 1×) — odmowa wykonania narzędzia.
- `attachment.type === "command_permissions"` (T3: 2×).

### 1.8 Zadania i przypomnienia

- `attachment.type === "task_reminder"` (T1: 109, T2: 127, T3: 85) z kluczami
  `content` i **`itemCount`** — licznik pozycji listy zadań, dostępny bez
  parsowania treści.
- `attachment.type === "task_status"` z kluczami `taskId`, `taskType`,
  `description`, `status`, `deltaSummary`, `outputFilePath`.
- Narzędzia `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskStop`/`TaskOutput` — obecne,
  ale **rzadkie i skoncentrowane**: `TaskUpdate` 13 wywołań w 1 pliku na 25,
  `TaskCreate` 8 w 1 pliku, `TaskList` 12 w 9 plikach. `TodoWrite` nie wystąpił
  w badanej próbie w ogóle.

Konsekwencja projektowa: **węzeł „zadanie" nie może opierać się na `TodoWrite`**.
Podstawą musi być `task_reminder.itemCount` plus `task_status`, a narzędzia
`Task*` traktować jako wzbogacenie, gdy są.

### 1.9 Tokeny — parser liczy dziś niepełną podstawę

`message.usage` ma klucze: `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use`,
`service_tier`, `cache_creation`, `inference_geo`, `iterations`, `speed`.

`parseSession.ts` sumuje wyłącznie `input_tokens` i `output_tokens`. Realny
kontekst wejściowy (suma trzech składników wejściowych) w T2 rósł od 83 839 do
szczytowych 396 108, a `input_tokens` bez cache to ułamek tej wartości. Dla
warstwy kosztowej i dla wykrywania saturacji **trzeba czytać wszystkie trzy pola**.

### 1.10 Błędy: rzadkie, ale niejednorodne

Udział `is_error` wśród wyników narzędzi: T1 10/623 (1,6%), T2 15/977 (1,5%),
T3 15/619 (2,4%). Klasy po zgrubnej kategoryzacji: `not-found`,
`stale-read-guard` (próba edycji pliku nieprzeczytanego w sesji), `edit-mismatch`
(niedopasowany `old_string`), `timeout`, `permission/denied`, reszta jako „inne".

Oddzielnie, poza `is_error`: `isApiErrorMessage` + `apiErrorStatus` (T1: 4, T2: 2),
`interruptedMessageId` (przerwanie przez użytkownika), `toolUseResult.interrupted`
przy `Bash`.

### 1.11 Powtórzenia i pętle

Dokładne duplikaty (ta sama nazwa narzędzia + identyczny input):

| Transkrypt | Grup | Wywołań nadmiarowych | Dominujące narzędzie |
|---|---|---|---|
| T1 | 3 | 3 | `Edit` |
| T2 | 8 | 13 | `Bash` |
| T3 | 19 | **43** | nawigacja przeglądarki (32 z 43) |

Retry bezpośrednio po błędzie (ten sam input po `is_error`) jest **rzadki**:
T1: 2, T2: 0, T3: 1. Za to najdłuższe nieprzerwane serie tego samego narzędzia
są długie: `Bash` 10 / 36 / 24, `Edit` 9 / 7 / 13.

Wniosek: klasyczna „pętla retry" (błąd → to samo wywołanie) prawie nie
występuje. Realny wzorzec patologiczny to **powtarzanie identycznego wywołania,
które kończy się sukcesem, ale nie posuwa pracy** — 32 identyczne nawigacje
w T3. To jest saturacja, nie retry, i wymaga innej heurystyki.

---

## 2. Taksonomia — warstwa (a): obiekty

`GraphNodeType` ma dziś cztery wartości. Proponuję siedem, plus dwa warianty
odłożone.

| ID (EN) | Etykieta PL | Źródło w danych | Wykrywalność | Uzasadnienie |
|---|---|---|---|---|
| `session` | sesja | pierwszy rekord z `sessionId` | pewna | istnieje |
| `agent` | agent | `Agent`/`Task` + `toolUseResult.agentId` | pewna | istnieje, wymaga dowiązania sidecara |
| `tool_call` | wywołanie | blok `tool_use` | pewna | istnieje |
| `file` | plik | `input.file_path`, `toolUseResult.filePath` | pewna | istnieje |
| `turn` | tura | `system.subtype = turn_duration` | **pewna** | nowy — nośnik czasu i współbieżności |
| `checkpoint` | punkt kontrolny | `compact_boundary`, `file-history-snapshot` | **pewna** | nowy — granice kompakcji i snapshoty |
| `task` | zadanie | `task_status`, `task_reminder.itemCount` | pewna (gdy obecne) | nowy — oś zadaniowa |
| `error_cluster` | skupisko błędów | agregat ≥3 błędów w oknie | heurystyczna | wariant widoku, nie byt w parserze |
| `hook` | hook | `attachment.hook_success` | pewna, ale **odradzam węzeł** | 1 300–1 900 wystąpień utopiłoby graf; ma być atrybutem wywołania |

### Dlaczego `turn` jest ważniejszy, niż wygląda

`turn_duration` daje `durationMs` (mediana w T2: 250 s, maksimum 23 607 s),
`messageCount`, `pendingBackgroundAgentCount`, `pendingWorkflowCount`. Tura jest
naturalnym kontenerem grupującym: pozwala zwinąć graf do poziomu „co się działo
w tej turze" bez czytania pojedynczych wywołań, i jest jedynym miejscem, gdzie
współbieżność jest podana liczbą.

### Czego nie da się zrobić bez dodatkowych danych

- **Przekroczenie zakresu zadania** (scope creep) — nie ma pola, które
  wyznaczałoby zakres. Bez semantycznego porównania promptu zlecenia z listą
  dotkniętych plików jest to niewykrywalne strukturalnie. Odkładam poza pierwszą
  iterację; przybliżenie opisane w § 3.
- **Jakość wyniku** — `is_error: false` mówi, że narzędzie się wykonało, nie że
  zrobiło coś sensownego.

---

## 3. Taksonomia — warstwa (b): zdarzenia i wzorce

Poniżej każdy wzorzec z konkretnym warunkiem wykrycia, kalibrowanym na
zmierzonych rozkładach, nie na przeczuciu.

### 3.1 Fan-out równoległy — `fanout`

**Warunek:** ≥3 spawny `Agent` z `run_in_background === true` w oknie 180 s,
**albo** `pendingBackgroundAgentCount ≥ 3` w rekordzie `turn_duration`.

**Wykrywalność:** pewna przez `pendingBackgroundAgentCount` (dane wprost),
heurystyczna przez skupienie czasowe.

**Kalibracja:** w T2 zaobserwowano wartości 1, 2, 3, 6 i 7. Próg 3 odsiewa
zwykłą delegację i łapie realny dispatch równoległy.

**Antywzorzec do uniknięcia:** liczenie bloków `tool_use` w jednej wiadomości.
Zmierzony rozkład to zawsze 1 — ta heurystyka daje zero trafień.

### 3.2 Pipeline sekwencyjny — `pipeline`

**Warunek:** ≥3 spawny `Agent` z `run_in_background !== true`, gdzie każdy
kolejny startuje po `tool_result` poprzedniego.

**Wykrywalność:** pewna (relacja czasowa spawn → wynik → spawn jest jawna).

### 3.3 Pętla retry — `retry_loop`

**Warunek:** to samo `name` + identyczny hash `input`, gdzie **poprzednie**
wystąpienie miało `is_error: true`. Próg alarmu: ≥2 powtórzenia.

**Wykrywalność:** pewna.

**Kalibracja:** rzadkie (0–2 na sesję). Niski próg jest bezpieczny właśnie
dlatego, że zjawisko jest rzadkie — każde wystąpienie jest informatywne.

### 3.4 Saturacja — `saturation`

To najważniejszy i najtrudniejszy wzorzec. Proponuję **trzy niezależne
detektory**, bo mierzą różne mechanizmy:

| Wariant | Warunek | Wykrywalność |
|---|---|---|
| `saturation_repeat` | ten sam `name` + identyczny hash `input` ≥5 razy, **niezależnie od statusu** | pewna |
| `saturation_compaction` | wystąpił `compact_boundary`; siła = `cumulativeDroppedTokens` | pewna |
| `saturation_noprogress` | okno 10 kolejnych wywołań, w którym rośnie suma tokenów wejściowych, a liczba nowo dotkniętych plików = 0 i liczba `Edit`/`Write` = 0 | heurystyczna |

**Kalibracja `saturation_repeat`:** w T3 pojedyncze wywołanie powtórzono 32 razy
przy zerowym udziale błędów. Próg 5 leży bezpiecznie powyżej normalnego szumu
(T1 i T2: maksymalnie kilka powtórzeń na grupę), a poniżej patologii.

**Uwaga metodologiczna:** `saturation_noprogress` wymaga liczenia tokenów
wejściowych jako `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`. Na samym `input_tokens` detektor nie zadziała,
bo ta wartość nie odzwierciedla realnego narastania kontekstu.

### 3.5 Seria narzędziowa — `tool_streak`

**Warunek:** ≥8 kolejnych wywołań tego samego narzędzia bez przeplotu.

**Wykrywalność:** pewna.

**Kalibracja:** zmierzone maksima to 10, 36 i 24 dla `Bash`. Próg 8 wyłapuje
długie serie, nie oznaczając ich automatycznie jako patologii — to sygnał
„tu warto zajrzeć", nie alarm.

### 3.6 Eskalacja uprawnień lub sandboxa — `escalation`

**Warunek (rozłączna alternatywa):** `Bash.input.dangerouslyDisableSandbox === true`
· zmiana `permissionMode` na luźniejszy · obecność `toolDenialKind` ·
`attachment.type === "command_permissions"`.

**Wykrywalność:** pewna. Rozszerza istniejący `sandbox.ts` o wymiar uprawnień,
którego dziś tam nie ma.

### 3.7 Blokada bramki — `gate_block`

**Warunek:** `system.subtype === "stop_hook_summary"` z
`preventedContinuation === true`, albo niepusty `hookErrors`, albo
`attachment.type === "hook_cancelled"`.

**Wykrywalność:** pewna. Bezpośrednio adresuje mechanikę pętli hooka.

### 3.8 Regresja diagnostyczna — `diagnostics_regression`

**Warunek:** `attachment.type === "diagnostics"` z `isNew === true` w oknie
5 wywołań po `Edit`/`Write`.

**Wykrywalność:** pewna. To jedyny w danych sygnał łączący edycję z jej
skutkiem jakościowym.

### 3.9 Przerwanie — `interrupted`

**Warunek:** `toolUseResult.interrupted === true`, `interruptedMessageId`,
`system.subtype === "agents_killed"`.

**Wykrywalność:** pewna.

### 3.10 Przekroczenie zakresu — `scope_drift`

**Warunek przybliżony:** dla węzła agenta — plik dotknięty przez `Edit`/`Write`,
którego ścieżka nie występuje w tekście promptu zlecenia (`Agent.input.prompt`),
ani nie jest potomkiem katalogu wymienionego w prompcie.

**Wykrywalność:** heurystyczna i słaba. Prompty często opisują zakres
semantycznie, nie ścieżkami; fałszywe alarmy będą częste. Rekomendacja: **nie
w pierwszej iteracji**, a gdy już, to jako miękka adnotacja bez koloru
alarmowego.

---

## 4. Taksonomia — warstwa (c): statusy

Obecny `NodeStatus` to `ok | error | unknown`. To za mało: „nie wiem" miesza się
z „jeszcze trwa", a „przerwane" wygląda jak „błąd".

| ID (EN) | Etykieta PL | Warunek | Wykrywalność |
|---|---|---|---|
| `ok` | wykonane | wynik obecny, `is_error !== true` | pewna |
| `error` | błąd | `is_error === true` lub `isApiErrorMessage` | pewna |
| `interrupted` | przerwane | `interrupted === true`, `interruptedMessageId`, `agents_killed` | pewna |
| `denied` | odmowa | `toolDenialKind` obecne | pewna |
| `in_progress` | w toku | spawn async bez domknięcia; sesja live | pewna |
| `retried` | ponowione | wywołanie ma późniejszy identyczny bliźniak po błędzie | pewna |
| `abandoned` | porzucone | spawn async, którego `outputFile` nigdy nie został odczytany do końca sesji | heurystyczna |
| `unknown` | nieznany | brak sygnału | pewna |

Kluczowe rozróżnienie: `unknown` powinien oznaczać wyłącznie realny brak
danych. Dziś w `parseSession.ts` węzeł bez znalezionego `tool_result` dostaje
`unknown` — a przy spawnach asynchronicznych to jest w istocie `in_progress`.
Rozdzielenie tych dwóch przypadków usuwa najczęstszą fałszywą szarość na grafie.

Warto też odróżnić dwie klasy błędu narzędziowego, bo znaczą co innego dla
czytelnika grafu: `error_tool` (narzędzie zawiodło, np. brak pliku) od
`error_api` (`isApiErrorMessage`, `apiErrorStatus` — awaria warstwy modelu).

---

## 5. Mapowanie na język wizualny

Zasada nadrzędna: **jeden kanał percepcyjny na jeden wymiar taksonomii**.
Obecnie kolor obramowania niesie typ węzła, a kropka status — to zostaje.
Nowych wymiarów nie wolno dokładać do koloru, bo zjedzą czytelność.

| Wymiar | Kanał | Kodowanie |
|---|---|---|
| Typ obiektu | kolor akcentu + ikona | jak dziś; nowe: `turn` szary neutralny `◷`, `checkpoint` bursztynowy `⎋`, `task` zielononiebieski `☑` |
| Status | kropka w prawym górnym rogu | zielony `ok`, czerwony `error`, bursztynowy `interrupted`, pomarańczowy `denied`, pulsujący niebieski `in_progress`, szary `unknown` |
| Wzorzec | badge pod nagłówkiem | jak istniejące `BoundaryBadges`, nowe etykiety w § 6 |
| Izolacja | obrys grupy przerywany | jak dziś (`IsolationGroupNode`) |
| Intensywność | grubość obramowania | proporcjonalna do tokenów węzła, 1,5–3 px |
| Czas trwania | wysokość karty albo pasek | `durationMs` z `turn_duration` i `totalDurationMs` z `toolUseResult` |
| Saturacja | tło karty | delikatny gradient rosnący z liczbą powtórzeń |

### Konflikt do rozstrzygnięcia

Czerwień jest dziś zajęta jednocześnie przez status `error` (kropka) i przez
badge `unsandboxed` oraz `filesystem-out`. Przy trzech nowych statusach
ta kolizja stanie się myląca. Rekomendacja: badge bezpieczeństwa przenieść na
paletę pomarańczowo-bursztynową, zostawiając czerwień wyłącznie dla awarii.

### Filtry

Trzy grupy przełączników, każda mapowana wprost na jedną warstwę taksonomii:

1. **Obiekty** — pokaż/ukryj typy węzłów. Największy zysk: ukrycie `file`
   (setki węzłów) i `tool_call` przy przeglądzie z lotu ptaka.
2. **Statusy** — „tylko błędy" jako jeden przełącznik to prawdopodobnie
   najczęściej używany filtr całej aplikacji: przy 1,5–2,4% udziale błędów
   redukuje graf pięćdziesięciokrotnie.
3. **Wzorce** — „pokaż tylko fan-out", „pokaż saturację", „pokaż eskalacje".

Dodatkowo dwa filtry wymiarowe, dostępne wprost z danych i tanie w implementacji:

- **Atrybucja** — `attributionSkill`, `attributionPlugin`, `attributionAgent`,
  `attributionMcpServer`. Pozwala zapytać „co zrobił ten konkretny plugin".
- **Narzędzie** — lista nazw z licznikami; `Bash` to 60–75% wywołań, więc jego
  wyłączenie samo w sobie zmienia czytelność grafu.

---

## 6. Standardowy słownik etykiet

Konwencja: identyfikator EN w kodzie (`snake_case`), etykieta PL w interfejsie.

### Typy węzłów

| EN | PL | Ikona |
|---|---|---|
| `session` | sesja | ◆ |
| `turn` | tura | ◷ |
| `agent` | agent | ● |
| `tool_call` | wywołanie | ▸ |
| `file` | plik | ▤ |
| `task` | zadanie | ☑ |
| `checkpoint` | punkt kontrolny | ⎋ |

### Statusy

| EN | PL |
|---|---|
| `ok` | wykonane |
| `error_tool` | błąd narzędzia |
| `error_api` | błąd API |
| `interrupted` | przerwane |
| `denied` | odmowa |
| `in_progress` | w toku |
| `retried` | ponowione |
| `abandoned` | porzucone |
| `unknown` | nieznany |

### Wzorce

| EN | PL (badge) | PL (opis w panelu) |
|---|---|---|
| `fanout` | rozgałęzienie | równoległy dispatch agentów w tle |
| `pipeline` | potok | sekwencja agentów, każdy po wyniku poprzednika |
| `retry_loop` | ponawianie | to samo wywołanie po błędzie |
| `saturation_repeat` | powtórka | identyczne wywołanie wielokrotnie, bez błędu |
| `saturation_compaction` | kompakcja | kontekst przepełniony, część historii odrzucona |
| `saturation_noprogress` | dryf | rośnie kontekst, nie przybywa efektów |
| `tool_streak` | seria | długi ciąg jednego narzędzia |
| `escalation` | eskalacja | zejście z sandboxa lub poluzowanie uprawnień |
| `gate_block` | bramka | hook zablokował zakończenie tury |
| `diagnostics_regression` | regresja | nowa diagnostyka po edycji |
| `scope_drift` | poza zakresem | dotknięto pliku spoza zlecenia |

### Granice i izolacja (istniejące, zachowane)

`sandboxed` → w sandboxie · `unsandboxed` → bez sandboxa · `worktree` → worktree ·
`container` → kontener · `network` → sieć · `filesystem-out` → poza systemem plików

---

## 7. Rekomendowany zakres pierwszej iteracji

Kryterium doboru: maksymalny przyrost informacji przy zerowym ryzyku
fałszywych alarmów. Wszystko poniżej to **dane wprost z transkryptu**, bez
heurystyk progowych.

### Iteracja 1 — fundament

1. **Rozszerzyć parser o rekordy `system` i `attachment`.** Bez tego reszta
   taksonomii jest niedostępna. To jedna zmiana w pętli głównej `parseSession`.
2. **Czytać `toolUseResult`.** Odblokowuje `interrupted`, `structuredPatch`,
   `gitOperation` oraz komplet metryk subagenta.
3. **Naprawić liczenie tokenów** — dodać `cache_read_input_tokens`
   i `cache_creation_input_tokens`. Bez tego warstwa kosztowa i detektor
   saturacji stoją na złej podstawie.
4. **Rozbić `unknown` na `in_progress` i `unknown`.** Usuwa najczęstszą
   fałszywą szarość.
5. **Dowiązać transkrypty subagentów** z `subagents/agent-<id>.jsonl` po
   `agentId`. Powiązanie deterministyczne; daje realną głębię grafu zamiast
   płaskich liści.
6. **Węzeł `turn`** z `durationMs` i `pendingBackgroundAgentCount`.
7. **Filtr „tylko błędy"** — najtańszy i najbardziej użyteczny filtr w całej
   aplikacji.

### Iteracja 2 — wzorce pewne

`fanout` (z licznika współbieżności), `saturation_compaction`, `escalation`,
`gate_block`, `interrupted`, `diagnostics_regression`. Wszystkie mają markery
wprost, żaden nie wymaga strojenia progów.

### Iteracja 3 — wzorce progowe

`saturation_repeat`, `tool_streak`, `retry_loop`, `pipeline`. Wymagają
kalibracji na większej próbie niż trzy transkrypty; progi z § 3 to punkt
wyjścia, nie wartości ostateczne.

### Odłożone

`scope_drift` (słaba wykrywalność), `error_cluster` jako byt parsera (lepiej
jako widok), węzły `hook` (za dużo, mają być atrybutem).

### Dług do usunięcia przy okazji

Ścieżka „inline sidechain" w `parseSession.ts` nie znajduje pokrycia w żadnym
zbadanym transkrypcie głównym (0 linii `isSidechain` w trzech plikach,
łącznie 17 179 linii). Zgodnie z regułą braku kasowania — nie usuwać, lecz
oznaczyć w komentarzu jako ścieżkę zgodności wstecznej i udokumentować, że
współczesny format używa plików sidecar.

---

## 8. Podsumowanie ustaleń kluczowych

1. Parser czyta dziś około **jednej trzeciej** typów rekordu w transkrypcie.
   Największy zysk leży w rekordach `system` i `attachment`, nie w nowych
   heurystykach.
2. Subagenci mają **własne pliki** i deterministyczne dowiązanie po `agentId`;
   ścieżka `isSidechain` w pliku głównym jest martwa.
3. Równoległość **nie** objawia się wieloma blokami `tool_use` w jednej
   wiadomości (zmierzone: zawsze dokładnie jeden). Wykrywa się ją przez
   `run_in_background` i `pendingBackgroundAgentCount`.
4. Saturacja ma **twardy marker** w `compact_boundary` z licznikiem
   odrzuconych tokenów — nie trzeba jej wnioskować.
5. Klasyczna pętla retry praktycznie nie występuje (0–2 na sesję). Realna
   patologia to identyczne wywołanie powtarzane z sukcesem (zaobserwowane 32×).
6. Liczenie tokenów pomija cache, który stanowi większość realnego kontekstu.

---

*Raport przygotowany bez modyfikacji kodu źródłowego Glassbox. Skrypty
pomocnicze użyte do analizy leżą w katalogu scratchpad sesji i nie zostały
zapisane w repozytorium.*
