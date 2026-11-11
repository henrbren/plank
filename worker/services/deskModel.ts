import type { DeskFact, DeskKpi, DeskMatch, DeskOffer, DeskRow, DeskTall, LeaseKind } from "../../shared/types";

export type UnitStatus = "vacant" | "make_ready" | "occupied" | "reserved";
export type LeaseStage = "vedtak" | "offer" | "contract" | "move_in" | "active" | "move_out" | "ended";

export interface UnitRow {
  id: string;
  building_id: string | null;
  name: string;
  address: string | null;
  kind: LeaseKind;
  area_sqm: number | null;
  rooms: number | null;
  status: UnitStatus;
  market_rent_year: number;
  vacant_since: string | null;
}

export interface LeaseRow {
  id: string;
  unit_id: string | null;
  kind: LeaseKind;
  tenant_name: string;
  stage: LeaseStage;
  rent_year: number;
  start_on: string | null;
  end_on: string | null;
  break_on: string | null;
  signed_on: string | null;
  listed_on: string | null;
  arrears_nok: number;
  arrears_days: number;
  index_on: string | null;
  move_out_on: string | null;
  keys_on: string | null;
  vedtak_on: string | null;
  need: string | null;
  household: string | null;
}

export interface DeskWork extends DeskRow {
  priority: number;
  leaseId: string | null;
  unitId: string | null;
  letterKind: string | null;
  taskTitle: string | null;
  taskDue: string | null;
  money: number;
  ageDays: number | null;
}

export interface DeskBook {
  today: string;
  empty: boolean;
  kpis: DeskKpi[];
  works: DeskWork[];
}

const YEAR = 365;
const EIGHTEEN_MONTHS = 548;
const SIX_MONTHS = 183;

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function formatKr(n: number): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    const digits = m >= 10 ? 1 : 2;
    return `${sign}${new Intl.NumberFormat("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(m)} mill.`;
  }
  return `${sign}${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.round(abs))} kr`;
}

function formatKrPlain(n: number): string {
  return `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.round(n))} kr`;
}

export function longDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function wantedRooms(need: string | null): number | null {
  const m = /(\d)\s*-?\s*rom/i.exec(need ?? "");
  return m ? Number(m[1]) : null;
}

function inForce(stage: LeaseStage): boolean {
  return stage === "active" || stage === "move_out";
}

interface Signal {
  priority: number;
  lane: string;
  laneLabel: string;
  action: DeskRow["action"];
  actionLabel: string;
  letterKind: string | null;
  taskTitle: string | null;
  taskDue: string | null;
  money: number;
  moneyText: string;
  when: string;
  tall: DeskTall[];
  dueSoon: boolean;
  ageDays: number | null;
  why: string;
}

function placeOf(unit: UnitRow | null, lease: LeaseRow | null): string {
  if (!unit) return lease?.need?.trim() || "Ingen bolig ennå";
  return unit.address ? `${unit.name} · ${unit.address}` : unit.name;
}

