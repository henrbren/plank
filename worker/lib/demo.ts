import type { Env } from "../env";
import { insert } from "./db";
import { indexDocumentText } from "./documents";
import { addMonths, newId, now, todayIso } from "./util";

/**
 * Demodata: to fiktive eiendommer med bygg, etasjer, rom, komponenter, dokumenter,
 * oppgaver og en levende artifact. Produsentnavn er oppdiktet.
 */
export async function seedDemo(env: Env, orgId: string, userId: string): Promise<{ property_id: string }> {
  const t = now();
  const today = todayIso();
  const stmts: D1PreparedStatement[] = [];
  const base = { org_id: orgId, created_at: t, updated_at: t };

  // ── Eiendom 1: Sagbruket kontorpark ──
  const p1 = newId("prp");
  stmts.push(
    insert(env.DB, "properties", {
      ...base,
      id: p1,
      name: "Sagbruket kontorpark (demo)",
      address: "Sagbruksveien 4",
      postal_code: "0473",
      city: "Oslo",
      municipality: "Oslo",
      gnr: "220",
      bnr: "45",
      description: "Næringseiendom med kontorbygg og lagerhall. Demodata i Plank.",
    }),
  );
  const bA = newId("bld");
  const bB = newId("bld");
  stmts.push(
    insert(env.DB, "buildings", {
      ...base,
      id: bA,
      property_id: p1,
      name: "Hovedbygg",
      building_number: "300112233",
      building_type: "Kontor",
      year_built: 2019,
      gross_area: 4200,
      description: "Kontorbygg i 3 etasjer + kjeller med teknisk rom.",
    }),
    insert(env.DB, "buildings", {
      ...base,
      id: bB,
      property_id: p1,
      name: "Lagerhall",
      building_number: "300112234",
      building_type: "Lager",
      year_built: 1998,
      gross_area: 1800,
    }),
  );

  const floorsA = [
    { id: newId("flr"), name: "Kjeller (U1)", level: -1 },
    { id: newId("flr"), name: "1. etasje", level: 0 },
    { id: newId("flr"), name: "2. etasje", level: 1 },
    { id: newId("flr"), name: "3. etasje", level: 2 },
  ];
  for (const f of floorsA) stmts.push(insert(env.DB, "floors", { ...base, id: f.id, building_id: bA, name: f.name, level: f.level, gross_area: 1050 }));
  const fB = newId("flr");
  stmts.push(insert(env.DB, "floors", { ...base, id: fB, building_id: bB, name: "1. etasje", level: 0, gross_area: 1800 }));

  const room = (floorIdx: number, number: string, name: string, usage: string, area: number) => {
    const id = newId("rom");
    stmts.push(insert(env.DB, "rooms", { ...base, id, building_id: bA, floor_id: floorsA[floorIdx]!.id, name, number, usage, area }));
    return id;
  };
  const rTekVent = room(0, "U-010", "Teknisk rom ventilasjon", "Teknisk rom", 64);
  const rTekEl = room(0, "U-012", "Hovedtavlerom", "Teknisk rom", 18);
  room(0, "U-020", "Sykkelparkering", "Parkering", 120);
  const rResepsjon = room(1, "1-001", "Resepsjon", "Fellesareal", 85);
  room(1, "1-010", "Kantine", "Kantine", 220);
  const rHeis = room(1, "1-005", "Heissjakt", "Kommunikasjon", 6);
  room(2, "2-001", "Kontorlandskap nord", "Kontor", 410);
  const rPantry2 = room(2, "2-014", "Pantry", "Pantry", 22);
  room(2, "2-020", "Møterom Furu", "Møterom", 28);
  room(3, "3-001", "Kontorlandskap sør", "Kontor", 430);
  room(3, "3-012", "Møterom Gran", "Møterom", 32);
  const rBTek = newId("rom");
  stmts.push(insert(env.DB, "rooms", { ...base, id: rBTek, building_id: bB, floor_id: fB, name: "Fyrrom", number: "L-002", usage: "Teknisk rom", area: 24 }));

  // ── Komponenter ──
  const comp = (c: Record<string, unknown>) => {
    const id = newId("cmp");
    const last = c.last_service_at as string | undefined;
    const interval = c.service_interval_months as number | undefined;
    stmts.push(
      insert(env.DB, "components", {
        ...base,
        id,
        next_service_at: last && interval ? addMonths(last, interval) : null,
        ...c,
      }),
    );
    return id;
  };
  const shift = (days: number) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const cVent = comp({
    building_id: bA,
    floor_id: floorsA[0]!.id,
    room_id: rTekVent,
    name: "Ventilasjonsaggregat VA01",
    ns3451: "36",
    tfm: "=360.001",
    category: "Ventilasjon",
    manufacturer: "Nordluft",
    model: "NL-4000 Roterende",
    serial_number: "NL4-19-88213",
    supplier: "Byggteknikk Øst AS",
    installed_at: "2019-05-02",
    warranty_until: "2024-05-02",
    service_interval_months: 6,
    last_service_at: shift(-200),
    condition: "TG1",
    notes: "Betjener 1.–3. etasje. Serviceintervall 6 mnd iht. drifts- og vedlikeholdsinstruks.",
  });
  const cBrann = comp({
    building_id: bA,
    floor_id: floorsA[1]!.id,
    room_id: rResepsjon,
    name: "Brannalarmsentral",
    ns3451: "54",
    tfm: "=542.001",
    category: "Brannalarm",
    manufacturer: "Vaktsikker",
    model: "VS-8 Adresserbar",
    installed_at: "2019-04-15",
    service_interval_months: 12,
    last_service_at: shift(-330),
    condition: "TG0",
    notes: "Årlig kontroll av sertifisert foretak (NS 3960). Månedlig egenkontroll.",
  });
  const cHeis = comp({
    building_id: bA,
    floor_id: floorsA[1]!.id,
    room_id: rHeis,
    name: "Personheis H1",
    ns3451: "62",
    tfm: "=621.001",
    category: "Heis",
    manufacturer: "Liftverk",
    model: "LV-630 MRL",
    installed_at: "2019-06-01",
    service_interval_months: 1,
    last_service_at: shift(-12),
    condition: "TG0",
  });
  comp({
    building_id: bA,
    floor_id: floorsA[0]!.id,
    room_id: rTekEl,
    name: "Hovedfordeling (hovedtavle)",
    ns3451: "43",
    tfm: "=433.001",
    category: "Elkraft",
    manufacturer: "Tavlebygg Nord",
    installed_at: "2019-03-20",
    service_interval_months: 12,
    last_service_at: shift(-100),
    condition: "TG1",
  });
  comp({
    building_id: bA,
    floor_id: floorsA[0]!.id,
    room_id: rTekVent,
    name: "Væske-vann varmepumpe VP01",
    ns3451: "32",
    tfm: "=320.001",
    category: "Varme",
    manufacturer: "Varmepro",
    model: "VP-120",
    installed_at: "2019-05-10",
    service_interval_months: 12,
    last_service_at: shift(-350),
    condition: "TG1",
  });
  comp({
    building_id: bA,
    floor_id: floorsA[0]!.id,
    room_id: rTekVent,
    name: "Sprinklersentral",
    ns3451: "33",
    tfm: "=332.001",
    category: "Brannslokking",
    manufacturer: "Aquaguard",
    installed_at: "2019-04-01",
    service_interval_months: 12,
    last_service_at: shift(-40),
    condition: "TG0",
  });
  comp({
    building_id: bB,
    floor_id: fB,
    room_id: rBTek,
    name: "Oljekjel (utfaset)",
    ns3451: "32",
    category: "Varme",
    manufacturer: "Ukjent",
    installed_at: "1998-09-01",
    condition: "TG3",
    notes: "Ute av drift. Bør fjernes – se tilstandsanalyse.",
  });

  // ── Eiendom 2: Elvebakken borettslag ──
  const p2 = newId("prp");
  stmts.push(
    insert(env.DB, "properties", {
      ...base,
      id: p2,
      name: "Elvebakken borettslag (demo)",
      address: "Elvebakken 10",
      postal_code: "1960",
      city: "Løken",
      municipality: "Indre Østfold",
      gnr: "88",
      bnr: "12",
    }),
  );
  const bC = newId("bld");
  stmts.push(insert(env.DB, "buildings", { ...base, id: bC, property_id: p2, name: "Blokk 1", building_type: "Bolig", year_built: 1985, gross_area: 2600 }));
  for (const [i, n] of ["Kjeller", "1. etasje", "2. etasje", "3. etasje"].entries()) {
    stmts.push(insert(env.DB, "floors", { ...base, id: newId("flr"), building_id: bC, name: n, level: i - 1 }));
  }

  // ── Oppgaver ──
  const task = (r: Record<string, unknown>) =>
    stmts.push(insert(env.DB, "tasks", { ...base, id: newId("tsk"), property_id: p1, created_by_user: userId, ...r }));
  task({
    building_id: bA,
    floor_id: floorsA[0]!.id,
    room_id: rTekVent,
    component_id: cVent,
    title: "Halvårlig service ventilasjonsaggregat VA01",
    description: "Filterbytte, kontroll av reimer og rotor, rengjøring av varmegjenvinner. Se drifts- og vedlikeholdsinstruks.",
    type: "vedlikehold",
    priority: "high",
    due_date: shift(-14),
  });
  task({
    building_id: bA,
    component_id: cBrann,
    title: "Årlig kontroll brannalarmanlegg",
    description: "Bestill årlig kontroll fra sertifisert foretak (NS 3960). Kontrollrapport lastes opp i Plank.",
    type: "kontroll",
    priority: "high",
    due_date: shift(30),
  });
  task({
    building_id: bA,
    floor_id: floorsA[2]!.id,
    room_id: rPantry2,
    title: "Lekkasje under oppvaskkum i pantry 2. etg",
    description: "Vann i skap under kum. Lekkasjen ser ut til å komme fra vannlåsen. Håndkle lagt ut som strakstiltak.",
    type: "avvik",
    priority: "normal",
    due_date: shift(3),
  });
  task({
    building_id: bA,
    component_id: cVent,
    title: "Mangler innreguleringsprotokoll for VA01",
    description: "Innreguleringsprotokoll for ventilasjonsanlegget er ikke mottatt fra entreprenør.",
    type: "dokumentasjon",
    priority: "normal",
  });
  task({
    building_id: bA,
    component_id: cHeis,
    title: "Månedlig service personheis H1",
    type: "vedlikehold",
    priority: "normal",
    status: "done",
    due_date: shift(-12),
    completed_at: t,
  });

  await env.DB.batch(stmts);

  // ── Dokumenter (tekst lagres i R2 og indekseres) ──
  const docs: { title: string; filename: string; kind: string; ns3451: string; building_id: string; component_id?: string; summary: string; text: string }[] = [
    {
      title: "Nordluft NL-4000 – drifts- og vedlikeholdsinstruks",
      filename: "nordluft-nl4000-fdv.md",
      kind: "brukermanual",
      ns3451: "36",
      building_id: bA,
      component_id: cVent,
      summary: "Instruks for drift og vedlikehold av ventilasjonsaggregat VA01, med serviceintervaller og sjekkpunkter.",
      text: DOC_VENT,
    },
    {
      title: "Brannalarmanlegg Hovedbygg – FDV-dokumentasjon",
      filename: "brannalarm-hovedbygg-fdv.md",
      kind: "fdv",
      ns3451: "54",
      building_id: bA,
      component_id: cBrann,
      summary: "Beskrivelse av brannalarmanlegget, soneinndeling, egenkontroll og krav til årlig kontroll.",
      text: DOC_BRANN,
    },
    {
      title: "Tilstandsanalyse Sagbruket kontorpark 2025 (NS 3424)",
      filename: "tilstandsanalyse-2025.md",
      kind: "rapport",
      ns3451: "2",
      building_id: bA,
      summary: "Tilstandsanalyse på nivå 1 for hovedbygg og lagerhall med tilstandsgrader og anbefalte tiltak.",
      text: DOC_TILSTAND,
    },
    {
      title: "Liftverk LV-630 – serviceavtale og periodisk kontroll",
      filename: "heis-serviceavtale.md",
      kind: "avtale",
      ns3451: "62",
      building_id: bA,
      component_id: cHeis,
      summary: "Serviceavtale for personheis H1 med månedlig service og årlig periodisk kontroll.",
      text: DOC_HEIS,
    },
  ];
  for (const d of docs) {
    const id = newId("doc");
    const key = `orgs/${orgId}/documents/${id}/${d.filename}`;
    const bytes = new TextEncoder().encode(d.text);
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    await insert(env.DB, "documents", {
      ...base,
      id,
      property_id: p1,
      building_id: d.building_id,
      component_id: d.component_id ?? null,
      title: d.title,
      filename: d.filename,
      mime: "text/markdown",
      size: bytes.byteLength,
      r2_key: key,
      kind: d.kind,
      ns3451: d.ns3451,
      status: "ready",
      summary: d.summary,
      uploaded_by: userId,
    }).run();
    const chars = await indexDocumentText(env, { id, org_id: orgId, title: d.title }, d.text);
    await env.DB.prepare(`UPDATE documents SET text_chars = ? WHERE id = ?`).bind(chars, id).run();
  }

  // ── IFC-modell (statisk fil som følger med appen) ──
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/samples/sagbruket-hovedbygg.ifc"));
    if (res.ok) {
      const bytes = await res.arrayBuffer();
      const id = newId("doc");
      const key = `orgs/${orgId}/documents/${id}/sagbruket-hovedbygg.ifc`;
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/x-step" } });
      await insert(env.DB, "documents", {
        ...base,
        id,
        property_id: p1,
        building_id: bA,
        title: "Hovedbygg – arkitektmodell (IFC)",
        filename: "sagbruket-hovedbygg.ifc",
        mime: "application/x-step",
        size: bytes.byteLength,
        r2_key: key,
        kind: "ifc",
        status: "stored",
        summary: "Forenklet arkitektmodell med etasjer, rom, vegger, dører, vinduer og tekniske komponenter.",
        uploaded_by: userId,
      }).run();
    }
  } catch (err) {
    console.warn("Fant ikke demo-IFC", err);
  }

  // ── Artifact: levende servicestatus ──
  const artId = newId("art");
  await env.DB.batch([
    insert(env.DB, "artifacts", {
      ...base,
      id: artId,
      title: "Servicestatus – Sagbruket",
      description: "Levende oversikt over komponenter og når neste service forfaller.",
      property_id: p1,
      building_id: bA,
      current_version: 1,
      pinned: 1,
      created_by_user: userId,
    }),
    insert(env.DB, "artifact_versions", { artifact_id: artId, version: 1, html: DEMO_ARTIFACT, note: "Første versjon", created_by: `user:${userId}`, created_at: t }),
  ]);

  return { property_id: p1 };
}

