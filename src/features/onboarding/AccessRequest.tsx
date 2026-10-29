import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Mail } from "lucide-react";
import { Button, Checkbox, Field, Input, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { formatOrgNr } from "@/lib/format";
import { useBrand } from "@/lib/brand";
import { accessConsentText } from "@shared/access";

interface Company {
  orgNr: string;
  name: string;
  orgForm: string | null;
  municipal: boolean;
}

export interface AccessRequestResult {
  kind: "org" | "kommune";
  email: string;
  orgName: string;
  orgNr: string;
}

/** Tilgang uten Vipps: virksomhet, navn, e-post og samtykke. LAFT godkjenner i boligmappa-ms. */
export function AccessRequestForm({
  user,
  initialOrgNr,
  onDone,
}: {
  user?: { email: string; name: string | null } | null;
  initialOrgNr?: string;
  onDone: (result: AccessRequestResult) => void;
}) {
  const [orgNr, setOrgNr] = useState(initialOrgNr ?? "");
  const [company, setCompany] = useState<Company | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const looked = useRef<string | null>(null);

  const lookup = async (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 9) return;
    looked.current = digits;
    setLooking(true);
    setLookupError(null);
    setCompany(null);
    setConsent(false);
    try {
      const res = await api<Company>("/auth/org-name", { body: { orgNr: digits } });
      if (looked.current === digits) setCompany(res);
    } catch (err) {
      if (looked.current === digits) setLookupError(err instanceof Error ? err.message : "Kunne ikke slå opp organisasjonen");
    } finally {
      if (looked.current === digits) setLooking(false);
    }
  };

  useEffect(() => {
    if (initialOrgNr) void lookup(initialOrgNr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!company || !consent) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api<AccessRequestResult>("/auth/access-request", { body: { orgNr: company.orgNr, name, email, consent } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Organisasjonsnummer" hint="9 siffer" error={lookupError}>
        <div className="relative">
          <Input
            inputMode="numeric"
            autoFocus={!initialOrgNr}
            placeholder="123 456 789"
            value={orgNr}
            onChange={(e) => {
              setOrgNr(e.target.value);
              setCompany(null);
              setConsent(false);
              looked.current = null;
              if (e.target.value.replace(/\D/g, "").length === 9) void lookup(e.target.value);
            }}
          />
          {looking && <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />}
        </div>
      </Field>
      {company && (
        <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3 text-[13.5px]">
          <div className="font-medium">{company.name}</div>
          <div className="text-muted">
            {company.orgForm || "Organisasjon"} · {formatOrgNr(company.orgNr)}
          </div>
        </div>
      )}
      <Field label="Fullt navn">
        <Input required autoComplete="name" placeholder="Kari Nordmann" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="E-post" hint={user ? "Fra kontoen du er logget inn med." : "Hit sender vi lenken når tilgangen er godkjent."}>
        <Input
          type="email"
          required
          autoComplete="email"
          placeholder="navn@firma.no"
          readOnly={Boolean(user)}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <div className="-mx-2">
        <Checkbox
          checked={consent}
          onChange={setConsent}
          disabled={!company}
          label={company ? accessConsentText(company.name, company.orgNr) : "Jeg har lov til å hente bygg og dokumenter fra Boligmappa for virksomheten."}
          description={company ? undefined : "Skriv organisasjonsnummeret først."}
        />
      </div>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!company || !consent}>
        Send forespørsel
        <ArrowRight className="size-4" />
      </Button>
    </form>
  );
}

export function AccessRequestSent({ result, onBack }: { result: AccessRequestResult; onBack?: () => void }) {
  const brand = useBrand();
  return (
    <div>
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Mail className="size-5" />
      </div>
      <h1 className="text-[22px] font-semibold tracking-tight">Forespørselen er sendt</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
        {result.kind === "kommune" ? (
          <>
            LAFT går gjennom forespørselen for <b>{result.orgName}</b> og tar kontakt på <b>{result.email}</b> om overføringen til kommuneløsningen.
          </>
        ) : (
          <>
            LAFT går gjennom forespørselen for <b>{result.orgName}</b>. Når den er godkjent, får du en e-post til <b>{result.email}</b> med lenke rett inn i{" "}
            {brand.name}. Byggene og dokumentene fra Boligmappa hentes automatisk.
          </>
        )}
      </p>
      {onBack && (
        <Button variant="ghost" className="mt-6 -ml-3" onClick={onBack}>
          Tilbake
        </Button>
      )}
    </div>
  );
}
