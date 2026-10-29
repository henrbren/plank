export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

async function errorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      const data = JSON.parse(raw) as { error?: string };
      if (typeof data.error === "string" && data.error.trim()) return data.error;
    } catch {
      /* ikke JSON – typisk Cloudflares egen 503-side */
    }
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return "Tjenesten svarte ikke i tide. Prøv igjen om et øyeblikk.";
  return `Feil ${res.status}`;
}

/** Kaller Plank-API-et. path er relativ til /api. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "x-plank": "1" };
  const brand = document.documentElement.dataset.brand;
  if (brand) headers["x-plank-brand"] = brand;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: opts.signal,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth")) {
    window.dispatchEvent(new CustomEvent("plank:unauthorized"));
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Strømmer Server-Sent Events fra et POST-kall */
export async function streamPost<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "x-plank": "1", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
    credentials: "same-origin",
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, await errorMessage(res));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as E);
      } catch {
        /* ignorer ugyldige hendelser */
      }
    }
  }
}
