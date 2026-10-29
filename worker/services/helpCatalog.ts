/** Katalog over sider hjelpen skal dekke. Teksten er starten; agenten skriver den om når skjermen sier noe annet. */

export const CATALOG_VERSION = 1;

export interface HelpSeed {
  slug: string;
  title: string;
  category: string;
  /** Sti under /o/:orgId. Tom når stien må slås opp (én eiendom). */
  path: string;
  dynamic?: "property";
  sort: number;
  summary: string;
  body: string;
}

export const HELP_CATALOG: HelpSeed[] = [
  {
    slug: "oversikt",
    title: "Oversikt",
    category: "Kom i gang",
    path: "/",
    sort: 10,
    summary: "Startsiden med bygg, åpne oppgaver, service og dokumenter.",
    body: `Oversikt er startsiden. Øverst står navnet ditt og organisasjonen. Derfra kan du laste opp filer, og spørre en agent hva som bør prioriteres.

Tallene under viser bygg, åpne oppgaver, service på overtid og dokumenter. Hvert tall åpner listen det kommer fra.

Under tallene ligger neste oppgaver og service som forfaller. Eiendommene og byggene står i sidemenyen under Portefølje.

Spør en agent nede til høyre åpner panelet. ⌘J gjør det samme.`,
  },
  {
    slug: "hjelp",
    title: "Hjelpesenter",
    category: "Kom i gang",
    path: "/hjelp",
    sort: 20,
    summary: "Forklaringer av sidene, med skjermbilder som oppdateres av seg selv.",
    body: `Hjelp samler korte forklaringer av sidene i Plank. Artiklene starter med en fast tekst, og agenten Hjelp skriver dem om når sidene endrer seg.

Skjermbildene tas automatisk av organisasjonens egne sider, så forklaringen viser knappene som faktisk finnes.

Søk på denne siden, eller trykk Spør Hjelp. Agenten kan åpne sidene og svare ut fra det den ser.`,
  },
  {
    slug: "portefolje",
    title: "Eiendom og bygg",
    category: "Portefølje",
    path: "",
    dynamic: "property",
    sort: 30,
    summary: "Eiendommer, bygg, etasjer og rom.",
    body: `Porteføljen ligger i sidemenyen. En eiendom åpnes der, og byggene ligger under den.

På eiendommen ser du adressen. Med redigeringstilgang kan du legge til et bygg med Nytt bygg.

På et bygg kan du legge til etasjer og rom, lese rom fra en plantegning, eller laste opp en IFC-modell. Oppsummer spør en agent om åpne oppgaver, service, tilstand og dokumentasjon.

På et rom kan du spørre hva som finnes av komponenter, dokumenter og oppgaver.

Har du lesetilgang, ser du det du har fått, og knappene for å legge til noe vises ikke.`,
  },
  {
    slug: "dokumenter",
    title: "Dokumenter",
    category: "Portefølje",
    path: "/documents",
    sort: 40,
    summary: "FDV-dokumentasjon, datablad, tegninger, rapporter og IFC.",
    body: `Dokumenter er FDV-dokumentasjon, produktdatablad, tegninger, rapporter og IFC-modeller. Teksten hentes ut og gjøres søkbar, så du og agentene kan spørre i innholdet.

Last opp ligger øverst til høyre når du kan redigere. Du kan også laste opp fra oversikten.

Åpne et dokument for å lese det. Når innlesingen er ferdig, kan Oppsummer be en agent om det som betyr noe for drift og vedlikehold.

Dokumenter kan knyttes til bygg og komponenter, så de vises der de hører hjemme.`,
  },
  {
    slug: "fdv-register",
    title: "FDV-register",
    category: "Portefølje",
    path: "/components",
    sort: 50,
    summary: "Tekniske anlegg med NS 3451, serviceintervall og tilstand.",
    body: `FDV-registeret er komponentene: tekniske anlegg og utstyr. En komponent kan ha NS 3451-kode, TFM-merking, produsent, modell, serviceintervall, siste og neste service, og tilstandsgrad TG0–TG3.

Ny komponent legger inn en komponent når du har redigeringstilgang.

Åpne en komponent for detaljene. Hva skal gjøres? spør en agent når neste service er, og hva dokumentasjonen sier.

Service på overtid vises også som et tall på oversikten.`,
  },
  {
    slug: "oppgaver",
    title: "Oppgaver",
    category: "Arbeid",
    path: "/tasks",
    sort: 60,
    summary: "Vedlikehold, avvik, kontroller og dokumentasjonsmangler.",
    body: `Oppgaver samler vedlikehold, avvik, kontroller og dokumentasjonsmangler. Både du og agentene kan opprette dem.

Over listen kan du velge Åpne, Utførte eller Alle, søke, og avgrense på type og bygg.

Ny oppgave ligger øverst til høyre når du kan redigere. En oppgave har tittel, beskrivelse, type, prioritet, status og forfallsdato, og kan knyttes til bygg, rom eller komponent.`,
  },
  {
    slug: "agenter",
    title: "Agenter",
    category: "Arbeid",
    path: "/agents",
    sort: 70,
    summary: "Assistenter med egne verktøy, instrukser og tidsplaner.",
    body: `Agenter jobber med dokumenter, registre og modeller. Hver agent har navn, form, farge, instrukser og verktøy.

Ny agent starter fra en mal eller fra bunnen. Der setter du hva agenten får lese og endre, og om den skal kjøre av seg selv.

En planlagt agent kjører uten at noen sitter i panelet, og legger igjen en oppsummering. Hjelp er en slik agent: den holder dette hjelpesenteret oppdatert.

I panelet til høyre velger du agent og skriver. Enter sender. Shift+Enter gir ny linje.`,
  },
  {
    slug: "sider",
    title: "Sider",
    category: "Arbeid",
    path: "/artifacts",
    sort: 80,
    summary: "Dashboards og rapporter med levende data.",
    body: `Sider er dashboards, rapporter, sjekklister og verktøy. De henter data fra Plank når de åpnes, så tallene ikke ligger fast i teksten.

Lag med agent foreslår dashboards ut fra det som finnes. Du kan også opprette en tom side.

Sider du fester, vises under Mine sider i sidemenyen. Agenten Sidebygger kan endre en side når du ber om det.`,
  },
  {
    slug: "boligmappa",
    title: "Boligmappa",
    category: "Integrasjoner",
    path: "/boligmappa",
    sort: 90,
    summary: "Hent bygg og dokumenter fra Boligmappa inn i Plank.",
    body: `Boligmappa er en datakilde. Når den er koblet til, kan du hente bygg og dokumentene deres inn i Plank, slik at agentene kan bruke dem.

Du huker av byggene og trykker Hent. Dokumenter kan hentes for ett bygg eller for flere. Siden viser organisasjonsnummeret når koblingen er på plass.

Hent fra Boligmappa ligger også under pluss-knappen ved Portefølje, og under Datakilder i innstillingene. Integrasjonen gjelder hele porteføljen, så den er ikke med når du bare har tilgang til utvalgte eiendommer.`,
  },
  {
    slug: "laft",
    title: "LAFT",
    category: "Integrasjoner",
    path: "/laft",
    sort: 100,
    summary: "Bygg, arbeidsordrer og dokumentarkiv fra LAFT.",
    body: `LAFT er en datakilde for bygg, arbeidsordrer og dokumentarkiv. Koblingen bruker tilgangen til den som koblet til.

Du huker av bygg eller filer og trykker Hent. Agenten kan lese arbeidsordrer, rutiner og dokumenter, og oppdatere arbeidsordrer når den har fått det verktøyet.

Hent fra LAFT ligger under pluss-knappen ved Portefølje, og under Datakilder i innstillingene. Integrasjonen gjelder hele porteføljen.`,
  },
  {
    slug: "innstillinger",
    title: "Innstillinger",
    category: "Konto",
    path: "/settings",
    sort: 110,
    summary: "Profil, organisasjon, datakilder og status.",
    body: `Innstillinger åpner du fra menyen nederst til venstre, der navnet ditt står.

Din profil er navnet som vises, og e-posten du logger inn med. Organisasjon er navnet på kontoen. Administratorer kan endre det.

Abonnement viser planen og har en lenke til Abonnement og bruk. Datakilder er snarveier til LAFT og Boligmappa. Brukere og tilganger viser hvem som er med, og Systemstatus sier om agentene, e-post og tekstuthenting er klare.`,
  },
  {
    slug: "tilganger",
    title: "Brukere og tilganger",
    category: "Konto",
    path: "/tilganger",
    sort: 120,
    summary: "Inviter kolleger og leverandører, og avgrens hva de ser.",
    body: `Brukere og tilganger styrer hvem som er med i organisasjonen. Inviter sender en invitasjon. Du kan gi hele porteføljen eller bare valgte eiendommer og bygg, sette lese- eller redigeringstilgang, og en dato tilgangen varer til.

Eiere og administratorer har full tilgang. Med lesetilgang kan man se og spørre agentene, men ikke endre registrene.

En begrenset tilgang viser bare eiendommene og byggene som er krysset av. Nye bygg på en eiendom personen har tilgang til, følger med.`,
  },
  {
    slug: "abonnement",
    title: "Abonnement og bruk",
    category: "Konto",
    path: "/abonnement",
    sort: 130,
    summary: "Plan, bygg og AI-bruk for organisasjonen.",
    body: `Abonnement og bruk viser nåværende plan, hvor mange bygg som er i bruk, og AI-bruken denne måneden. Beløpene er inkludert mva.

Administratorer kan velge eller bytte plan. Kort og fakturaer åpnes når betaling er koblet til. Er grensen for AI-bruk nådd, settes agentene på pause til neste måned eller til grensen heves.

Siden gjelder organisasjonen, ikke en personlig faktura.`,
  },
];
