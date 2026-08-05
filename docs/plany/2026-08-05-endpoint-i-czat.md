# Glassbox — endpoint dla Claude Code i okno czata w UI

**Data:** 2026-08-05 · **Wątek:** 3 (endpoint + czat) · **Status:** analiza, przed implementacją

> **Uwaga o lokalizacji pliku.** Zleceniem był zapis do
> `docs/plany/2026-08-05-endpoint-i-czat.md`.
> Sesja działa w trybie plan, który zezwala na edycję wyłącznie pliku planu — treść
> poniżej jest kompletna i gotowa do przeniesienia pod docelową ścieżkę po wyjściu
> z trybu plan.

---

## 0. Co zostało zmierzone, a co jest oszacowaniem

Wszystkie liczby w tym dokumencie pochodzą z realnych przebiegów na transkryptach
z `~/.claude/projects/<projekt>/`, nie z rozumowania o kodzie:

| Ustalenie | Sposób weryfikacji |
|---|---|
| Parser TS ładuje się natywnie w Node 25.7 (type stripping) | `node -e "import('src/parser/parseSession.ts')"` — sukces |
| Parsowanie 4 MB / 2366 linii zajmuje 11 ms | pomiar `Date.now()` wokół `parseSession()` |
| Rozmiary grafu i serializacji (tabela w §3) | `parseSession()` na trzech realnych sesjach |
| Serwer nasłuchuje na wszystkich interfejsach | `server.listen(PORT, ...)` bez argumentu hosta — `server/live.mjs:230` |
| Transport HTTP dla MCP działa lokalnie w tym środowisku | serwer `advisor` zarejestrowany jako `http http://127.0.0.1:8768/mcp` |
| Flagi `claude -p` przytoczone w §2 wariant B | `claude --help`, wersja 2.1.222 |
| Cennik modeli w §2 wariant C | skill `claude-api`, tabela modeli (cache 2026-06-24) |

Oszacowaniem — wyraźnie oznaczonym — są tylko: liczby linii kodu do napisania
i przeliczenie tokenów po współczynniku 3,5 bajtu na token.

---

## 1. Punkt wyjścia — co już jest w repozytorium

`server/live.mjs` to serwer HTTP w czystym Node (zero zależności runtime), stały
port 4517, z gotowym routingiem po `url.pathname`: `/healthz`, `/nudge`,
`/sessions`, `/events` (SSE) oraz fallback na statyczny build z `../dist`.
Utrzymuje mapę trackerów per plik `.jsonl`, każdy z backlogiem linii i zbiorem
podpiętych klientów SSE. Broadcast do przeglądarki jest więc już zaimplementowany
i przetestowany — to najważniejszy zastany element dla wszystkich trzech wariantów.

`src/parser/` jest czystym modułem TypeScript bez zależności od UI: `parseSession(raw)`
zwraca `SessionGraph { nodes, edges, meta }`. Węzły mają `id`, `type`
(`session`/`agent`/`tool_call`/`file`), `label`, `detail` (skrócony input, ~2 KB),
`output` (skrócony tool_result, ~2 KB), `meta` (timestamp, tokeny, model, status)
oraz `sandbox`. Krawędzie: `spawns`/`calls`/`touches`.

**Parser jest dostępny w Node bez kroku budowania.** Node 25.7 zdejmuje typy
natywnie, a `parseSession.ts` zawiera wyłącznie usuwalną składnię (żadnych `enum`,
`namespace` ani parameter properties). Potwierdzone uruchomieniem: import
`src/parser/parseSession.ts` wprost z procesu Node zadziałał i sparsował realny
transkrypt w 11 ms.

Jedna przeszkoda, drobna: `src/parser/index.ts` reeksportuje przez ścieżki bez
rozszerzeń (`from "./parseSession"`), czego rozwiązywanie modułów ESM w Node nie
akceptuje. Import bezpośrednio z `parseSession.ts` działa. Docelowo wystarczy
dopisać `.ts` w trzech reeksportach w `index.ts` — konwencja z rozszerzeniem jest
już zresztą obecna w repozytorium (`types.ts` importuje `"./sandbox.ts"`), a Vite
i tak ją znosi.

