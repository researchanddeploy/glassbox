#!/usr/bin/env bash
# Opcjonalny forwarder PostToolUse -> server/live.mjs.
#
# Live mode działa i bez tego hooka: server/live.mjs śledzi plik transkryptu
# przez fs.watch + polling co 1s. Ten skrypt tylko skraca opóźnienie do ~0 —
# każe serwerowi sprawdzić przyrost natychmiast po każdym wywołaniu narzędzia,
# zamiast czekać do najbliższego ticka pollingu.
#
# Podłączenie (ręczne, w SWOIM ~/.claude/settings.json — ten skrypt niczego
# tam nie zapisuje):
#
#   "hooks": {
#     "PostToolUse": [
#       { "hooks": [{ "type": "command", "command": "/pelna/sciezka/do/glassbox/hooks/glassbox-hook.sh" }] }
#     ]
#   }
#
# Wymaga uruchomionego `node server/live.mjs <transkrypt.jsonl>` na porcie 4517.
# Fire-and-forget: nigdy nie blokuje ani nie przerywa wykonania Claude Code.

cat >/dev/null 2>&1 # skonsumuj stdin (JSON hooka), treść nas nie interesuje
curl -s -m 1 -X POST http://localhost:4517/nudge >/dev/null 2>&1
exit 0