function leaseSignals(l: LeaseRow, u: UnitRow | null, today: string): Signal[] {
  if (l.stage === "ended") return [];
  const out: Signal[] = [];
  const endIn = l.end_on ? daysBetween(today, l.end_on) : null;
  const breakIn = l.break_on ? daysBetween(today, l.break_on) : null;
  const indexIn = l.index_on ? daysBetween(today, l.index_on) : null;
  const keysIn = l.keys_on ? daysBetween(today, l.keys_on) : null;
  const moveIn = l.move_out_on ? daysBetween(today, l.move_out_on) : null;
  const rent = l.rent_year > 0 ? l.rent_year : (u?.market_rent_year ?? 0);
  const market = u?.market_rent_year ?? 0;
  const gap = u && inForce(l.stage) ? Math.max(0, market - l.rent_year) : 0;
  const wall =
    (l.kind === "naering" && endIn != null && endIn <= EIGHTEEN_MONTHS) ||
    (l.kind === "bolig" && endIn != null && endIn <= SIX_MONTHS);

  const push = (s: Signal) => out.push(s);

  if (l.stage === "move_out" || (moveIn != null && moveIn <= 21)) {
    const days = moveIn ?? endIn ?? 0;
    push({
      priority: days <= 7 ? 10 : 60,
      lane: "utflytting",
      laneLabel: "Utflytting",
      action: "task",
      actionLabel: "Utflyttingsbefaring",
      letterKind: null,
      taskTitle: `Utflyttingsbefaring · ${l.tenant_name}${u ? ` · ${u.name}` : ""}`,
      taskDue: l.move_out_on ?? l.end_on,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: days <= 0 ? "i dag" : days === 1 ? "i morgen" : `om ${days} dager`,
      tall: endIn != null && endIn <= YEAR ? ["utlop", "wault"] : ["wault"],
      dueSoon: days <= 7,
      ageDays: null,
      why: `${l.tenant_name} flytter ${days <= 0 ? "i dag" : days === 1 ? "i morgen" : longDate(l.move_out_on ?? l.end_on ?? today)}. Befaring, nøkler og oppgjør må være klart.`,
    });
  }

  if (l.stage === "vedtak" && !l.unit_id) {
    const age = l.vedtak_on ? daysBetween(l.vedtak_on, today) : null;
    push({
      priority: (age ?? 0) >= 30 ? 100 : 145,
      lane: "vedtak",
      laneLabel: "Vedtak",
      action: "offer",
      actionLabel: "Gi tilbud",
      letterKind: "tilbud",
      taskTitle: null,
      taskDue: null,
      money: 0,
      moneyText: "I kø",
      when: age == null ? "vedtak uten dato" : `ventet ${age} dager`,
      tall: ["ko"],
      dueSoon: (age ?? 0) >= 30,
      ageDays: age,
      why: `${l.tenant_name} har vedtak${age == null ? "" : ` for ${age} dager siden`} og har ikke fått bolig${l.need ? `. Behov: ${l.need}` : ""}.`,
    });
  }

  if (l.stage === "contract" && !l.signed_on) {
    const startIn = l.start_on ? daysBetween(today, l.start_on) : null;
    push({
      priority: 30,
      lane: "signering",
      laneLabel: "Signering",
      action: "letter",
      actionLabel: "Send til signering",
      letterKind: "signering",
      taskTitle: null,
      taskDue: null,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: startIn == null ? "ikke signert" : startIn <= 0 ? "oppstart i dag" : `oppstart om ${startIn} dager`,
      tall: [],
      dueSoon: true,
      ageDays: null,
      why: `Kontrakten med ${l.tenant_name} er ikke signert${l.start_on ? `. Avtalt oppstart ${longDate(l.start_on)}` : ""}.`,
    });
  }

  if (l.stage === "move_in") {
    const days = keysIn ?? (l.start_on ? daysBetween(today, l.start_on) : null);
    push({
      priority: days != null && days <= 7 ? 20 : 160,
      lane: "innflytting",
      laneLabel: "Innflytting",
      action: "task",
      actionLabel: "Innflyttingsbefaring",
      letterKind: null,
      taskTitle: `Innflyttingsbefaring · ${l.tenant_name}${u ? ` · ${u.name}` : ""}`,
      taskDue: l.keys_on ?? l.start_on,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: days == null ? "nøkkel ikke satt" : days <= 0 ? "nøkkel i dag" : days === 1 ? "nøkkel i morgen" : `nøkkel om ${days} dager`,
      tall: ["ko"],
      dueSoon: days != null && days <= 7,
      ageDays: null,
      why: `${l.tenant_name} venter på nøkkel${u ? ` til ${u.name}` : ""}${days == null ? "" : days <= 0 ? " i dag" : ` om ${days} dager`}.`,
    });
  }

  if (l.stage === "offer") {
    const stillEmpty = u?.status === "vacant" || u?.status === "make_ready";
    const age = stillEmpty && u?.vacant_since ? daysBetween(u.vacant_since, today) : l.listed_on ? daysBetween(l.listed_on, today) : null;
    push({
      priority: 150,
      lane: "tilbud",
      laneLabel: "Tilbud",
      action: "letter",
      actionLabel: "Følg opp tilbud",
      letterKind: "oppfolging",
      taskTitle: null,
      taskDue: null,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: stillEmpty ? (age == null ? "tilbud ute" : `ledig i ${age} dager`) : "tilbud ute",
      tall: stillEmpty ? ["ledig", "fart"] : ["fart"],
      dueSoon: (age ?? 0) > 45,
      ageDays: age,
      why: stillEmpty
        ? `Tilbudet til ${l.tenant_name} ligger ute${age == null ? "" : `, og lokalet har stått ledig i ${age} dager`}.`
        : `Tilbudet til ${l.tenant_name} ligger ute${u ? ` på ${u.name}` : ""}. Boligen er holdt av.`,
    });
  }

  if ((l.stage === "active" || l.stage === "move_out") && l.arrears_nok > 0 && l.arrears_days >= 30) {
    const hard = l.arrears_days >= 60;
    push({
      priority: l.arrears_days >= 90 ? 50 : hard ? 90 : 130,
      lane: "restanse",
      laneLabel: "Restanse",
      action: "letter",
      actionLabel: hard ? "Betalingsavtale" : "Send purring",
      letterKind: hard ? "avtale" : "purring",
      taskTitle: null,
      taskDue: null,
      money: l.arrears_nok,
      moneyText: formatKr(l.arrears_nok),
      when: `${l.arrears_days} dager`,
      tall: ["restanse"],
      dueSoon: l.arrears_days >= 90,
      ageDays: l.arrears_days,
      why: `${l.tenant_name} skylder ${formatKrPlain(l.arrears_nok)}. Restansen er ${l.arrears_days} dager gammel.`,
    });
  }

  if (l.stage === "active" && l.kind === "naering" && breakIn != null && breakIn <= 120 && breakIn >= -14) {
    push({
      priority: breakIn <= 14 ? 25 : breakIn <= 45 ? 60 : 180,
      lane: "opsjon",
      laneLabel: "Opsjon",
      action: "letter",
      actionLabel: "Avklar opsjon",
      letterKind: "opsjon",
      taskTitle: null,
      taskDue: null,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: breakIn <= 0 ? "frist i dag" : `frist om ${breakIn} dager`,
      tall: ["wault"],
      dueSoon: breakIn <= 45,
      ageDays: null,
      why: `${l.tenant_name} kan si opp eller bruke opsjon ${l.break_on ? longDate(l.break_on) : "snart"}. Leien er ${formatKrPlain(rent)} per år.`,
    });
  }

  if (l.stage === "active" && indexIn != null && indexIn <= 45 && indexIn >= -14) {
    push({
      priority: indexIn <= 14 ? 25 : indexIn <= 30 ? 70 : 170,
      lane: "regulering",
      laneLabel: "Regulering",
      action: "letter",
      actionLabel: "Skriv reguleringsvarsel",
      letterKind: "regulering",
      taskTitle: null,
      taskDue: null,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: indexIn <= 0 ? "kan virke nå" : `virkning om ${indexIn} dager`,
      tall: [],
      dueSoon: indexIn <= 30,
      ageDays: null,
      why: `Leien til ${l.tenant_name} kan reguleres ${l.index_on ? longDate(l.index_on) : "snart"}. Varsel må ut minst én måned før ny leie gjelder. Gjeldende leie er ${formatKrPlain(rent)} per år.`,
    });
  }

  if (l.stage === "active" && wall && endIn != null) {
    const soon = endIn <= 90;
    const bolig = l.kind === "bolig";
    push({
      priority: soon ? 80 : 140,
      lane: bolig ? "fornyelse" : "utlop",
      laneLabel: bolig ? "Fornyelse" : "Utløp",
      action: "letter",
      actionLabel: bolig ? "Vurder fornyelse" : "Start reforhandling",
      letterKind: "fornyelse",
      taskTitle: null,
      taskDue: null,
      money: rent,
      moneyText: `${formatKr(rent)} / år`,
      when: endIn <= 0 ? "utløpt" : `utløp om ${endIn} dager`,
      tall: [...(endIn <= YEAR ? (["utlop"] as DeskTall[]) : []), "wault"],
      dueSoon: soon,
      ageDays: null,
      why: bolig
        ? `Leieforholdet til ${l.tenant_name} utløper ${l.end_on ? longDate(l.end_on) : "snart"}. Vilkårene for boligen må vurderes på nytt.`
        : `${l.tenant_name} utløper ${l.end_on ? longDate(l.end_on) : "snart"}. Gjeldende leie er ${formatKrPlain(rent)} per år${market > rent ? `, markedet ${formatKrPlain(market)}` : ""}.`,
    });
  }

  if (gap >= 15_000 && market > 0 && gap / market >= 0.08 && l.stage === "active") {
    push({
      priority: 200,
      lane: "gap",
      laneLabel: "Under marked",
      action: "letter",
      actionLabel: "Vurder leien",
      letterKind: "leie",
      taskTitle: null,
      taskDue: null,
      money: gap,
      moneyText: `${formatKr(gap)} under`,
      when: "under marked",
      tall: ["gap"],
      dueSoon: false,
      ageDays: null,
      why: `${l.tenant_name} betaler ${formatKrPlain(l.rent_year)} per år. Markedsleie på objektet er ${formatKrPlain(market)}.`,
    });
  }

  return out;
}