---

## 2. Porównanie architektur

| Kryterium | **A — serwer MCP w glassboxie** | **B — czat w UI przez `claude -p`** | **C — czat w UI przez Anthropic API** |
|---|---|---|---|
| Gdzie toczy się rozmowa | terminal (Claude Code) | okno w przeglądarce | okno w przeglądarce |
| Nowe zależności | brak (JSON-RPC ręcznie) | brak (`child_process` + zainstalowane CLI) | brak (`fetch` w Node) |
| Szacowany rozmiar implementacji | ~250 linii | ~400 linii (backend + panel React) | ~450 linii (backend + panel + pętla narzędzi) |
| Klucz API | niepotrzebny | niepotrzebny | **wymagany w env serwera** |
| Kto płaci | subskrypcja użytkownika | subskrypcja użytkownika | rozliczenie API poza subskrypcją |
| Koszt turą | 0 zł ponad subskrypcję | 0 zł ponad subskrypcję | ~$0,02 (Opus 5) / ~$0,01 (Sonnet 5) |
| Dokąd trafiają transkrypty | tam gdzie już trafiają — kanał Claude Code | jw. | **nowy kanał wyjścia** (API, inna retencja) |
| Dostęp do plików repozytorium i `~/.claude/kb` | pełny (Read/Grep/Write w Claude Code) | pełny, ale wymaga jawnego `--add-dir` i zdjęcia blokady narzędzi | brak — trzeba zaimplementować własne narzędzia |
| Zapis lekcji do kanonu | za darmo (agent ma Write) | możliwy po odblokowaniu narzędzi | wymaga własnego tool-use |
| Progresywne ładowanie kontekstu | naturalne (leniwe wywołanie narzędzia) | wymaga własnej pętli narzędzi albo wpychania z góry | jw. |
| Podświetlanie węzłów w grafie | narzędzie publikuje zdarzenie w istniejącym SSE | jw. | jw. |
| Tryb live vs post-mortem | oba (te same narzędzia, `session` jako parametr) | oba | oba |
| Historia rozmowy | w sesji Claude Code | `--session-id` / `--resume` | własna implementacja |
| Działa w kontenerze bez CLI | tak (endpoint HTTP) | **nie** (wymaga `claude` w obrazie i zalogowanej sesji) | tak |
| Największe ryzyko | rozmowa poza UI — cel „czat w oknie" niespełniony | zarządzanie cyklem życia procesu, uprawnienia narzędzi | wyciek klucza, koszt, drugi kanał danych prywatnych |

### Wariant A — serwer MCP w czystym Node

MCP to JSON-RPC 2.0. W transporcie Streamable HTTP obsłużenie klienta sprowadza
się do trzech metod: `initialize` (zwraca `protocolVersion` i deklarację
możliwości), `tools/list` (schematy narzędzi) i `tools/call` (wykonanie), plus
`notifications/initialized` jako operacja pusta. To gałąź `if (url.pathname === "/mcp")`
w istniejącym `createServer` i funkcja routująca po `body.method` — bez biblioteki,
bez SDK, zgodnie z deklarowaną w README zasadą zera zależności runtime.

Rejestracja po stronie Claude Code to jedna komenda:
`claude mcp add --transport http glassbox http://127.0.0.1:4517/mcp`. Wzorzec jest
w tym środowisku sprawdzony — serwer `advisor` jest zarejestrowany dokładnie tak
(`http://127.0.0.1:8768/mcp`), więc transport HTTP dla lokalnego serwera MCP działa
tu w praktyce, a nie tylko w specyfikacji.

Proponowany zestaw narzędzi:

