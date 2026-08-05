// Czysta logika tail: kawałki bajtów/tekstu wejściu -> pełne linie na wyjściu,
// bufor trzyma niedokończony ogon między porcjami. Bez I/O — testowalne bez serwera.

/**
 * @returns {{ push(chunk: string): string[], pending(): string }}
 */
export function createLineSplitter() {
  let buffer = "";
  return {
    /** Dokłada porcję tekstu i zwraca kompletne linie (bez końcowego \n) gotowe do wysyłki. */
    push(chunk) {
      buffer += chunk;
      const lines = [];
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      return lines;
    },
    /** Niedokończony ogon (linia bez \n na końcu) wciąż w buforze. */
    pending() {
      return buffer;
    },
  };
}