function unitSignal(u: UnitRow, today: string): Signal | null {
  if (u.status !== "vacant" && u.status !== "make_ready") return null;
  const age = u.vacant_since ? daysBetween(u.vacant_since, today) : null;
  const ready = u.status === "vacant";
  const bolig = u.kind === "bolig";
  return {
    priority: ready ? (bolig ? 110 : 40) : bolig ? 120 : 45,
    lane: ready ? "ledig" : "klargjoring",
    laneLabel: ready ? "Ledig" : "Klargjøring",
    action: ready ? (bolig ? "match" : "letter") : "task",
    actionLabel: ready ? (bolig ? "Match mot kø" : "Skriv tilbud") : "Start klargjøring",
    letterKind: ready && !bolig ? "tilbud" : null,
    taskTitle: ready ? null : `Klargjør ${u.name} for utleie`,
    taskDue: today,
    money: u.market_rent_year,
    moneyText: `${formatKr(u.market_rent_year)} / år`,
    when: age == null ? (ready ? "ledig" : "ikke klar") : `ledig i ${age} dager`,
    tall: ["ledig", "fart"],
    dueSoon: (age ?? 0) > 60 || !ready,
    ageDays: age,
    why: ready
      ? bolig
        ? `${u.name} er klar og har stått ledig${age == null ? "" : ` i ${age} dager`}. Neste steg er å gi den til noen med vedtak.`
        : `${u.name} har stått ledig${age == null ? "" : ` i ${age} dager`}. Markedsleie er ${formatKrPlain(u.market_rent_year)} per år.`
      : `${u.name} er tom, men ikke klar for visning${age == null ? "" : `. Den ble ledig for ${age} dager siden`}.`,
  };
}

