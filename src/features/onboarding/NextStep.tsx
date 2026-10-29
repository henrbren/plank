import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Check } from "lucide-react";
import { PLANS, type Activation } from "@shared/types";
import { formatOre } from "@/lib/format";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { Button, ButtonLink, cn, useToast } from "@/components/ui";
import { PropertyFormModal } from "@/components/forms";

const FUNNEL = ["Inn", "Bygg", "Spør", "Betal"];

export interface NextAction {
  kind: "boligmappa" | "resume" | "import" | "property" | "building" | "ask" | "pay" | "portal" | "service";
  title: string;
  detail: string;
  action: string;
  /** Indeks i FUNNEL for steget som gjenstår. Null når løpet er fullført. */
  funnel: number | null;
  propertyId?: string | null;
  componentId?: string | null;
  prompt?: string;
}

const ASK = "Hva bør jeg prioritere i porteføljen denne uken? Se på byggene, dokumentene og service som forfaller.";

const nok = (n: number) => `${n.toLocaleString("nb-NO")} kr`;
const PLAN_SUMMARY = `Standard ${nok(PLANS.standard.priceNok)}/mnd med ${nok(PLANS.standard.includedAiNok)} AI-bruk, eller Pro ${nok(PLANS.pro.priceNok)}/mnd med ${nok(PLANS.pro.includedAiNok)}. Inkl. mva.`;

export function nextAction(a: Activation, isAdmin: boolean): NextAction | null {
  if (a.buildings === 0) {
    if (a.boligmappa.pendingImport > 0 || a.boligmappa.cachedBuildings > 0) {
      const n = a.boligmappa.pendingImport || a.boligmappa.cachedBuildings;
      return {
        kind: "import",
        title: n === 1 ? "Ett bygg venter på å komme inn" : `${n} bygg venter på å komme inn`,
        detail: "Huk av dem og ta dem inn. De vises i sidebaren med en gang.",
        action: "Ta dem inn",
        funnel: 1,
      };
    }
    if (a.boligmappa.connected && a.boligmappa.status !== "ready") {
      return {
        kind: "resume",
        title: "Fortsett hentingen fra Boligmappa",
        detail: "Det som allerede er hentet blir liggende. Vi prøver videre der den slapp.",
        action: "Fortsett",
        funnel: 1,
      };
    }
    if (a.properties > 0 && a.firstPropertyId) {
      return {
        kind: "building",
        title: "Legg inn det første bygget",
        detail: "Eiendommen er opprettet. Ett bygg til, så kan agenten begynne.",
        action: "Legg til bygg",
        funnel: 1,
        propertyId: a.firstPropertyId,
      };
    }
    if (a.boligmappa.connected && a.boligmappa.status === "ready") {
      return {
        kind: "property",
        title: "Opprett den første eiendommen",
        detail: "Boligmappa hadde ingen bygg på dette nummeret. Legg inn den første selv.",
        action: "Opprett eiendom",
        funnel: 1,
      };
    }
    return {
      kind: "boligmappa",
      title: "Hent byggene fra Boligmappa",
      detail: "Skriv organisasjonsnummeret. Porteføljen fyller sidebaren, og agenten får noe å jobbe med.",
      action: "Hent byggene",
      funnel: 1,
    };
  }
  if (!a.talked) {
    return {
      kind: "ask",
      title: "Spør agenten om porteføljen",
      detail: `Ett spørsmål om ${a.buildings === 1 ? "bygget" : `de ${a.buildings} byggene`} er nok. Da ser du hva agenten finner, før du bestemmer deg for å betale.`,
      action: "Spør nå",
      funnel: 2,
      prompt: `Hva bør jeg prioritere denne uken? Se på ${a.buildings === 1 ? "bygget" : `de ${a.buildings} byggene`}, dokumentene og service som forfaller.`,
    };
  }
  if (a.billing !== "active" && isAdmin) {
    if (a.billing === "past_due") {
      return {
        kind: "portal",
        title: "Betalingen stoppet",
        detail: "Oppdater kortet, så fortsetter arbeidet i porteføljen.",
        action: "Oppdater betaling",
        funnel: 3,
      };
    }
    return {
      kind: "pay",
      title: "Start abonnementet",
      detail: PLAN_SUMMARY,
      action: "Velg plan",
      funnel: 3,
    };
  }
  if (a.serviceOverdue > 0) {
    const n = a.serviceOverdue;
    return {
      kind: "service",
      title: n === 1 ? "Én komponent har service på overtid" : `${n} komponenter har service på overtid`,
      detail: "Se hva som bør gjøres først.",
      action: "Se service",
      funnel: null,
      componentId: n === 1 ? a.serviceComponentId : null,
    };
  }
  return null;
}

export function useNextAction() {
  const { isAdmin, canEdit, limited } = useOrg();
  const q = useOrgQuery<Activation>("/activation");
  // Oppstartsstegene handler om å bygge opp porteføljen – ikke for dem med lese- eller begrenset tilgang
  return { ...q, step: q.data && canEdit && !limited ? nextAction(q.data, isAdmin) : null };
}