| Narzędzie | Wejście | Wyjście |
|---|---|---|
| `list_sessions` | — | lista sesji z `mtime`, rozmiarem, liczbą węzłów |
| `get_session_graph` | `session`, `format` (`compact`\|`full`) | serializacja z §3 |
| `get_node_detail` | `session`, `node_id` | pełny `detail` + `output` + `sandbox` jednego węzła |
| `highlight_nodes` | `session`, `node_ids[]`, `note?` | publikuje zdarzenie SSE, UI zapala obrys |

`highlight_nodes` to punkt, w którym rozmowa steruje grafem, i kosztuje najmniej
ze wszystkiego: broadcast po `tracker.clients` już istnieje, dokłada się jeden typ
zdarzenia. Kierunek odwrotny (graf daje kontekst rozmowie) realizuje się przez
kliknięcie węzła w UI, które kopiuje jego identyfikator do schowka — asystent
w terminalu dostaje go wklejeniem i sięga po `get_node_detail`.

### Wariant B — czat w UI przez headless `claude -p`

Backend uruchamia lokalnie zainstalowane CLI i tłumaczy jego strumień na SSE do
przeglądarki. Wszystkie potrzebne flagi istnieją w wersji 2.1.222 (sprawdzone
w `claude --help`):

- `--output-format stream-json` — strumień zdarzeń do przetłumaczenia na SSE,
- `--input-format stream-json` — pozwala trzymać jeden długo żyjący proces zamiast
  uruchamiać nowy na każdą wiadomość,
- `--append-system-prompt` — wstrzyknięcie kontekstu grafu i reguł odpowiedzi,
- `--session-id` / `--resume` / `--fork-session` — trwałość wątku między odświeżeniami,
- `--tools ""` albo `--allowedTools` — zawężenie uprawnień asystenta,
- `--permission-mode` — bramka na akcje modyfikujące,
- `--max-budget-usd` — twardy limit wydatku,
- `--bare` — pominięcie hooków, CLAUDE.md i automatycznej pamięci, gdy zależy nam
  na izolacji od globalnej konfiguracji,
- `--json-schema` — wymuszenie ustrukturyzowanej odpowiedzi, co daje deterministyczny
  protokół podświetlania (`{ answer, highlight: [...] }`) bez parsowania prozy.

Wariant daje to, o co właściciel prosił wprost: okno czata w oknie przeglądarki,
zintegrowane z językiem wizualnym grafu, bez klucza API i bez kosztu ponad
subskrypcję. Płaci się za to zarządzaniem cyklem życia procesu (uruchomienie,
timeout, sprzątanie po rozłączeniu SSE, kolejkowanie wiadomości) i decyzją
o uprawnieniach — proces dziedziczy uprawnienia użytkownika, więc bez zawężenia
narzędzi asystent w przeglądarce może zapisywać pliki na dysku.

### Wariant C — bezpośrednie Anthropic API

`fetch` do `api.anthropic.com/v1/messages` z klucza w env serwera. Zero zależności
(Node ma wbudowany `fetch`), pełna kontrola nad promptem, dostęp do cache'owania
prefiksu i do wymuszonego formatu odpowiedzi.

Rachunek kosztu przy grafie 6 000 tokenów jako cache'owanym prefiksie i odpowiedzi
rzędu 800 tokenów (cennik z tabeli modeli, stan 2026-06-24):

| Model | Zapis cache (raz) | Odczyt cache (tura) | Wyjście (tura) | Tura razem | 50 tur |
|---|---|---|---|---|---|
| Opus 5 ($5/$25 za 1M) | $0,038 | $0,003 | $0,020 | **~$0,023** | ~$1,20 |
| Sonnet 5 (intro $2/$10 do 2026-08-31) | $0,015 | $0,001 | $0,008 | **~$0,010** | ~$0,50 |

Koszt jest więc pomijalny w skali sesji analitycznej — to nie on jest argumentem
przeciw. Argumentami są: klucz API w środowisku serwera, który przy `compose.yaml`
i pliku `.env` łatwo trafia w niewłaściwe miejsce; drugi, niezależny kanał, którym
prywatne transkrypty opuszczają maszynę; oraz brak dostępu do plików repozytorium
i korpusu wiedzy bez zaimplementowania własnej pętli narzędzi — czyli utrata
największej wartości analizy, jaką jest możliwość natychmiastowego zapisania lekcji
tam, gdzie wróci do przyszłych sesji.

