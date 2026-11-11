import type { Env } from "../env";
import { insert } from "./db";
import { newId, now, todayIso } from "./util";

export interface DeskLinks {
  kontorId?: string | null;
  lagerId?: string | null;
  boligId?: string | null;
}

/** Fiktiv portefølje: næring på Sagbruket og bolig på Elvebakken, med saker i begge løp. */
export async function seedDesk(env: Env, orgId: string, links: DeskLinks = {}): Promise<{ created: boolean }> {
  const existing = await env.DB.prepare(`SELECT id FROM lease_units WHERE org_id = ? LIMIT 1`).bind(orgId).first();
  if (existing) return { created: false };

  const t = now();
  const today = todayIso();
  const day = (n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const stmts: D1PreparedStatement[] = [];
  const base = { org_id: orgId, created_at: t, updated_at: t };
  const kontor = "Sagbruksveien 4";
  const boligAdr = "Elvebakken 10";

  const unit = (row: Record<string, unknown>) => {
    const id = newId("unt");
    stmts.push(insert(env.DB, "lease_units", { ...base, id, ...row }));
    return id;
  };
  const lease = (row: Record<string, unknown>) => {
    stmts.push(insert(env.DB, "leases", { ...base, id: newId("lse"), arrears_nok: 0, arrears_days: 0, ...row }));
  };

  const nord = unit({ building_id: links.kontorId ?? null, name: "2. etasje nord", address: kontor, kind: "naering", area_sqm: 410, status: "occupied", market_rent_year: 2_460_000 });
  const tredje = unit({ building_id: links.kontorId ?? null, name: "3. etasje", address: kontor, kind: "naering", area_sqm: 380, status: "occupied", market_rent_year: 2_470_000 });
  const butikk = unit({ building_id: links.kontorId ?? null, name: "Butikk 1. etasje", address: kontor, kind: "naering", area_sqm: 95, status: "occupied", market_rent_year: 640_000 });
  const sor = unit({ building_id: links.kontorId ?? null, name: "2. etasje sør", address: kontor, kind: "naering", area_sqm: 210, status: "vacant", market_rent_year: 1_050_000, vacant_since: day(-40) });
  const vest = unit({ building_id: links.kontorId ?? null, name: "Kontorfløy vest", address: kontor, kind: "naering", area_sqm: 160, status: "occupied", market_rent_year: 960_000 });
  const hjorne = unit({ building_id: links.kontorId ?? null, name: "Hjørnelokalet", address: kontor, kind: "naering", area_sqm: 80, status: "occupied", market_rent_year: 480_000 });
  const moterom = unit({ building_id: links.kontorId ?? null, name: "Møteromfløyen", address: kontor, kind: "naering", area_sqm: 120, status: "occupied", market_rent_year: 720_000 });
  const arkiv = unit({ building_id: links.kontorId ?? null, name: "Arkiv kjeller", address: kontor, kind: "naering", area_sqm: 70, status: "reserved", market_rent_year: 420_000 });
  const helse = unit({ building_id: links.kontorId ?? null, name: "1. etasje helse", address: kontor, kind: "naering", area_sqm: 90, status: "occupied", market_rent_year: 540_000 });
  const hallA = unit({ building_id: links.lagerId ?? null, name: "Hall A", address: kontor, kind: "naering", area_sqm: 900, status: "occupied", market_rent_year: 1_350_000 });
  unit({ building_id: links.lagerId ?? null, name: "Hall B", address: kontor, kind: "naering", area_sqm: 700, status: "make_ready", market_rent_year: 980_000, vacant_since: day(-12) });

  lease({ unit_id: nord, kind: "naering", tenant_name: "Kontorpartner AS", stage: "active", rent_year: 2_255_000, start_on: day(-1700), end_on: day(430), signed_on: day(-1700), listed_on: day(-1760), index_on: day(200) });
  lease({ unit_id: tredje, kind: "naering", tenant_name: "Regnskapshuset Øst AS", stage: "active", rent_year: 2_090_000, start_on: day(-900), end_on: day(300), signed_on: day(-900), listed_on: day(-960), index_on: day(160) });
  lease({ unit_id: butikk, kind: "naering", tenant_name: "Atelier Søm AS", stage: "active", rent_year: 620_000, start_on: day(-400), end_on: day(1100), signed_on: day(-400), listed_on: day(-430), index_on: day(80), arrears_nok: 86_000, arrears_days: 47 });
  lease({ unit_id: sor, kind: "naering", tenant_name: "Nordlys Regnskap AS", stage: "offer", rent_year: 1_020_000, listed_on: day(-40) });
  lease({ unit_id: vest, kind: "naering", tenant_name: "Advokatfellesskapet Borg", stage: "active", rent_year: 940_000, start_on: day(-500), end_on: day(2200), signed_on: day(-500), listed_on: day(-530), index_on: day(12) });
  lease({ unit_id: hjorne, kind: "naering", tenant_name: "Pop-up Studio AS", stage: "move_out", rent_year: 456_000, start_on: day(-400), end_on: day(1), move_out_on: day(1), signed_on: day(-400), listed_on: day(-420) });
  lease({ unit_id: moterom, kind: "naering", tenant_name: "Studio Nord AS", stage: "active", rent_year: 708_000, start_on: day(-80), end_on: day(1500), signed_on: day(-80), listed_on: day(-102), index_on: day(240) });
  lease({ unit_id: arkiv, kind: "naering", tenant_name: "Byrået Linje AS", stage: "contract", rent_year: 408_000, start_on: day(21), listed_on: day(-15) });
  lease({ unit_id: helse, kind: "naering", tenant_name: "Helsepartnere AS", stage: "active", rent_year: 528_000, start_on: day(-200), end_on: day(1600), signed_on: day(-200), listed_on: day(-244) });
  lease({ unit_id: hallA, kind: "naering", tenant_name: "Fjordfrakt AS", stage: "active", rent_year: 1_260_000, start_on: day(-600), end_on: day(1800), break_on: day(40), signed_on: day(-600), listed_on: day(-640) });

  const h0301 = unit({ building_id: links.boligId ?? null, name: "H0301", address: boligAdr, kind: "bolig", area_sqm: 68, rooms: 3, status: "occupied", market_rent_year: 156_000 });
  unit({ building_id: links.boligId ?? null, name: "H0204", address: boligAdr, kind: "bolig", area_sqm: 52, rooms: 2, status: "vacant", market_rent_year: 126_000, vacant_since: day(-19) });
  const h0402 = unit({ building_id: links.boligId ?? null, name: "H0402", address: boligAdr, kind: "bolig", area_sqm: 58, rooms: 3, status: "occupied", market_rent_year: 138_000 });
  const h0102 = unit({ building_id: links.boligId ?? null, name: "H0102", address: boligAdr, kind: "bolig", area_sqm: 71, rooms: 3, status: "reserved", market_rent_year: 148_000 });
  unit({ building_id: links.boligId ?? null, name: "H0101", address: boligAdr, kind: "bolig", area_sqm: 48, rooms: 2, status: "make_ready", market_rent_year: 108_000, vacant_since: day(-6) });
  const h0302 = unit({ building_id: links.boligId ?? null, name: "H0302", address: boligAdr, kind: "bolig", area_sqm: 64, rooms: 3, status: "occupied", market_rent_year: 144_000 });
  const h0201 = unit({ building_id: links.boligId ?? null, name: "H0201", address: boligAdr, kind: "bolig", area_sqm: 50, rooms: 2, status: "occupied", market_rent_year: 126_000 });
  const h0401 = unit({ building_id: links.boligId ?? null, name: "H0401", address: boligAdr, kind: "bolig", area_sqm: 55, rooms: 2, status: "occupied", market_rent_year: 130_000 });

  lease({ unit_id: h0301, kind: "bolig", tenant_name: "Kari Nilsen", stage: "active", rent_year: 132_000, start_on: day(-800), signed_on: day(-800), listed_on: day(-820), index_on: day(18), household: "1 voksen" });
  lease({ unit_id: h0402, kind: "bolig", tenant_name: "Ahmed Hassan", stage: "active", rent_year: 118_800, start_on: day(-500), signed_on: day(-500), listed_on: day(-540), arrears_nok: 18_400, arrears_days: 68, household: "2 voksne, 1 barn" });
  lease({ unit_id: h0102, kind: "bolig", tenant_name: "Lene Berg", stage: "move_in", rent_year: 141_600, start_on: day(3), keys_on: day(3), signed_on: day(-6), listed_on: day(-40), household: "1 voksen, 1 barn" });
  lease({ unit_id: h0302, kind: "bolig", tenant_name: "Marte Solberg", stage: "active", rent_year: 124_800, start_on: day(-700), end_on: day(120), signed_on: day(-700), listed_on: day(-730), household: "1 voksen, 1 barn" });
  lease({ unit_id: h0201, kind: "bolig", tenant_name: "Jonas Viken", stage: "active", rent_year: 120_000, start_on: day(-120), signed_on: day(-120), listed_on: day(-171), household: "1 voksen" });
  lease({ unit_id: h0401, kind: "bolig", tenant_name: "Per Olsen", stage: "active", rent_year: 114_000, start_on: day(-900), signed_on: day(-900), listed_on: day(-940), arrears_nok: 24_600, arrears_days: 102, household: "1 voksen" });
  lease({ kind: "bolig", tenant_name: "Ola Pedersen", stage: "vedtak", vedtak_on: day(-26), need: "Tilgjengelig 2-rom", household: "1 voksen" });
  lease({ kind: "bolig", tenant_name: "Mariam Reza", stage: "vedtak", vedtak_on: day(-9), need: "4 rom", household: "2 voksne, 2 barn" });
  lease({ kind: "bolig", tenant_name: "Eva Holm", stage: "vedtak", vedtak_on: day(-41), need: "2 rom", household: "1 voksen, 1 barn" });

  await env.DB.batch(stmts);
  return { created: true };
}
