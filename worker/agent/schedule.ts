/**
 * Enkle tidsplaner for agenter, tolket i Europe/Oslo:
 *   daily@07:00         hver dag kl. 07:00
 *   weekdays@07:00      mandag–fredag kl. 07:00
 *   weekly:1@07:00      hver mandag (1=man … 7=søn)
 *   monthly:1@07:00     den 1. hver måned
 */
const TZ = "Europe/Oslo";

interface Parsed {
  kind: "daily" | "weekdays" | "weekly" | "monthly";
  day: number;
  hour: number;
  minute: number;
}

export function parseSchedule(s: string | null | undefined): Parsed | null {
  if (!s) return null;
  const m = /^(daily|weekdays|weekly|monthly)(?::(\d{1,2}))?@(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const kind = m[1] as Parsed["kind"];
  const day = m[2] ? Number(m[2]) : 1;
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  if (hour > 23 || minute > 59) return null;
  if (kind === "weekly" && (day < 1 || day > 7)) return null;
  if (kind === "monthly" && (day < 1 || day > 28)) return null;
  return { kind, day, hour, minute };
}

export function describeSchedule(s: string | null | undefined): string {
  const p = parseSchedule(s);
  if (!p) return "Ingen tidsplan";
  const time = `kl. ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const days = ["", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
  switch (p.kind) {
    case "daily":
      return `Hver dag ${time}`;
    case "weekdays":
      return `Hverdager ${time}`;
    case "weekly":
      return `Hver ${days[p.day]} ${time}`;
    case "monthly":
      return `Den ${p.day}. hver måned ${time}`;
  }
}

/** Offset (ms) mellom Oslo-tid og UTC for et gitt tidspunkt */
function tzOffsetMs(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Konverterer lokal Oslo-tid til UTC-ms */
function osloToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = tzOffsetMs(guess - tzOffsetMs(guess));
  return guess - off1;
}

/** Neste kjøretidspunkt (UTC ms) etter `fromMs` */
export function nextRunAt(schedule: string | null | undefined, fromMs = Date.now()): number | null {
  const p = parseSchedule(schedule);
  if (!p) return null;
  // Start fra dagens dato i Oslo
  const local = new Date(fromMs + tzOffsetMs(fromMs));
  let y = local.getUTCFullYear();
  let mo = local.getUTCMonth();
  let d = local.getUTCDate();
  for (let i = 0; i < 400; i++) {
    const candidateDate = new Date(Date.UTC(y, mo, d + i));
    const cy = candidateDate.getUTCFullYear();
    const cm = candidateDate.getUTCMonth();
    const cd = candidateDate.getUTCDate();
    const dow = ((candidateDate.getUTCDay() + 6) % 7) + 1; // 1=man
    let ok = false;
    if (p.kind === "daily") ok = true;
    else if (p.kind === "weekdays") ok = dow <= 5;
    else if (p.kind === "weekly") ok = dow === p.day;
    else if (p.kind === "monthly") ok = cd === p.day;
    if (!ok) continue;
    const t = osloToUtc(cy, cm, cd, p.hour, p.minute);
    if (t > fromMs) return t;
  }
  return null;
}
