const RELOAD_KEY = "plank:chunk-reload";

/** Nettleseren fikk HTML eller ingenting der et nytt skript skulle ligge, typisk etter en deploy. */
export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /dynamically imported module|module script failed|text\/html|MIME type/i.test(message);
}

/** Én omlasting per fane. Kalleren skal la løftet henge, så feilsiden ikke blinker først. */
export function reloadOnceForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    return false;
  }
  location.reload();
  return true;
}

export function clearChunkReload(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* privat modus */
  }
}