Dwie pułapki cache'owania, gdyby wariant został kiedyś wdrożony: minimalny
cache'owalny prefiks to 512 tokenów na Opusie 5 i 1024 na Sonnecie 5 (graf 6 000
mieści się z zapasem), a domyślny czas życia wpisu to 5 minut — sesja analityczna
z dłuższymi przerwami traci cache i płaci zapis ponownie, więc dla takiego profilu
użycia właściwy jest `ttl: "1h"` (zapis 2× zamiast 1,25×).

---

## 3. Przepływ danych i serializacja grafu

### Zmierzone rozmiary

Trzy realne sesje, parsowane tym samym `parseSession()`, format kompaktowy opisany
niżej (przeliczenie na tokeny po 3,5 bajtu na token):

| Sesja | JSONL | Węzły (agent / tool_call / file) | Czas parsowania | Kompakt | Pełny `detail`+`output` |
|---|---|---|---|---|---|
| 4 MB, 2366 linii | 4 MB | 343 (42 / 286 / 14) | 11 ms | **20 KB ≈ 5 900 tok.** | 514 KB ≈ 147 000 tok. |
| 25 MB, 796 linii | 25 MB | 134 (5 / 104 / 24) | 36 ms | **7 KB ≈ 2 000 tok.** | — |
| 11 MB | 11 MB | 54 (1 / 33 / 19) | 16 ms | **3 KB ≈ 750 tok.** | — |

**Najważniejszy wniosek: rozmiar transkryptu nie mówi nic o rozmiarze grafu.**
Sesja 25 MB dała mniejszy graf niż sesja 4 MB, bo jej objętość to treść (obrazy,
duże wyniki narzędzi), a nie struktura. Kompaktowa serializacja jest więc bezpieczna
niezależnie od wielkości pliku — nawet najbogatsza z badanych sesji mieści się
w 6 000 tokenów, czyli w budżecie, który można trzymać w kontekście rozmowy bez
zastanowienia. Pełny zrzut z `detail` i `output` (147 000 tokenów) mieści się
wprawdzie w oknie 1M, ale jako domyślne zachowanie jest marnotrawstwem — i to
przesądza o dwuwarstwowym projekcie formatu.

### Format kompaktowy

TSV bez nagłówków, dwie sekcje. Węzły — jeden wiersz na węzeł:

```
n0	s	sesja c2258b53	claude-opus-5	1233	700326		0
n1	a	main			ok	0
n2	t	Bash: npm run build	claude-opus-5	412	1180		37	unsandboxed
n3	f	src/parser/parseSession.ts					41
```

Kolumny: `id` · `typ` (pierwsza litera: `s`/`a`/`t`/`f`) · `label` (40 znaków) ·
`model` · `tokIn` · `tokOut` · `status` (puste = `ok`) · `offset` w sekundach od
początku sesji · `isolation`. Krawędzie — jeden wiersz na krawędź: typ (pierwsza
litera) i dwa identyfikatory.

Trzy decyzje, które dały redukcję z 16 400 do 5 900 tokenów na największej sesji
(mierzone, nie szacowane): sekwencyjne identyfikatory `n0…nN` zamiast długich
kluczy oryginalnych, offset sekundowy zamiast znacznika ISO 8601, i pominięcie
wartości domyślnych (`status: ok`, zerowe liczniki tokenów). Identyfikatory
sekwencyjne wymagają mapy `n7 → oryginalne_id` po stronie serwera, żeby
`get_node_detail` i `highlight_nodes` trafiały we właściwy węzeł — mapa i tak
powstaje przy serializacji, więc to koszt zerowy.

### Warstwa druga — drill-down

