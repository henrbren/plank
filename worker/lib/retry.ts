/** Feil som går over av seg selv: tidsavbrudd, brutt forbindelse, 429 og 5xx */
export class TransientError extends Error {
  constructor(
    message: string,
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

/** Minste tid som må være igjen av budsjettet før vi prøver en gang til */
const MIN_LEFT_MS = 2_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isTimeout(err: unknown): boolean {
  if (typeof err !== "object" || err == null) return false;
  const name = "name" in err ? String(err.name) : "";
  const message = "message" in err ? String(err.message) : "";
  return name === "TimeoutError" || name === "AbortError" || /aborted due to timeout|timed out/i.test(message);
}

export function isTransient(err: unknown): boolean {
  return err instanceof TransientError || isTimeout(err);
}

function retryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function backoff(attempt: number): number {
  return Math.min(8_000, 700 * 3 ** attempt) + Math.floor(Math.random() * 400);
}

export interface RetryOptions {
  /** Tidsavbrudd for hvert forsøk */
  timeoutMs: number;
  /** Samlet tid for alle forsøk. Holder ett API-kall fra Plank under ca. ett minutt. */
  budgetMs: number;
  tries?: number;
  /** Navn i feilmeldinger, f.eks. «Boligmappa» */
  label: string;
}

/**
 * fetch som prøver på nytt ved forbigående feil, med økende ventetid og Retry-After.
 * Andre svar (også 4xx) returneres som de er. Kaster TransientError når forsøkene eller budsjettet er brukt opp.
 */
export async function fetchRetry(input: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const tries = opts.tries ?? 4;
  const start = Date.now();
  let failure: TransientError | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const left = opts.budgetMs - (Date.now() - start);
    if (left < MIN_LEFT_MS) break;
    const began = Date.now();
    let wait: number;
    try {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(Math.min(opts.timeoutMs, left)) });
      if (!RETRY_STATUS.has(res.status)) return res;
      const after = retryAfter(res);
      await res.body?.cancel().catch(() => undefined);
      failure = new TransientError(`${opts.label} svarte ${res.status}`, after);
      wait = after ?? backoff(attempt);
    } catch (err) {
      failure = new TransientError(isTimeout(err) ? `${opts.label} svarte ikke i tide` : `Fikk ikke kontakt med ${opts.label}`);
      wait = isTimeout(err) ? 0 : backoff(attempt);
    }
    // Brukte forsøket lang tid (typisk 504 etter 30 s fra gatewayen), gir et nytt forsøk med mindre tid ingen mening
    const spent = Date.now() - began;
    const remaining = opts.budgetMs - (Date.now() - start) - wait;
    if (remaining < Math.max(MIN_LEFT_MS, spent)) break;
    if (wait > 0) await sleep(wait);
  }
  throw failure ?? new TransientError(`${opts.label} svarer ikke`);
}
