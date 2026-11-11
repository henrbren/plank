import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/domain";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { formatOrgNr } from "@/lib/format";

/** Rolig ramme uten stegliste. Ett spørsmål om gangen. */
export function WizardShell({ children }: { step?: number; children: ReactNode }) {
  return (
    <div className="min-h-full bg-bg text-ink">
      <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 py-8 sm:py-12">
        <Logo />
        <div className="mt-10">{children}</div>
      </div>
    </div>
  );
}

interface Lookup {
  orgNr: string;
  name: string;
  orgForm: string | null;
}

function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 9);
}

function spaced(digits: string): string {
  return digits.replace(/(\d{3})(?=\d)/g, "$1 ");
}

/** Første steg på Plank: organisasjonsnummer, oppslag, og så henting på serveren. */
export function StartWizard({ cancelTo }: { cancelTo: string | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [digits, setDigits] = useState("");
  const [company, setCompany] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const looked = useRef<string | null>(null);

  const lookup = async (next: string) => {
    if (next.length !== 9) return;
    looked.current = next;
    setLooking(true);
    setError(null);
    setCompany(null);
    try {
      const res = await api<Lookup>("/me/org-lookup", { body: { orgNr: next } });
      if (looked.current === next) setCompany(res);
    } catch (err) {
      if (looked.current === next) setError(err instanceof Error ? err.message : "Kunne ikke slå opp organisasjonen");
    } finally {
      if (looked.current === next) setLooking(false);
    }
  };

  useEffect(() => {
    if (digits.length === 9) void lookup(digits);
    // lookup endrer bare lokal visning for de ni sifrene
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!company || digits.length !== 9) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api<{ id: string }>("/me/orgs", { body: { orgNr: company.orgNr, bmNotify: true } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate(`/velkommen/${org.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
      setBusy(false);
    }
  };

  return (
    <WizardShell step={0}>
      <form onSubmit={submit}>
        <p className="text-[12.5px] font-semibold tracking-wide text-accent uppercase">Kom i gang</p>
        <h1 className="mt-2 text-[34px] leading-[1.15] font-semibold tracking-tight">Hvilken virksomhet skal inn?</h1>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-ink-2">
          Skriv organisasjonsnummeret. Vi henter byggene og dokumentene. Du kan lukke nettleseren etterpå.
        </p>

        <label className="mt-8 block">
          <span className="text-[13px] font-medium text-ink-2">Organisasjonsnummer</span>
          <span className="relative mt-1.5 block">
            <input
              inputMode="numeric"
              autoFocus
              autoComplete="off"
              placeholder="123 456 789"
              aria-invalid={Boolean(error)}
              value={spaced(digits)}
              onChange={(e) => {
                const next = digitsOf(e.target.value);
                setDigits(next);
                setCompany(null);
                looked.current = null;
                setLooking(false);
                setError(null);
              }}
              className="h-14 w-full rounded-xl border border-line-strong bg-panel px-4 text-[22px] tracking-[0.08em] text-ink tabular-nums placeholder:text-muted/50 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
            />
            {looking && <Spinner className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted" />}
          </span>
        </label>

        {company && (
          <div className="mt-4 rounded-2xl border border-line bg-panel px-4 py-3.5">
            <div className="text-[15px] font-medium">{company.name}</div>
            <div className="mt-0.5 text-[13px] text-muted">
              {company.orgForm || "Organisasjon"} · {formatOrgNr(company.orgNr)}
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-[13.5px] text-bad">{error}</p>}

        <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" loading={busy} disabled={!company || looking}>
          Hent byggene
          <ArrowRight className="size-4" />
        </Button>
        {cancelTo && (
          <button type="button" className="mt-4 w-full text-[13.5px] text-muted hover:text-ink" onClick={() => navigate(cancelTo)}>
            Avbryt
          </button>
        )}
      </form>
    </WizardShell>
  );
}