const DOC_VENT = `# Nordluft NL-4000 Roterende – Drifts- og vedlikeholdsinstruks

Gjelder: Ventilasjonsaggregat VA01, Hovedbygg, teknisk rom U-010. System =360.001.

## 1. Beskrivelse
Balansert ventilasjonsaggregat med roterende varmegjenvinner (temperaturvirkningsgrad 82 %), EC-vifter og integrert styring. Nominell luftmengde 4 000 m³/h.

## 2. Serviceintervaller
| Tiltak | Intervall |
|---|---|
| Visuell kontroll, alarmer og driftstider | Månedlig |
| Filterbytte (F7 tilluft, M5 avtrekk) | Hver 6. måned, eller ved trykkfall over 150 Pa |
| Kontroll av rotor, børstetetninger og drivreim | Hver 6. måned |
| Rengjøring av vifter og varmegjenvinner | Årlig |
| Funksjonstest av brannspjeld og røykdetektor i kanal | Årlig |
| Kontroll av innregulering og luftmengder | Hvert 3. år |

## 3. Filterbytte
Slå av aggregatet via styringen og bryt sikkerhetsbryter før lukene åpnes. Filtertype: posefilter F7 592x592x534 (tilluft) og M5 592x592x534 (avtrekk). Registrer dato for filterbytte i FDV-systemet.

## 4. Feilsøking
- **Alarm «Rotorvakt»:** Kontroller drivreim og motor. Reim skal skiftes ved slitasje eller sprekker.
- **Lav tilluftstemperatur:** Kontroller rotorhastighet og varmebatteri.
- **Høyt trykkfall over filter:** Skift filter.

## 5. Reservedeler
Drivreim art.nr. NL-R4000, børstetetning NL-B4000, filtersett NL-F4000-F7/M5.

## 6. Garanti
5 års garanti fra overtakelse forutsatt dokumentert service hver 6. måned.`;

