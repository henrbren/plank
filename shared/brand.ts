/** White-label merkevarer. Hosten avgjør hvilken løsningen later som den er. */

export type BrandId = "plank" | "naeringsmappa" | "sameie";

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
  naeringsmappa: {
    id: "naeringsmappa",
    name: "Næringsmappa",
    tagline: "Levert av LAFT, i samarbeid med Boligmappa",
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
    accent: "#2F4A9F",
    accentHover: "#243a80",
    accentSoft: "#e4e8f5",
    accentInk: "#ffffff",
    darkAccent: "#7B93E0",
    darkAccentHover: "#93a6e8",
    darkAccentSoft: "#1c2438",
    darkAccentInk: "#0f1320",
  },
  sameie: {
    id: "sameie",
    name: "LAFT Sameie",
    tagline: "Dokumentarkiv for sameier, levert av LAFT",
    loginTitle: "Inn i LAFT Sameie",
    loginLead: "Logg inn med Vipps eller kontoen din. Dokumentene følger bygget når styret skiftes.",
    showcaseKicker: "Sameie og boligselskap",
    showcaseTitle: "Dokumentasjonen blir værende i bygget.",
    showcaseLead: "Hent mappe og dokumenter, og la agentene minne styret på det som forfaller.",
    accountLabel: "LAFT-konto",
    chooserBody: "Samme arkiv, eget merke for sameier og borettslag.",
    logo: "/brands/laft_sameie.png",
    copyright: "LAFT Sameie",
    emailFromName: "LAFT Sameie",
    accent: "#1D4ED8",
    accentHover: "#1a43b8",
    accentSoft: "#e0e7ff",
    accentInk: "#ffffff",
    darkAccent: "#60A5FA",
    darkAccentHover: "#7bb6fb",
    darkAccentSoft: "#172554",
    darkAccentInk: "#0b1226",
  },
};

export function brandFromHost(host: string | null | undefined): Brand {
  const h = (host ?? "").split(":")[0]!.toLowerCase();
  if (h === "sameie.laft.io" || h.startsWith("sameie.")) return BRANDS.sameie;
  if (h === "mappa.laft.io" || h === "mappa2.laft.io" || h.startsWith("mappa.")) return BRANDS.naeringsmappa;
  return BRANDS.plank;
}

/** På LAFT-domenene velger brukeren selv mellom Næringsmappa og LAFT Sameie. Plank er alltid Plank. */
export function resolveBrand(host: string | null | undefined, chosen?: string | null): Brand {
  const fromHost = brandFromHost(host);
  if (fromHost.id === "plank") return fromHost;
  if (chosen === "naeringsmappa" || chosen === "sameie") return BRANDS[chosen];
  return fromHost;
}

export function isWhiteLabel(brand: Brand): boolean {
  return brand.id !== "plank";
}