function Pips({ current }: { current: number }) {
  return (
    <ol className="flex shrink-0 items-center gap-2">
      {FUNNEL.map((label, i) => {
        const done = i < current;
        const here = i === current;
        return (
          <li key={label} className={cn("flex items-center gap-1.5 text-[11.5px]", done || here ? "text-ink" : "text-muted")}>
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full",
                done ? "bg-accent text-accent-ink" : here ? "bg-ink text-bg" : "bg-panel-3 text-muted",
              )}
            >
              {done ? <Check className="size-2.5" /> : <span className="text-[10px] leading-none">{i + 1}</span>}
            </span>
            <span className={cn(here ? "font-medium" : "hidden sm:inline")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Kjører handlingen for steget. Brukes både i stripen og på forsiden. */
export function useRunStep() {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const panel = useAgentPanel();
  const call = useOrgApi();
  const toast = useToast();
  const [property, setProperty] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (step: NextAction) => {
    if (step.kind === "ask") {
      panel.ask(step.prompt ?? ASK, { newConversation: true });
      return;
    }
    if (step.kind === "property") {
      setProperty(true);
      return;
    }
    if (step.kind === "building" && step.propertyId) {
      navigate(`/o/${orgId}/properties/${step.propertyId}`);
      return;
    }
    if (step.kind === "service") {
      navigate(step.componentId ? `/o/${orgId}/components/${step.componentId}` : `/o/${orgId}/components?forfalt=1`);
      return;
    }
    if (step.kind === "pay") {
      navigate(`/o/${orgId}/abonnement#planer`);
      return;
    }
    if (step.kind === "portal") {
      setBusy(true);
      try {
        const res = await call<{ url: string }>("/billing/portal", { method: "POST" });
        window.location.href = res.url;
      } catch (err) {
        toast(err instanceof Error ? err.message : "Kunne ikke åpne betaling", "bad");
        setBusy(false);
      }
      return;
    }
    navigate(`/o/${orgId}/boligmappa`);
  };

  const modal = <PropertyFormModal open={property} onClose={() => setProperty(false)} />;
  return { run, busy, modal };
}

/** Kompakt neste-steg øverst på alle sider unntatt forsiden, der løpet vises større. */
export function NextStepBar() {
  const { orgId, isAdmin } = useOrg();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { step, data } = useNextAction();
  const { run, busy, modal } = useRunStep();
  const navigate = useNavigate();
  const onHome = location.pathname === `/o/${orgId}`;
  const paid = params.get("billing") === "ok";

  useEffect(() => {
    if (params.get("billing") !== "avbrutt") return;
    toast("Betalingen ble avbrutt. Du kan starte den igjen når du vil.", "neutral");
    params.delete("billing");
    setParams(params, { replace: true });
  }, [params, setParams, toast]);

  const clearPaid = () => {
    params.delete("billing");
    setParams(params, { replace: true });
  };

  if (paid) {
    return (
      <>
        <div className="sticky top-0 z-20 border-b border-line bg-panel">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">Abonnementet er i gang</div>
              <div className="text-[12.5px] text-muted">Plan, AI-bruk og grense finner du under Abonnement og bruk.</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  clearPaid();
                  void run({ kind: "ask", title: "", detail: "", action: "", funnel: 2, prompt: ASK });
                }}
              >
                Spør agenten
                <ArrowRight className="size-3.5" />
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  clearPaid();
                  navigate(`/o/${orgId}/settings`);
                }}
              >
                Inviter kollegaer
              </Button>
            </div>
          </div>
        </div>
        {modal}
      </>
    );
  }

  if (!step && isAdmin && data?.billing === "active" && data.monthInvoiceOre > 0) {
    return (
      <>
        <div className="border-b border-line bg-panel px-4 py-2 text-[12.5px] text-muted sm:px-5">
          AI-bruk denne måneden: <span className="font-medium text-ink">{formatOre(data.monthInvoiceOre)}</span> inkl. mva på neste faktura.{" "}
          <Link className="underline" to={`/o/${orgId}/abonnement`}>
            Se grunnlaget
          </Link>
        </div>
        {modal}
      </>
    );
  }

  if (!step || (onHome && step.funnel != null)) return modal;

  return (
    <>
      <div className="sticky top-0 z-20 border-b border-line bg-panel/95 backdrop-blur-sm">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          {step.funnel != null && <Pips current={step.funnel} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium">{step.title}</div>
            <div className="truncate text-[12.5px] text-muted">{step.detail}</div>
          </div>
          {step.kind === "service" ? (
            <ButtonLink
              to={step.componentId ? `/o/${orgId}/components/${step.componentId}` : `/o/${orgId}/components?forfalt=1`}
              variant="primary"
              size="sm"
              className="shrink-0"
            >
              {step.action}
              <ArrowRight className="size-3.5" />
            </ButtonLink>
          ) : (
            <Button variant="primary" size="sm" className="shrink-0" loading={busy && step.kind === "portal"} onClick={() => void run(step)}>
              {step.action}
              <ArrowRight className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {modal}
    </>
  );
}

export function Journey({ onDemo, seeding }: { onDemo?: () => void; seeding?: boolean }) {
  const { data, step } = useNextAction();
  const { isAdmin } = useOrg();
  const { run, busy, modal } = useRunStep();
  if (!step || step.funnel == null) return null;
  const empty = (data?.buildings ?? 0) === 0;

  return (
    <>
      <section className="mb-6 overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="border-b border-line px-5 py-4">
          <Pips current={step.funnel} />
        </div>
        <div className="px-5 py-5">
          <h2 className="text-[18px] font-semibold tracking-tight">{step.title}</h2>
          <p className="mt-1 max-w-xl text-[14px] text-ink-2">{step.detail}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} onClick={() => void run(step)}>
              {step.action}
              <ArrowRight className="size-4" />
            </Button>
            {empty && step.kind !== "property" && (
              <Button variant="ghost" onClick={() => void run({ ...step, kind: "property" })}>
                Opprett eiendom i stedet
              </Button>
            )}
            {empty && isAdmin && onDemo && (
              <Button variant="ghost" loading={seeding} onClick={onDemo}>
                Se en demoportefølje
              </Button>
            )}
          </div>
        </div>
      </section>
      {modal}
    </>
  );
}
