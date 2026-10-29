import { z } from "zod";
import type { Env } from "../env";
import { callClaude, claudeConfigured, textOf } from "./anthropic";
import { badRequest } from "./http";
import { aiPause, aiPauseMessage, recordUsage } from "./usage";

const PLAN_MODEL_FALLBACK = "claude-sonnet-5-5";

const roomSchema = z.object({
  number: z.string().trim().max(30).nullable(),
  name: z.string().trim().min(1).max(80),
  usage: z.string().trim().max(80).nullable(),
  area: z.number().finite().min(0).max(100_000).nullable(),
});

export interface FloorplanRoom {
  number: string | null;
  name: string;
  usage: string | null;
  area: number | null;
  /** Nedre venstre hjørne og utstrekning i meter, bare når veggene er synlige. */
  x: number | null;
  y: number | null;
  w: number | null;
  d: number | null;
}
export interface FloorplanDraft {
  note: string;
  floors: { name: string; level: number; rooms: FloorplanRoom[] }[];
}

const PROMPT = `Du leser en plantegning for et bygg. Svar med ett JSON-objekt og ingenting annet.

For hvert rom som har et navn inne i en flate av vegger:
- name, og number hvis det står et romnummer. Hvis bare nummer, sett name til «Rom».
- usage kan være null
- area bare når det står et tall med m², m2 eller kvm. Ikke regn ut areal.
- x, y, w, d som heltall fra 0 til 100. Det er prosent av husets yttervegg, ikke av papiret.
  Origo er nedre venstre hjørne av ytterveggen. x øker mot høyre, y oppover.
  Rektanglene skal ligge kant i kant slik veggene viser, uten å overlappe.
  Et rom som stikker ut fra resten, skal stikke ut i tallene også.
  Alle slike rom skal ha x, y, w og d. Null bare hvis rommet ikke er en tegnet flate.

Ikke finn på rom som ikke er navngitt. Ikke bruk møbler som rom.
level: kjeller og U1 er -1, U2 er -2, 1. etasje er 0, 2. etasje er 1. Flere ark kan være flere etasjer.
Hvis tegningen er uleselig, returner tom floors og forklar kort i note.

Format:
{"note":"","floors":[{"name":"1. etasje","level":0,"rooms":[{"number":null,"name":"Stue","usage":null,"area":null,"x":40,"y":0,"w":35,"d":40},{"number":null,"name":"Kjøkken","usage":null,"area":null,"x":0,"y":40,"w":40,"d":35}]}]}`;

function asText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function asArea(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000) return value;
  if (typeof value !== "string") return null;
  const n = Number(value.replace(/m²|m2|kvm/gi, "").trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 100_000) return null;
  return n;
}

function asLen(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(",", ".")) : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

function asLevel(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  if (!Number.isInteger(n) || n < -5 || n > 80) return 0;
  return n;
}

export function parseFloorplan(text: string): FloorplanDraft {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw badRequest("Vi klarte ikke å lese plantegningen. Prøv et tydeligere bilde av én etasje.");
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw badRequest("Vi klarte ikke å lese plantegningen. Prøv et tydeligere bilde av én etasje.");
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const note = asText(obj.note, 500) ?? "";
  const floorsIn = Array.isArray(obj.floors) ? obj.floors.slice(0, 40) : [];
  const floors: FloorplanDraft["floors"] = [];
  for (const item of floorsIn) {
    if (!item || typeof item !== "object") continue;
    const floor = item as Record<string, unknown>;
    const name = asText(floor.name, 80);
    if (!name) continue;
    const roomsIn = Array.isArray(floor.rooms) ? floor.rooms.slice(0, 200) : [];
    const rooms: FloorplanRoom[] = [];
    for (const roomItem of roomsIn) {
      if (!roomItem || typeof roomItem !== "object") continue;
      const room = roomItem as Record<string, unknown>;
      const parsed = roomSchema.safeParse({
        number: asText(room.number, 30),
        name: asText(room.name, 80) ?? (asText(room.number, 30) ? "Rom" : ""),
        usage: asText(room.usage, 80),
        area: asArea(room.area),
      });
      if (parsed.success) rooms.push({ ...parsed.data, x: asLen(room.x), y: asLen(room.y), w: asLen(room.w), d: asLen(room.d) });
    }
    floors.push({ name, level: asLevel(floor.level), rooms });
  }
  return { note, floors };
}

export async function interpretFloorplan(env: Env, orgId: string, mime: string, bytes: ArrayBuffer): Promise<FloorplanDraft> {
  if (!claudeConfigured(env)) {
    return { note: "Tegningen er lagret. Lesing av plantegninger er ikke satt opp ennå.", floors: [] };
  }
  const pause = await aiPause(env, orgId);
  if (pause) return { note: `Tegningen er lagret, men ble ikke lest. ${aiPauseMessage(pause)}`, floors: [] };
  const isPdf = mime === "application/pdf";
  const source = { type: "base64" as const, media_type: mime, data: toBase64(bytes) };
  const model = env.DEFAULT_MODEL || PLAN_MODEL_FALLBACK;
  try {
    const res = await callClaude(env, {
      model,
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            isPdf ? { type: "document", source } : { type: "image", source },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    await recordUsage(env, { orgId, model, usage: res.usage, source: "document" });
    return parseFloorplan(textOf(res.content));
  } catch (err) {
    console.warn("Plantegning kunne ikke leses", err instanceof Error ? err.message : err);
    return { note: "Vi klarte ikke å lese tegningen. Den er likevel lagret under Dokumenter. Prøv et tydeligere bilde, eller legg inn etasjen selv.", floors: [] };
  }
}

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}