function finish(signal: Signal, lease: LeaseRow | null, unit: UnitRow | null, tall: DeskTall[]): DeskWork {
  const kind = unit?.kind ?? lease?.kind ?? "bolig";
  const title = lease?.tenant_name ?? (kind === "bolig" ? "Ledig bolig" : "Ledig lokale");
  return {
    id: `${signal.lane}.${lease?.id ?? unit?.id ?? "x"}`,
    kind,
    lane: signal.lane,
    laneLabel: signal.laneLabel,
    tall,
    title,
    place: placeOf(unit, lease),
    moneyText: signal.moneyText,
    when: signal.when,
    actionLabel: signal.actionLabel,
    action: signal.action,
    dueSoon: signal.dueSoon,
    why: signal.why,
    buildingId: unit?.building_id ?? null,
    priority: signal.priority,
    leaseId: lease?.id ?? null,
    unitId: unit?.id ?? null,
    letterKind: signal.letterKind,
    taskTitle: signal.taskTitle,
    taskDue: signal.taskDue,
    money: signal.money,
    ageDays: signal.ageDays,
  };
}

export function buildDesk(units: UnitRow[], leases: LeaseRow[], today: string): DeskBook {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const works: DeskWork[] = [];
  const covered = new Set<string>();

  for (const lease of leases) {
    const unit = lease.unit_id ? (unitById.get(lease.unit_id) ?? null) : null;
    const signals = leaseSignals(lease, unit, today);
    if (signals.length === 0) continue;
    signals.sort((a, b) => a.priority - b.priority);
    const best = signals[0]!;
    const tall = unique(signals.flatMap((s) => s.tall));
    if (gapOf(lease, unit) && !tall.includes("gap")) tall.push("gap");
    works.push(finish(best, lease, unit, tall));
    if (lease.unit_id) covered.add(lease.unit_id);
  }

  for (const unit of units) {
    if (covered.has(unit.id)) continue;
    const signal = unitSignal(unit, today);
    if (!signal) continue;
    works.push(finish(signal, null, unit, signal.tall));
  }

  works.sort((a, b) => a.priority - b.priority || b.money - a.money || (b.ageDays ?? 0) - (a.ageDays ?? 0));

  return { today, empty: units.length === 0 && leases.length === 0, kpis: kpis(units, leases, today), works };
}

