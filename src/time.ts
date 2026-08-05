// Pomocnicze funkcje czasu — współdzielone przez scrubber i panel szczegółów.

/** Parsuje ISO timestamp na epokę ms; null przy braku/niepoprawnym wejściu. */
export function toEpoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Czas względny mm:ss liczony od startu sesji. */
export function formatRelative(startIso: string | null, tsIso: string | null): string {
  const start = toEpoch(startIso);
  const ts = toEpoch(tsIso);
  if (start === null || ts === null || ts < start) return "—";
  const totalSec = Math.floor((ts - start) / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
