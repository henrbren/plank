/** White-label merkevarer. Hosten avgjør hvilken løsningen later som den er. */

export type BrandId = "plank" | "leie" | "naeringsmappa" | "sameie";

export interface Brand {
  id: BrandId;
  name: string;
  tagline: string;
  loginTitle: string;
  loginLead: string;
  showcaseKicker: string;
  showcaseTitle: string;
  showcaseLead: string;
  accountLabel: string;
  /** Kort tekst i merkevarevalget på LAFT-domenene */
  chooserBody: string;
  logo: string | null;
  copyright: string;
  emailFromName: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentInk: string;
  darkAccent: string;
  darkAccentHover: string;
  darkAccentSoft: string;
  darkAccentInk: string;
}

export const BRANDS: Record<BrandId, Brand> = {
  plank: {
    id: "plank",
    name: "Plank",
    tagline: "FDV med AI-agenter",
    loginTitle: "Inn i Plank",
    loginLead: "Skriv e-posten. Du får en lenke, og er inne på under et minutt.",
    showcaseKicker: "FDV med AI-agenter",
    showcaseTitle: "Arbeidsflaten der agentene kjenner byggene dine.",
    showcaseLead: "Last opp FDV-dokumentasjon og IFC-modeller, sett opp agenter som jobber for deg, og lag egne sider med levende data – for hver eiendom, hvert bygg og hver etasje.",
    accountLabel: "LAFT-konto",
    chooserBody: "",
    logo: null,
    copyright: "Plank",
    emailFromName: "Plank",
    accent: "#a65b24",
    accentHover: "#8f4d1d",
    accentSoft: "#f5e8dc",
    accentInk: "#ffffff",
    darkAccent: "#d08a4f",
    darkAccentHover: "#dc9b63",
    darkAccentSoft: "#382819",
    darkAccentInk: "#1b1209",
  },
  leie: {
    id: "leie",
    name: "Leie",
    tagline: "Bolig og næring i samme kø",
    loginTitle: "Inn i Leie",
    loginLead: "Skriv e-posten. Du får en lenke, og pulten er klar.",
    showcaseKicker: "Utleie",
    showcaseTitle: "Morgenpulten for bolig og næring.",
    showcaseLead: "Ledig, utløp, restanse og kø i samme liste. Sortert på frist, så på beløp. Agenten forklarer saken og skriver neste brev.",
    accountLabel: "Leie-konto",
    chooserBody: "",
    logo: null,
    copyright: "Leie",
    emailFromName: "Leie",
    accent: "#1f6b4a",
    accentHover: "#18553a",
    accentSoft: "#e5f3eb",
    accentInk: "#ffffff",
    darkAccent: "#8dcead",
    darkAccentHover: "#a5d9be",
    darkAccentSoft: "#1a3328",
    darkAccentInk: "#0e241b",
  },
  naeringsmappa: {
    id: "naeringsmappa",
    name: "Næringsmappa",
    tagline: "Utviklet av LAFT i samarbeid med Boligmappa",
    loginTitle: "Inn i Næringsmappa",
    loginLead: "Logg inn med Vipps eller Næringsmappa-kontoen din. Byggene og dokumentene kommer med.",
    showcaseKicker: "Dokumentarkiv for næringseiendom",
    showcaseTitle: "Samme arkiv. Agentene kjenner byggene.",
    showcaseLead: "Hent bygg og dokumenter fra Boligmappa, og la agentene holde orden på det som mangler.",
    accountLabel: "Næringsmappa-konto",
    chooserBody: "Dokumentarkiv for næringseiendom.",
    logo: "/brands/naeringsmappa.png",
    copyright: "Næringsmappa · LAFT",
    emailFromName: "Næringsmappa",
    accent: "#466084",
    accentHover: "#324660",
    accentSoft: "#e6eaf0",
    accentInk: "#ffffff",
    darkAccent: "#8FA6C4",
    darkAccentHover: "#a3b6ce",
    darkAccentSoft: "#253242",
    darkAccentInk: "#141a22",
  },
  sameie: {
    id: "sameie",
    name: "LAFT Sameie & Borettslag",
    tagline: "Dokumentarkiv for sameier og borettslag, levert av LAFT",
    loginTitle: "Inn i LAFT Sameie & Borettslag",
    loginLead: "Logg inn med Vipps eller kontoen din. Dokumentene følger bygget når styret skiftes.",
    showcaseKicker: "Sameie og borettslag",
    showcaseTitle: "Dokumentasjonen blir værende i bygget.",
    showcaseLead: "Hent mappe og dokumenter, og la agentene minne styret på det som forfaller.",
    accountLabel: "LAFT-konto",
    chooserBody: "Samme arkiv, eget merke for sameier og borettslag.",
    logo: "/brands/laft_sameie.png",
    copyright: "LAFT Sameie & Borettslag",
    emailFromName: "LAFT Sameie & Borettslag",
    accent: "#466084",
    accentHover: "#324660",
    accentSoft: "#e6eaf0",
    accentInk: "#ffffff",
    darkAccent: "#8FA6C4",
    darkAccentHover: "#a3b6ce",
    darkAccentSoft: "#253242",
    darkAccentInk: "#141a22",
  },
};

export function brandFromHost(host: string | null | undefined): Brand {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  if (h === "leie.vixon.no" || h === "leie.vixon.workers.dev" || h.startsWith("leie.")) return BRANDS.leie;
  if (h === "sameie.laft.io" || h.startsWith("sameie.")) return BRANDS.sameie;
  if (h === "mappa.laft.io" || h === "mappa2.laft.io" || h.startsWith("mappa.")) return BRANDS.naeringsmappa;
  return BRANDS.plank;
}

/** Sameie og Næringsmappa. Leie er et eget produkt, ikke et LAFT-domene. */
export function isLaftHost(host: string | null | undefined): boolean {
  const id = brandFromHost(host).id;
  return id === "naeringsmappa" || id === "sameie";
}

/**
 * På sameie.laft.io kan brukeren velge Næringsmappa. mappa.laft.io og mappa2.laft.io
 * er alltid Næringsmappa, også om et eldre valg ligger lagret. Plank og Leie følger vertsnavnet.
 */
export function resolveBrand(host: string | null | undefined, chosen?: string | null): Brand {
  const fromHost = brandFromHost(host);
  if (fromHost.id === "plank" || fromHost.id === "leie" || fromHost.id === "naeringsmappa") return fromHost;
  if (chosen === "naeringsmappa" || chosen === "sameie") return BRANDS[chosen];
  return fromHost;
}

export function isWhiteLabel(brand: Brand): boolean {
  return brand.id === "naeringsmappa" || brand.id === "sameie";
}