function gapOf(lease: LeaseRow, unit: UnitRow | null): boolean {
  if (!unit || lease.stage !== "active") return false;
  const gap = unit.market_rent_year - lease.rent_year;
  return gap >= 15_000 && unit.market_rent_year > 0 && gap / unit.market_rent_year >= 0.08;
}

function kpis(units: UnitRow[], leases: LeaseRow[], today: string): DeskKpi[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const force = leases.filter((l) => inForce(l.stage));
  const emptyUnits = units.filter((u) => u.status === "vacant" || u.status === "make_ready");
  const vacantDays = emptyUnits.flatMap((u) => (u.vacant_since ? [daysBetween(u.vacant_since, today)] : []));
  const vacantMoney = emptyUnits.reduce((s, u) => s + u.market_rent_year, 0);
  const vacantAvg = avg(vacantDays);

  const passing = force.filter((l) => l.rent_year > 0);
  const passSum = passing.reduce((s, l) => s + l.rent_year, 0);
  const expiring = passing.filter((l) => l.end_on != null && daysBetween(today, l.end_on!) <= YEAR);
  const expSum = expiring.reduce((s, l) => s + l.rent_year, 0);

  let wNum = 0;
  let wDen = 0;
  for (const l of passing) {
    if (!l.end_on) continue;
    const years = Math.max(0, daysBetween(today, l.end_on)) / 365.25;
    wNum += years * l.rent_year;
    wDen += l.rent_year;
  }

  let gap = 0;
  for (const l of force) {
    const u = l.unit_id ? byId.get(l.unit_id) : undefined;
    if (!u) continue;
    gap += Math.max(0, u.market_rent_year - l.rent_year);
  }

  const buckets = { 30: 0, 60: 0, 90: 0 };
  for (const l of leases) {
    if (l.arrears_nok <= 0 || l.arrears_days < 30) continue;
    if (l.arrears_days >= 90) buckets[90] += l.arrears_nok;
    else if (l.arrears_days >= 60) buckets[60] += l.arrears_nok;
    else buckets[30] += l.arrears_nok;
  }
  const arrears = buckets[30] + buckets[60] + buckets[90];

  const speeds = leases.flatMap((l) => {
    if (!l.signed_on || !l.listed_on) return [];
    const ago = daysBetween(l.signed_on, today);
    if (ago < 0 || ago > YEAR) return [];
    const days = daysBetween(l.listed_on, l.signed_on);
    return days >= 0 ? [days] : [];
  });
  const speed = avg(speeds);

  const waiting = leases.filter((l) => l.stage === "vedtak" && !l.unit_id);
  const ages = waiting.flatMap((l) => (l.vedtak_on ? [daysBetween(l.vedtak_on, today)] : []));
  const age = avg(ages);
  const keyDays = leases.flatMap((l) => (l.stage === "move_in" && l.keys_on ? [daysBetween(today, l.keys_on)] : []));
  const nearestKey = keyDays.length ? Math.min(...keyDays) : null;

  const pct = passSum > 0 ? (expSum / passSum) * 100 : null;
  const compact = (n: number) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(Math.round(n));

  const koHint = [
    age != null ? `snitt ${Math.round(age)} dager i kø` : waiting.length === 0 ? "ingen venter på bolig" : "vedtak uten dato",
    nearestKey == null ? null : nearestKey <= 0 ? "nøkkel i dag" : `nøkkel om ${nearestKey} dager`,
  ]
    .filter(Boolean)
    .join(" · ");

  return [
    {
      id: "ledig",
      label: "Ledig",
      value: formatKr(vacantMoney),
      hint: vacantAvg == null ? "ingen ledig" : `snitt ${Math.round(vacantAvg)} ledigdøgn`,
    },
    {
      id: "utlop",
      label: "Utløp 12 mnd",
      value: pct == null ? "–" : `${new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(pct)} %`,
      hint: `${formatKr(expSum)} av leien`,
      tone: pct != null && pct >= 25 ? "warn" : undefined,
    },
    {
      id: "wault",
      label: "WAULT",
      value: wDen === 0 ? "–" : `${new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(wNum / wDen)} år`,
      hint: "til utløp, vektet på leie",
    },
    {
      id: "gap",
      label: "Mot marked",
      value: formatKr(gap),
      hint: "gjeldende leie under marked",
    },
    {
      id: "restanse",
      label: "Restanse",
      value: formatKr(arrears),
      hint: `30: ${compact(buckets[30])} · 60: ${compact(buckets[60])} · 90: ${compact(buckets[90])}`,
      tone: buckets[90] > 0 ? "bad" : arrears > 0 ? "warn" : undefined,
    },
    {
      id: "fart",
      label: "Til signert",
      value: speed == null ? "–" : `${Math.round(speed)} d`,
      hint: speed == null ? "ingen signert siste år" : "fra ledig til signert, siste år",
    },
    {
      id: "ko",
      label: "Kø",
      value: String(waiting.length),
      hint: koHint,
      tone: (age ?? 0) >= 30 ? "warn" : undefined,
    },
  ];
}