`get_node_detail(session, node_id)` zwraca pełny `detail`, `output`, `sandbox`
i sąsiedztwo w grafie jednego węzła: do ~4 KB, czyli ~1 200 tokenów. Przy typowej
analizie asystent sięga po kilka do kilkunastu węzłów, co daje 5–15 tysięcy tokenów
zamiast 147 tysięcy zrzutu hurtowego. To jest właśnie ta różnica, która sprawia,
że MCP pasuje do zadania lepiej niż czat: leniwe wywołanie narzędzia jest w MCP
domyślnym trybem pracy, a w czacie trzeba je zaimplementować jako osobną pętlę
narzędzi po stronie backendu.

### Protokół podświetlania

Kierunek rozmowa → graf: `highlight_nodes` zapisuje `{ ids, note, ts }` do trackera
sesji i rozgłasza `sse(res, "highlight", ...)` po podpiętych klientach. W `App.tsx`
dochodzi obsługa nowego typu zdarzenia obok istniejących `backlog` i `line`: stan
`highlightedIds`, a w budowaniu węzłów React Flow — dodatkowy `boxShadow` w tym
samym języku wizualnym co obecne `ACTIVE_GLOW`. Nakład po stronie UI jest
kilkudziesięciolinijkowy, bo cała maszyneria SSE, wybór sesji i akumulacja stanu
już działają.

Kierunek graf → rozmowa: kliknięcie węzła kopiuje jego identyfikator do schowka
(wariant A), albo wstawia go do pola czatu jako odwołanie (warianty B i C).

### Bezpieczeństwo

**Ekspozycja sieciowa, która istnieje już dziś.** `server.listen(PORT, ...)`
(`server/live.mjs:230`) nie podaje hosta, więc serwer nasłuchuje na wszystkich
interfejsach, a `/events` zwraca `Access-Control-Allow-Origin: *` (linia 213).
W praktyce oznacza to, że każdy w tej samej sieci lokalnej może dziś odczytać
listę sesji i strumień transkryptów — a transkrypty Claude Code zawierają treści
plików, ścieżki, fragmenty korespondencji i wszystko, co użytkownik wkleił w trakcie
pracy. Dodanie któregokolwiek z trzech wariantów podnosi stawkę: MCP i czat dokładają
operacje zapisu (adnotacje, lekcje), a wariant C dokłada proxy do płatnego API,
z którego obca osoba w LAN mogłaby korzystać na cudzy rachunek.

Rekomendacja niezależna od wybranego wariantu: nowe endpointy (`/mcp`, `/chat`)
wiązać jawnie z `127.0.0.1`, a docelowo rozważyć przeniesienie tam całego serwera
z osobnym przełącznikiem `GLASSBOX_BIND` dla świadomego udostępnienia w sieci.
W kontenerze publikacja portu i tak przechodzi przez mapowanie `compose.yaml`,
więc wiązanie na pętli zwrotnej wewnątrz kontenera niczego nie psuje.

**Klucze.** Warianty A i B nie wprowadzają żadnego sekretu do systemu — to ich
najmocniejsza przewaga. Wariant C wymaga `ANTHROPIC_API_KEY` w środowisku serwera;
przy istniejącym `compose.yaml` i pliku `.dockerignore` trzeba wtedy sprawdzić, czy
`.env` nie trafia do obrazu, i pamiętać, że `docker restart` nie przeładowuje `.env`.

**Uprawnienia asystenta.** W wariancie B proces `claude` dziedziczy uprawnienia
użytkownika. Domyślnie należy startować z `--tools ""` i dokładać narzędzia
świadomie, plus `--permission-mode` na akcjach modyfikujących. `--bare` odcina
hooki i globalny CLAUDE.md, co dla asystenta analitycznego jest zaletą: dostaje
kontekst grafu, a nie całą konfigurację użytkownika.

---

## 4. Format lekcji

### Gdzie lekcje mają trafiać

