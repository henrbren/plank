/**
 * Ferdige oppgaver (MCP-prompts) som klienter kan vise som snarveier, f.eks. som /-kommandoer i Claude.
 */

interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  text: (args: Record<string, string>) => string;
}

const where = (a: Record<string, string>) =>
  a.building_id ? ` for bygget med ID ${a.building_id}` : a.property_id ? ` for eiendommen med ID ${a.property_id}` : " for hele porteføljen";

export const PROMPTS: PromptDef[] = [
  {
    name: "fdv_statusrapport",
    title: "FDV-statusrapport",
    description: "Statusrapport med risiko, forfalt service, avvik og dokumentasjonsmangler – og hva som bør gjøres først.",
    arguments: [
      { name: "building_id", description: "Avgrens til ett bygg (valgfritt)" },
      { name: "property_id", description: "Avgrens til én eiendom (valgfritt)" },
    ],
    text: (a) =>
      `Lag en FDV-statusrapport${where(a)}. Kall analyze_portfolio${a.building_id ? ` med building_id ${a.building_id}` : a.property_id ? ` med property_id ${a.property_id}` : ""}, og hent detaljer med list_tasks og list_components der det trengs. ` +
      "Rapporten skal ha: kort oppsummering, de viktigste funnene sortert etter risiko, forfalt og kommende service, åpne avvik, dokumentasjonsmangler og en prioritert tiltaksliste. Bruk tabeller der det passer.",
  },
  {
    name: "vedlikeholdsplan",
    title: "Vedlikeholdsplan",
    description: "Vedlikeholdsplan måned for måned basert på serviceintervaller, tilstand og åpne oppgaver.",
    arguments: [
      { name: "building_id", description: "Bygget planen gjelder (valgfritt)" },
      { name: "maneder", description: "Antall måneder fram (standard 12)" },
    ],
    text: (a) => {
      const months = Number(a.maneder) > 0 ? Math.min(Number(a.maneder), 60) : 12;
      return (
        `Lag en vedlikeholdsplan for de neste ${months} månedene${where(a)}. ` +
        `Bruk list_components med service_due_within_days ${months * 31}, analyze_portfolio og list_tasks. Grupper per måned, ta med komponent, plassering, NS 3451 og hva som skal gjøres. ` +
        "Pek ut komponenter som mangler serviceintervall eller dokumentasjon. Spør meg før du oppretter oppgaver for tiltakene."
      );
    },
  },
  {
    name: "hent_fra_boligmappa",
    title: "Hent fra Boligmappa",
    description: "Synk Boligmappa, vis hva som finnes, og hent valgte bygg med dokumenter inn i Plank.",
    arguments: [{ name: "org_nr", description: "Organisasjonsnummer hvis Boligmappa ikke er koblet til ennå (valgfritt)" }],
    text: (a) =>
      "Hjelp meg å hente bygg og dokumenter fra Boligmappa inn i Plank. Kall plank_info for å se om Boligmappa er koblet til. " +
      (a.org_nr ? `Er den ikke det, koble til med boligmappa_koble_til og organisasjonsnummer ${a.org_nr}. ` : "Er den ikke det, spør meg om organisasjonsnummeret og koble til med boligmappa_koble_til. ") +
      "Kjør boligmappa_synk til status er ready, og vis meg boligmappa_oversikt som en tabell (eiendom, bygg, antall dokumenter, allerede hentet). " +
      "Spør hvilke bygg jeg vil hente, og kjør boligmappa_import til remainingDocuments er 0. Avslutt med analyze_portfolio for de nye byggene.",
  },
  {
    name: "dokumentkontroll",
    title: "Dokumentkontroll",
    description: "Finn dokumenter som mangler type, NS 3451 eller plassering, og komponenter uten dokumentasjon.",
    arguments: [{ name: "building_id", description: "Bygget kontrollen gjelder (valgfritt)" }],
    text: (a) =>
      `Gå gjennom dokumentasjonen${where(a)}. Bruk list_documents og list_components, og les dokumenter med read_document ved behov. ` +
      "Finn dokumenter med type «annet» eller uten NS 3451-kode, dokumenter uten bygg, og komponenter uten tilknyttet dokumentasjon. " +
      "Foreslå riktig klassifisering og kobling i en tabell, og spør før du gjør endringer med update_document.",
  },
];

export function renderPrompt(name: string, args: Record<string, string>) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) return null;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) if (typeof v === "string" && v.trim()) clean[k] = v.trim().slice(0, 100);
  return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(clean) } }] };
}