export function factsFor(work: DeskWork, unit: UnitRow | null, lease: LeaseRow | null): DeskFact[] {
  const facts: DeskFact[] = [
    ["Sak", work.kind === "bolig" ? "Bolig" : "Næring"],
    ["Neste", work.actionLabel],
  ].map(([label, value]) => ({ label: label!, value: value! }));
  if (lease) facts.push({ label: "Hvem", value: lease.tenant_name });
  if (lease?.household) facts.push({ label: "Husstand", value: lease.household });
  if (lease?.need) facts.push({ label: "Behov", value: lease.need });
  if (unit) {
    const area = [unit.area_sqm ? `${new Intl.NumberFormat("nb-NO").format(unit.area_sqm)} m²` : null, unit.rooms ? `${unit.rooms} rom` : null]
      .filter(Boolean)
      .join(", ");
    facts.push({ label: "Objekt", value: unit.address ? `${unit.name}, ${unit.address}` : unit.name });
    if (area) facts.push({ label: "Areal", value: area });
    if (unit.market_rent_year > 0) facts.push({ label: "Markedsleie", value: `${formatKrPlain(unit.market_rent_year)} per år` });
  }
  if (lease && lease.rent_year > 0) facts.push({ label: "Leie", value: `${formatKrPlain(lease.rent_year)} per år` });
  if (lease?.start_on) facts.push({ label: "Fra", value: longDate(lease.start_on) });
  if (lease?.end_on) facts.push({ label: "Til", value: longDate(lease.end_on) });
  else if (lease && (lease.stage === "active" || lease.stage === "move_in")) facts.push({ label: "Til", value: "Tidsubestemt" });
  if (lease?.break_on) facts.push({ label: "Opsjon", value: longDate(lease.break_on) });
  if (lease?.index_on) facts.push({ label: "Regulering", value: longDate(lease.index_on) });
  if (lease && lease.arrears_nok > 0) facts.push({ label: "Restanse", value: `${formatKrPlain(lease.arrears_nok)}, ${lease.arrears_days} dager` });
  if (lease?.vedtak_on) facts.push({ label: "Vedtak", value: longDate(lease.vedtak_on) });
  if (lease?.keys_on) facts.push({ label: "Nøkkel", value: longDate(lease.keys_on) });
  if (unit?.vacant_since) facts.push({ label: "Ledig fra", value: longDate(unit.vacant_since) });
  return facts;
}