Kanonicznym miejscem wiedzy operacyjnej jest korpus `~/.claude/kb/` w formacie
OKF v0.2 — wersjonowany w git, z typem `Lesson` przewidzianym wprost dla lekcji
z incydentów, walidowany przez `kb.py lint` i obsługiwany skillem `/kb`. Kontrakt
korpusu mówi też wprost, czego tam **nie** wolno umieszczać: „rzeczy wywodliwych
z kodu lub `git log`" oraz „detali jednej sesji". To rozstrzyga projekt formatu —
potrzebne są dwa poziomy, nie jeden.

### Poziom 1 — adnotacja (materiał roboczy, w repozytorium glassboxa)

Obserwacja przypięta do konkretnych węzłów konkretnej sesji. Nie jest wiedzą, jest
surowcem. Plik `data/annotations/<session-id>.json` w repozytorium glassboxa
(katalog dopisany do `.gitignore` — to dane prywatne):

```json
{
  "session": "c2258b53-….jsonl",
  "annotations": [
    {
      "node_ids": ["n41", "n42", "n43"],
      "at": "2026-08-05T18:40:00Z",
      "by": "opus-5",
      "note": "Trzy kolejne Bash-e z tym samym `npm run build` — drugi i trzeci bez zmiany w plikach między nimi.",
      "evidence": "output n42: '0 errors' identyczny jak n41"
    }
  ]
}
```

Adnotacje są tanie, mogą być liczne i mogą się mylić. Powstają w trakcie analizy,
żyją w repozytorium projektu i mogą być pokazywane w panelu szczegółów jako warstwa
nad grafem.

### Poziom 2 — lekcja (kandydat do kanonu, w `~/.claude/kb/lessons/`)

Uogólnienie, które przeżyje tę sesję. Format zgodny z kontraktem OKF v0.2, z proweniencją
zapisaną w istniejącym mechanizmie `sources` — bez wymyślania nowych pól frontmatteru:

```markdown
---
type: Lesson
title: Powtórzony build bez zmiany w plikach kosztuje minutę na przebieg
description: Trzy identyczne `npm run build` pod rząd w jednej sesji; drugi i trzeci nie miały czego przebudować.
status: draft
confidence: B
digest: ondemand
generated: { by: opus-5, at: 2026-08-05T18:40:00Z }
stale_after: 2026-11-05
tags: [glassbox, bramki-jakosci, marnotrawstwo]
sources:
  - id: glassbox-c2258b53-n41
    resource: sesja <session-uuid>.jsonl, węzły n41–n43
    title: Analiza w glassboxie 2026-08-05
---

# Obserwacja

[co się stało, z dosłownym cytatem z `output` węzła w blockquote]

**Dlaczego:** [przyczyna, z datą albo incydentem]
**Jak stosować:** [obserwowalne zachowanie, nie intencja]
```

Trzy elementy są tu nienegocjowalne, bo wynikają z kontraktu korpusu:
`type: Lesson`, `generated.by` z aktorem, oraz obie linie `**Dlaczego:**` /
`**Jak stosować:**` — bez nich `kb.py lint` odrzuci plik jako nieegzekwowalny.
Nowa lekcja z automatu dostaje `status: draft` i `digest: ondemand`; promocję do
`stable` i ewentualnie do warstwy always-on wykonuje człowiek przez `/kb`, zgodnie
z istniejącą procedurą sanityzacji.

### Jak lekcja wraca do Claude Code

Pętla domyka się bez nowej infrastruktury. Plik w `~/.claude/kb/lessons/` trafia
do spisu w `kb-digest.md` przy najbliższej regeneracji digestu (`/kb`), a digest
jest importowany w globalnym `CLAUDE.md` — więc każda kolejna sesja widzi tytuł
i jednozdaniowy opis lekcji, a pełną treść doczytuje wprost przez `Read`, gdy staje
się istotna. To dokładnie ten mechanizm, dla którego korpus powstał; glassbox nie
buduje własnego magazynu wiedzy, tylko zasila istniejący.

