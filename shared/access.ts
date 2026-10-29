/** Teksten personen krysser av for. Lagres ordrett sammen med forespørselen. */
export function accessConsentText(company: string, orgNr: string): string {
  return `Jeg bekrefter at jeg har lov til å hente bygg og dokumenter fra Boligmappa for ${company} (org.nr ${orgNr}), og at opplysningene jeg har gitt stemmer.`;
}