const DOC_BRANN = `# Brannalarmanlegg – Hovedbygg

## Anleggsbeskrivelse
Adresserbart brannalarmanlegg Vaktsikker VS-8 med 214 detektorpunkter fordelt på 4 sløyfer. Sentral i resepsjon (rom 1-001), brannpanel ved hovedinngang. Anlegget er direktekoblet til 110-sentralen via alarmoverføring.

## Soneinndeling
| Sone | Område |
|---|---|
| 1 | Kjeller U1 inkl. teknisk rom og sykkelparkering |
| 2 | 1. etasje |
| 3 | 2. etasje |
| 4 | 3. etasje og tekniske rom på tak |

## Egenkontroll (eier/bruker)
- Månedlig: Kontroll av sentral (ingen feil eller utkoblinger), test av én detektor per sone etter rulleringsplan, kontroll av at manuelle meldere er uhindret.
- Kvartalsvis: Test av alarmoverføring til 110-sentral.
- Loggføring i kontrollbok eller FDV-system.

## Årlig kontroll
Anlegget skal kontrolleres årlig av sertifisert foretak iht. NS 3960. Kontrollrapport med eventuelle avvik skal arkiveres i FDV-dokumentasjonen. Avvik skal lukkes innen fristen i rapporten.

## Utkobling
Ved varme arbeider skal berørt sone kobles ut og brannvakt etableres. Utkobling skal alltid loggføres med tidspunkt og ansvarlig.`;