export function offersFor(work: DeskWork, units: UnitRow[], lease: LeaseRow | null): DeskOffer[] {
  if (work.action !== "offer") return [];
  const want = wantedRooms(lease?.need ?? null);
  return units
    .filter((u) => u.kind === "bolig" && u.status === "vacant")
    .map((u) => ({
      unitId: u.id,
      name: u.name,
      place: u.address ?? "",
      rentText: `${formatKr(u.market_rent_year)} / år`,
      fit: want != null && u.rooms === want,
    }))
    .sort((a, b) => Number(b.fit) - Number(a.fit) || a.name.localeCompare(b.name, "nb"));
}

export function matchesFor(work: DeskWork, unit: UnitRow | null, leases: LeaseRow[], today: string): DeskMatch[] {
  if (work.action !== "match" || !unit) return [];
  return leases
    .filter((l) => l.stage === "vedtak" && !l.unit_id)
    .map((l) => {
      const age = l.vedtak_on ? daysBetween(l.vedtak_on, today) : null;
      const want = wantedRooms(l.need);
      return {
        leaseId: l.id,
        name: l.tenant_name,
        need: l.need,
        waited: age == null ? "vedtak uten dato" : `${age} dager`,
        fit: want != null && unit.rooms === want,
        age: age ?? 0,
      };
    })
    .sort((a, b) => Number(b.fit) - Number(a.fit) || b.age - a.age)
    .map(({ age: _age, ...m }) => m);
}

export interface LetterDraft {
  kind: string;
  title: string;
  body: string;
}

