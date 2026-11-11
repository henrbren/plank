/** Deler som kan slås på per organisasjon. Leie skjuler FDV. Plank skjuler utleie. */
export const ORG_MODULES = ["drift", "kart", "dokumenter", "komponenter", "sider", "utleie"] as const;

export type OrgModule = (typeof ORG_MODULES)[number];

export const ORG_MODULE_LABEL: Record<OrgModule, string> = {
  drift: "Drift",
  kart: "Kart",
  dokumenter: "Dokumenter",
  komponenter: "Komponenter",
  sider: "Sider",
  utleie: "Utleie",
};

export function isOrgModule(value: string): value is OrgModule {
  return (ORG_MODULES as readonly string[]).includes(value);
}

export function parseOrgModules(raw: string | null | undefined): OrgModule[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: OrgModule[] = [];
  for (const item of value) {
    if (typeof item === "string" && isOrgModule(item) && !out.includes(item)) out.push(item);
  }
  return out;
}