const DOC_TILSTAND = `# Tilstandsanalyse – Sagbruket kontorpark 2025

Utført iht. NS 3424, nivå 1. Befaring utført 12. juni 2025.

## Sammendrag
Hovedbygget (2019) er generelt i god stand. Lagerhallen (1998) har flere bygningsdeler med tilstandsgrad 2–3 og behov for tiltak innen 1–3 år.

## Hovedbygg
| Bygningsdel | NS 3451 | TG | Kommentar |
|---|---|---|---|
| Yttervegger | 23 | TG0 | Ingen avvik |
| Yttertak | 26 | TG1 | Noe tilgroing i takrenner – rens årlig |
| Ventilasjon | 36 | TG1 | Service gjennomført, men dokumentasjon av innregulering mangler |
| Heis | 62 | TG0 | Periodisk kontroll uten anmerkninger |
| Sanitær | 31 | TG1 | Enkelte lekkasjer i pantry-områder bør følges opp |

## Lagerhall
| Bygningsdel | NS 3451 | TG | Kommentar |
|---|---|---|---|
| Yttertak | 26 | TG2 | Takpapp med begynnende sprekker. Anbefales omtekking innen 3 år. Estimert kostnad 1,2–1,6 MNOK |
| Vinduer og porter | 23 | TG2 | Portmotor på port 2 slitt |
| Varme | 32 | TG3 | Oljekjel utfaset, ikke fjernet. Tank må saneres iht. forurensningsforskriften |
| Elkraft | 43 | TG2 | Eldre sikringsskap uten jordfeilvern på alle kurser |

## Anbefalte tiltak (prioritert)
1. Sanering av oljetank og fjerning av oljekjel i lagerhall (lovkrav).
2. Utbedring av elanlegg i lagerhall (jordfeilvern).
3. Omtekking av lagerhall innen 3 år.
4. Skaffe innreguleringsprotokoll for VA01 i hovedbygg.`;