export function letterFor(work: DeskWork, unit: UnitRow | null, lease: LeaseRow | null, orgName: string, today: string): LetterDraft {
  const kind = work.letterKind ?? "tilbud";
  const who = lease?.tenant_name ?? "leietaker";
  const where = unit ? (unit.address ? `${unit.name}, ${unit.address}` : unit.name) : "boligen";
  const rent = lease && lease.rent_year > 0 ? lease.rent_year : (unit?.market_rent_year ?? 0);
  const market = unit?.market_rent_year ?? 0;
  const area = unit?.area_sqm ? `${new Intl.NumberFormat("nb-NO").format(unit.area_sqm)} m²` : null;
  const rooms = unit?.rooms ? `${unit.rooms} rom` : null;
  const size = [area, rooms].filter(Boolean).join(", ");
  const sign = `Vennlig hilsen\n${orgName}`;

  if (kind === "purring" || kind === "avtale") {
    const hard = kind === "avtale";
    return {
      kind,
      title: hard ? `Betalingsavtale – ${who}` : `Purring – ${who}`,
      body: `${who}

Vi kan ikke se at husleien for ${where} er betalt.

Restanse: ${formatKrPlain(lease?.arrears_nok ?? 0)}
Dager: ${lease?.arrears_days ?? 0}

${hard ? "Ta kontakt innen 14 dager, så lager vi en betalingsavtale. Uten svar går saken videre til inkasso." : "Betal innen 14 dager, eller ta kontakt hvis noe ikke stemmer."}

${sign}`,
    };
  }

  if (kind === "regulering") {
    return {
      kind,
      title: `Reguleringsvarsel – ${who}`,
      body: `${who}

Leien for ${where} kan reguleres ${lease?.index_on ? longDate(lease.index_on) : "ved neste reguleringstidspunkt"}.

Gjeldende leie: ${formatKrPlain(rent)} per år

Varsel sendes minst én måned før ny leie gjelder. Beløpet settes når indeksen for perioden er kjent. Leien endres ikke av dette brevet.

${sign}`,
    };
  }

  if (kind === "opsjon") {
    return {
      kind,
      title: `Opsjon – ${who}`,
      body: `${who}

Vi må avklare om leien av ${where} fortsetter.

Frist: ${lease?.break_on ? longDate(lease.break_on) : "se kontrakten"}
Gjeldende leie: ${formatKrPlain(rent)} per år
${market > 0 ? `Markedsleie på objektet: ${formatKrPlain(market)} per år\n` : ""}
Svar oss før fristen om dere bruker opsjonen eller flytter.

${sign}`,
    };
  }

  if (kind === "fornyelse") {
    const bolig = work.kind === "bolig";
    return {
      kind,
      title: bolig ? `Fornyelse – ${who}` : `Reforhandling – ${who}`,
      body: bolig
        ? `${who}

Leieforholdet i ${where} utløper ${lease?.end_on ? longDate(lease.end_on) : "snart"}.

Gjeldende husleie: ${formatKrPlain(rent)} per år

Ta kontakt hvis du fortsatt trenger boligen. Vi vurderer fornyelse etter vilkårene som gjaldt da boligen ble tildelt.

${sign}`
        : `${who}

Leien av ${where} utløper ${lease?.end_on ? longDate(lease.end_on) : "snart"}. Vi vil gjerne reforhandle før lokalet legges ut.

Gjeldende leie: ${formatKrPlain(rent)} per år
${market > 0 ? `Markedsleie: ${formatKrPlain(market)} per år\n` : ""}
Kan vi ta et møte de neste to ukene?

${sign}`,
    };
  }

  if (kind === "signering") {
    return {
      kind,
      title: `Kontrakt til signering – ${who}`,
      body: `${who}

Kontrakten for ${where} er klar til signering.

Leie: ${formatKrPlain(rent)} per år
${lease?.start_on ? `Oppstart: ${longDate(lease.start_on)}\n` : ""}${size ? `Areal: ${size}\n` : ""}
Signer før oppstart, så vi rekker nøkkel og innflytting.

${sign}`,
    };
  }

  if (kind === "oppfolging") {
    return {
      kind,
      title: `Oppfølging av tilbud – ${who}`,
      body: `${who}

Vi viser til tilbudet om ${where}.

Leie: ${formatKrPlain(rent)} per år
${size ? `Areal: ${size}\n` : ""}${unit?.vacant_since ? `Ledig fra: ${longDate(unit.vacant_since)}\n` : ""}
Gi oss et svar innen ${work.kind === "bolig" ? "7" : "14"} dager, så vi vet om vi skal holde lokalet av eller gå videre med andre.

${sign}`,
    };
  }

  if (kind === "leie") {
    return {
      kind,
      title: `Leienivå – ${who}`,
      body: `${who}

Vi har gått gjennom leien for ${where}.

Gjeldende leie: ${formatKrPlain(lease?.rent_year ?? rent)} per år
${market > 0 ? `Markedsleie: ${formatKrPlain(market)} per år\n` : ""}
Dette brevet endrer ikke leien. Ta kontakt om dere vil gjennomgå vilkårene.

${sign}`,
    };
  }

  const start = lease?.start_on ?? unit?.vacant_since ?? today;
  return {
    kind: "tilbud",
    title: `Tilbud – ${where}`,
    body: `${who}

Vi tilbyr leie av ${where}.

${size ? `Areal: ${size}\n` : ""}Leie: ${formatKrPlain(rent)} per år
Ledig fra: ${longDate(start)}

${work.kind === "bolig" ? "Dette er ett tilbud. Svar innen 7 dager." : "Svar innen 14 dager om dere vil gå videre."}

${sign}`,
  };
}