To także najmocniejszy argument techniczny za wariantem A: asystent działający
w Claude Code **ma już** narzędzie `Write` i dostęp do `~/.claude/kb/`, więc zapis
lekcji jest jednym wywołaniem narzędzia. Czat w przeglądarce (warianty B i C)
musiałby dostać do tego osobny endpoint albo osobne narzędzie, z osobną bramką
uprawnień — i to przy zapisie do katalogu, który jest źródłem prawdy o metodzie pracy.

---

## 5. Rekomendacja

**Na start: wariant A — serwer MCP w glassboxie.** Zdecydowanie, nie warunkowo.

Sześć powodów, w kolejności wagi:

1. **Rozwiązuje właściwy problem.** Deklarowanym celem jest prowadzenie analizy
   wykonania sesji i tworzenie lekcji na przyszłość — nie posiadanie czata.
   Asystent w Claude Code ma do tego pełny warsztat: czyta repozytorium, grepuje,
   zapisuje lekcję do korpusu, sięga po `git log`. Czat w przeglądarce zaczyna
   od zera przy każdej z tych rzeczy.
2. **Zamyka pętlę wiedzy bez nowej infrastruktury.** Lekcja zapisana przez
   `Write` do `~/.claude/kb/lessons/` wraca do przyszłych sesji przez digest.
   W wariantach B i C ten sam efekt wymaga zbudowania kanału zapisu i bramki
   uprawnień do katalogu, który jest źródłem prawdy o metodzie pracy.
3. **Najniższy koszt przy zastanej architekturze.** Jedna gałąź w istniejącym
   `createServer`, cztery narzędzia, mapa identyfikatorów. Parser działa w Node
   bez kroku budowania — sprawdzone uruchomieniem. Zero zależności runtime,
   zgodnie z zasadą, na której serwer został zbudowany.
4. **Zero nowych sekretów i zero nowych kanałów danych.** Transkrypty nie
   opuszczają maszyny inaczej, niż opuszczają ją dziś przez samo używanie
   Claude Code. Wariant C wprowadza klucz API i drugi kanał wyjścia dla danych,
   które bywają wrażliwe.
5. **Progresywne ładowanie jest w MCP darmowe.** Zmierzona różnica między zrzutem
   hurtowym a drill-downem to 147 000 wobec 5–15 tysięcy tokenów. W MCP wychodzi
   to z konstrukcji protokołu; w czacie trzeba je napisać jako osobną pętlę.
6. **Dwukierunkowość graf ↔ rozmowa kosztuje kilkadziesiąt linii**, bo broadcast
   SSE jest już zaimplementowany i przetestowany.