const DOC_HEIS = `# Serviceavtale – Personheis H1, Hovedbygg

Leverandør: Liftverk AS. Heis: LV-630 MRL (maskinromsløs), 630 kg / 8 personer, 5 stopp (U1–3).

## Omfang
- Månedlig forebyggende service inkl. smøring, justering av dører og test av nødtelefon.
- Årlig periodisk kontroll av akkreditert kontrollorgan, jf. forskrift om løfteinnretninger. Kontrollrapport sendes eier.
- Fri utrykning ved stans mellom etasjer innen 1 time (døgnvakt).

## Eiers plikter
- Sørge for at heissertifikat og siste kontrollrapport er tilgjengelig.
- Melde fra om feil og skader umiddelbart.
- Ikke tillate overlast.

## Avtaleperiode
Avtalen løper i 3 år fra 1. juni 2024 med automatisk fornyelse, 6 måneders oppsigelse.`;

const DEMO_ARTIFACT = `<!doctype html>
<html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Servicestatus</title>
<style>
  :root { --bg:#fbfaf7; --fg:#1f1d1a; --muted:#7a7368; --line:#e4ded4; --ok:#3f7a4f; --warn:#b07a12; --bad:#b4442b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#191816; --fg:#ece8e1; --muted:#a39b8f; --line:#34312c; } }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Inter,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:960px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em }
  p.sub { color:var(--muted); margin:0 0 20px }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px }
  .stat { border:1px solid var(--line); border-radius:10px; padding:12px 14px }
  .stat b { display:block; font-size:24px }
  table { width:100%; border-collapse:collapse }
  th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line) }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600 }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; font-weight:600; color:#fff }
  a { color:inherit }
</style></head>
<body><main>
  <h1>Servicestatus</h1>
  <p class="sub">Levende data fra FDV-registeret i Plank.</p>
  <div class="stats" id="stats"></div>
  <table><thead><tr><th>Komponent</th><th>Bygg</th><th>Neste service</th><th>Status</th></tr></thead><tbody id="rows"><tr><td colspan="4">Laster …</td></tr></tbody></table>
</main>
<script>
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const days = (d) => Math.round((new Date(d) - new Date(new Date().toISOString().slice(0,10))) / 864e5);
  async function load() {
    const comps = (await plank.query("components.list", {})).filter(c => c.next_service_at);
    comps.sort((a, b) => a.next_service_at.localeCompare(b.next_service_at));
    const overdue = comps.filter(c => days(c.next_service_at) < 0).length;
    const soon = comps.filter(c => { const d = days(c.next_service_at); return d >= 0 && d <= 60; }).length;
    document.getElementById("stats").innerHTML =
      '<div class="stat"><b>' + comps.length + '</b>med serviceintervall</div>' +
      '<div class="stat"><b style="color:var(--bad)">' + overdue + '</b>på overtid</div>' +
      '<div class="stat"><b style="color:var(--warn)">' + soon + '</b>innen 60 dager</div>';
    document.getElementById("rows").innerHTML = comps.map(c => {
      const d = days(c.next_service_at);
      const [label, color] = d < 0 ? [Math.abs(d) + " dager over", "var(--bad)"] : d <= 60 ? ["Om " + d + " dager", "var(--warn)"] : ["OK", "var(--ok)"];
      return '<tr><td><a href="#" data-id="' + esc(c.id) + '">' + esc(c.name) + '</a></td><td>' + esc(c.building_name) + '</td><td>' + esc(c.next_service_at) +
        '</td><td><span class="pill" style="background:' + color + '">' + label + '</span></td></tr>';
    }).join("");
    document.querySelectorAll("a[data-id]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); plank.open("component", a.dataset.id); }));
  }
  load().catch(err => { document.getElementById("rows").innerHTML = '<tr><td colspan="4">Feil: ' + err.message + '</td></tr>'; });
</script>
</body></html>`;
