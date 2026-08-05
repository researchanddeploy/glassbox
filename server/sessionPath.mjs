// Walidacja ścieżki sesji względem katalogu sesji: chroni przed path traversal
// (../, ścieżki absolutne, symlinki wyprowadzające poza katalog). Czysta logika
// na fs — testowalna bez serwera HTTP.
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function isWithin(dir, target) {
  const rel = relative(dir, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel);
}

/**
 * Rozwiązuje `relPath` względem `sessionsDir` i zwraca bezpieczną ścieżkę bezwzględną,
 * albo `null`, jeśli ścieżka jest niedozwolona (absolutna, `..` wyprowadzające poza
 * katalog, albo symlink wskazujący poza katalog).
 * @param {string} sessionsDir
 * @param {string} relPath
 * @returns {string | null}
 */
export function resolveSessionPath(sessionsDir, relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (isAbsolute(relPath)) return null;
  const sessionsAbs = resolve(sessionsDir);
  const candidate = resolve(sessionsAbs, relPath);
  if (!isWithin(sessionsAbs, candidate)) return null;
  if (!existsSync(candidate)) return candidate; // ścieżka bezpieczna, ale plik nie istnieje — niech wywołujący to zgłosi
  let real;
  let realSessionsAbs;
  try {
    real = realpathSync(candidate);
    realSessionsAbs = realpathSync(sessionsAbs);
  } catch {
    return null;
  }
  if (!isWithin(realSessionsAbs, real)) return null;
  return real;
}