**Czego wariant A nie daje i trzeba to powiedzieć wprost:** okna czata w UI.
Właściciel prosił o nie wprost („idealnie okno czata w UI"). Wariant A daje
podświetlanie węzłów sterowane z rozmowy i pełną integrację z językiem wizualnym
grafu, ale sama rozmowa toczy się w terminalu obok przeglądarki. To świadomy
kompromis pierwszej iteracji — i, co istotne, **nie jest ślepą uliczką**.

### Droga migracji

Warstwa danych zaprojektowana dla MCP jest tą samą warstwą, której potrzebują oba
pozostałe warianty. Serializacja grafu, mapa identyfikatorów, drill-down po węźle
i zdarzenie `highlight` w SSE nie zmieniają się przy żadnym z kolejnych kroków.

**Do wariantu B** (okno czata, subskrypcja): backend uruchamia
`claude -p --strict-mcp-config --mcp-config <serwer MCP glassboxa>`, czyli asystent
w przeglądarce dostaje **dokładnie te same cztery narzędzia**, które właśnie
zbudowaliśmy. Dokłada się panel czata w React, tłumaczenie `stream-json` na SSE
i zarządzanie procesem. Serwer MCP nie wymaga wtedy żadnej zmiany — to on jest
warstwą, na której czat stoi.

**Do wariantu C** (wdrożenie bez CLI, np. publiczne demo albo kontener bez
zalogowanej sesji): ten sam prompt, ta sama serializacja, ten sam protokół
podświetlania, inny transport — `fetch` zamiast `child_process`, plus własna pętla
tool-use odwzorowująca cztery narzędzia MCP. To fallback, nie cel.

Kolejność jest więc addytywna: A jest fundamentem, B jest warstwą prezentacji nad
nim, C jest alternatywnym transportem dla środowisk bez CLI. Żaden krok nie
unieważnia poprzedniego.

---

## 6. Minimalny zakres pierwszej iteracji

Sześć punktów, w kolejności wykonania:

1. **Parser importowalny z Node.** Dopisać `.ts` w trzech reeksportach
   `src/parser/index.ts`. Zweryfikować, że `npm run build` i `npm test` nadal
   przechodzą (Vite znosi rozszerzenia, ale to musi być sprawdzone przebiegiem,
   nie założone). Jeżeli obraz Docker ma zostać na `node:22-alpine`, dołożyć
   `--experimental-strip-types` w `CMD`; alternatywnie podbić bazę do `node:24`.

2. **Serializator grafu w `server/graphSerializer.mjs`.** Funkcja
   `serializeCompact(graph)` → `{ tsv, idMap }` w formacie z §3, plus
   `serializeNode(graph, id)` dla drill-downu. Test w `vitest` obok istniejących
   testów `lineSplitter` i `sessionPath`: asercja na budżet tokenów (kompakt
   największej sesji poniżej 8 000 tokenów) i na odwracalność mapy identyfikatorów.

3. **Endpoint `POST /mcp` w `server/mcp.mjs`.** JSON-RPC 2.0: `initialize`,
   `notifications/initialized`, `tools/list`, `tools/call`. Nasłuch wiązany
   z `127.0.0.1`. Odpowiedź jako zwykły JSON (bez strumienia SSE — narzędzia są
   szybkie: parsowanie największej sesji zajęło 36 ms).

4. **Cztery narzędzia** z tabeli w §2: `list_sessions`, `get_session_graph`,
   `get_node_detail`, `highlight_nodes`. Walidacja parametru `session` musi
   przechodzić przez istniejące `resolveSessionPath` — inaczej endpoint MCP
   omija zabezpieczenie przed wyjściem poza katalog sesji, które zostało już
   napisane i przetestowane dla `/events`.

5. **Podświetlanie w UI.** Obsługa zdarzenia `highlight` w `App.tsx` obok
   `backlog` i `line`, stan `highlightedIds`, obrys w języku wizualnym istniejącego
   `ACTIVE_GLOW`. Panel szczegółów pokazuje `note` z ostatniego wywołania.

6. **Dokumentacja.** Akapit w `README.md` z komendą rejestracji
   (`claude mcp add --transport http glassbox http://127.0.0.1:4517/mcp`),
   opisem czterech narzędzi i jawnym stwierdzeniem, że endpoint jest wiązany
   z pętlą zwrotną.

**Poza zakresem pierwszej iteracji:** trwałe adnotacje, zapis lekcji po stronie
serwera (asystent w Claude Code zapisze je sam przez `Write`), okno czata w UI,
autoryzacja endpointu MCP.

**Osobne, niezależne od tego wątku:** wiązanie sieciowe całego serwera (§3,
Bezpieczeństwo). Dziś `/sessions` i `/events` są dostępne dla całej sieci lokalnej
z `Access-Control-Allow-Origin: *` — to znalezisko dotyczy stanu obecnego, nie
projektowanej zmiany, i powinno dostać własną poprawkę niezależnie od decyzji
o endpoincie.

### Kryteria ukończenia

- `claude mcp list` pokazuje `glassbox` jako połączony.
- W Claude Code wywołanie `get_session_graph` na realnej sesji zwraca graf poniżej
  8 000 tokenów, a `get_node_detail` na wskazanym węźle zwraca jego pełny `detail`.
- `highlight_nodes` zapala obrys w otwartej przeglądarce — potwierdzone zrzutem
  ekranu, nie logiem.
- `npm test` i `npm run build` zielone; nowe testy serializatora przechodzą.
- Próba `get_session_graph` ze ścieżką `../../etc/passwd` kończy się odmową.
