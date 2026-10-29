import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Check, FileText, TriangleAlert } from "lucide-react";
import type { AutoImportStep, BmTree } from "@shared/types";
import { Logo } from "@/components/domain";
import { Button, cn, Loading, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/app";
import { useBrand } from "@/lib/brand";
import { formatOrgNr } from "@/lib/format";

const flagKey = (orgId: string) => `plank-auto:${orgId}`;

function setFlag(orgId: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(flagKey(orgId), "1");
    else sessionStorage.removeItem(flagKey(orgId));
  } catch {
    /* ignorer */
  }
}

function hasFlag(orgId: string): boolean {
  try {
    return sessionStorage.getItem(flagKey(orgId)) === "1";
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REFRESH = /^\/(portfolio|overview|documents|boligmappa|activation)/;

function refreshOrg(qc: QueryClient, orgId: string) {
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "org" && q.queryKey[1] === orgId && typeof q.queryKey[2] === "string" && REFRESH.test(q.queryKey[2]),
  });
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Kjører automatisk henting fra Boligmappa steg for steg så lenge komponenten er montert */
function useAutoImport(orgId: string, enabled: boolean, refreshEvery: number) {
  const qc = useQueryClient();
  const [step, setStep] = useState<AutoImportStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastRefresh = 0;
    let force = attempt > 0;
    void (async () => {
      let failures = 0;
      while (!cancelled) {
        try {
          const s = await api<AutoImportStep>(`/orgs/${orgId}/boligmappa/auto${force ? "?force=1" : ""}`, { method: "POST" });
          force = false;
          if (cancelled) return;
          failures = 0;
          setStep(s);
          setError(null);
          const finished = s.stage === "done" || s.stage === "off" || s.stage === "error";
          if (finished || Date.now() - lastRefresh > refreshEvery) {
            lastRefresh = Date.now();
            refreshOrg(qc, orgId);
          }
          if (finished) {
            if (s.stage !== "error") setFlag(orgId, false);
            return;
          }
          await sleep(s.waited ? clamp(s.retryInMs ?? 2_000, 1_500, 15_000) : 250);
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            setFlag(orgId, false);
            setError(err.message);
            return;
          }
          failures++;
          if (failures >= 6) {
            setError(err instanceof Error ? err.message : "Hentingen stoppet");
            return;
          }
          await sleep(clamp(2_000 * 2 ** (failures - 1), 2_000, 20_000));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, enabled, attempt, refreshEvery, qc]);

  return {
    step,
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}

function level(step: AutoImportStep | null): number {
  if (!step) return 0;
  if (step.stage === "done") return 3;
  if (step.stage === "import" || step.importedDocuments > 0) return 2;
  if (step.phase === "buildings") return 0;
  return step.phase === "done" ? 2 : 1;
}

function StepRow({ index, current, title, detail }: { index: number; current: number; title: string; detail?: string | null }) {
  const done = current > index;
  const active = current === index;
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold",
          done ? "border-accent bg-accent text-white" : active ? "border-accent text-accent" : "border-line text-muted",
        )}
      >
        {done ? <Check className="size-3.5" /> : active ? <Spinner className="size-3.5" /> : index + 1}
      </span>
      <span className="min-w-0">
        <span className={cn("block text-[14.5px]", done || active ? "font-medium text-ink" : "text-muted")}>{title}</span>
        {detail && <span className="block text-[13px] text-muted">{detail}</span>}
      </span>
    </li>
  );
}

function Count({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12.5px] text-muted [&>svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[24px] font-semibold tabular-nums tracking-tight">{value.toLocaleString("nb-NO")}</div>
    </div>
  );
}

/** Trakten etter første innlogging på LAFT-domenene: henter bygg og dokumenter fra Boligmappa mens kunden ser på. */
export function FunnelPage() {
  const { orgId = "" } = useParams();
  const me = useMe();
  const brand = useBrand();
  const navigate = useNavigate();
  const org = me.data?.orgs.find((o) => o.id === orgId);
  const { step, error, retry } = useAutoImport(orgId, Boolean(org), 3000);
  const tree = useQuery({
    queryKey: ["org", orgId, "/boligmappa"],
    queryFn: () => api<BmTree>(`/orgs/${orgId}/boligmappa`),
    enabled: Boolean(org),
  });

  useEffect(() => {
    if (org) setFlag(org.id, true);
  }, [org]);

  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  if (!org) return <Navigate to="/" replace />;

  const workspace = `/o/${org.id}?welcome=1`;
  if (step?.stage === "off") return <Navigate to={workspace} replace />;

  const current = level(step);
  const done = step?.stage === "done";
  const failed = step?.stage === "error" || Boolean(error);
  const imported = step?.importedDocuments ?? 0;
  const remaining = step?.remainingDocuments ?? null;
  const progress = done ? 1 : remaining != null && imported + remaining > 0 ? imported / (imported + remaining) : 0;
  const estates = tree.data?.estates ?? [];
  const empty = done && (step?.buildingCount ?? 0) === 0 && estates.length === 0;
  const orgNr = tree.data?.orgNr;

  return (
    <div className="min-h-full bg-bg">
      <div className="mx-auto flex max-w-2xl flex-col px-6 py-8">
        <Logo />
        <div className="mt-14">
          <div className="text-[12.5px] font-semibold tracking-wide text-accent uppercase">Velkommen til {brand.name}</div>
          <h1 className="mt-2 text-[28px] leading-tight font-semibold tracking-tight">
            {empty ? "Ingen bygg i Boligmappa ennå" : done ? "Arkivet er klart" : "Vi henter dokumentene fra Boligmappa"}
          </h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">
            {empty
              ? `Boligmappa har ingen bygg registrert på ${org.name}${orgNr ? ` (${formatOrgNr(orgNr)})` : ""}. Du kan legge inn eiendommer selv, eller hente dem fra LAFT.`
              : done
                ? `${imported.toLocaleString("nb-NO")} dokumenter i ${(step?.importedBuildings ?? 0).toLocaleString("nb-NO")} bygg ligger nå i arkivet til ${org.name}.`
                : `Alt som er registrert på ${org.name} hos Boligmappa kommer inn av seg selv. Du kan gå inn i arkivet når som helst. Hentingen fortsetter mens du jobber.`}
          </p>
        </div>

        <ol className="mt-8 space-y-4">
          <StepRow index={0} current={current} title="Finner bygg" detail={current > 0 ? `${(step?.buildingCount ?? 0).toLocaleString("nb-NO")} bygg` : null} />
          <StepRow
            index={1}
            current={current}
            title="Teller leiligheter og dokumenter"
            detail={current > 1 || step?.phase === "documents" ? `${(step?.documentCount ?? 0).toLocaleString("nb-NO")} dokumenter` : null}
          />
          <StepRow index={2} current={current} title="Legger dokumentene inn i arkivet" detail={current >= 2 ? `${imported.toLocaleString("nb-NO")} hentet` : null} />
        </ol>

        <div className="mt-8 grid grid-cols-3 gap-2.5">
          <Count icon={<Building2 />} label="Bygg i Boligmappa" value={step?.buildingCount ?? 0} />
          <Count icon={<FileText />} label="Dokumenter" value={step?.documentCount ?? 0} />
          <Count icon={<Check />} label="I arkivet" value={imported} />
        </div>
        {current >= 2 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-3">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}

        {step?.message && !failed && <p className="mt-4 rounded-xl border border-line bg-panel-2 px-3.5 py-2.5 text-[13.5px] text-ink-2">{step.message}</p>}
        {failed && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-warn bg-warn-soft px-3.5 py-3 text-[13.5px]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="flex-1">
              <div className="font-medium">Hentingen stoppet</div>
              <div className="text-ink-2">{error || step?.message || "Boligmappa svarte ikke som ventet."}</div>
            </div>
            <Button size="sm" onClick={retry}>
              Prøv igjen
            </Button>
          </div>
        )}

        {estates.length > 0 && (
          <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold tracking-wide text-muted uppercase">Fra Boligmappa</div>
            <ul className="divide-y divide-line">
              {estates.slice(0, 8).map((e) => {
                const inArchive = e.buildings.length > 0 && e.buildings.every((b) => b.importedBuildingId);
                return (
                  <li key={e.key} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">
                      <Building2 className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{e.name}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {[e.address, e.city].filter(Boolean).join(", ") || "Uten adresse"} · {e.buildings.length} bygg · {e.documents.toLocaleString("nb-NO")} dokumenter
                      </span>
                    </span>
                    {inArchive ? (
                      <span className="flex items-center gap-1 text-[12.5px] font-medium text-accent">
                        <Check className="size-3.5" />I arkivet
                      </span>
                    ) : current >= 2 ? (
                      <Spinner className="size-3.5 text-muted" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {estates.length > 8 && <div className="border-t border-line px-4 py-2.5 text-[13px] text-muted">og {estates.length - 8} eiendommer til</div>}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={() => navigate(workspace)}>
            {done ? "Åpne arkivet" : "Gå til arkivet"}
            <ArrowRight className="size-4" />
          </Button>
          {empty && (
            <Link to={`/o/${org.id}/laft`} className="text-[13.5px] text-muted hover:text-ink">
              Hent fra LAFT i stedet
            </Link>
          )}
          {!done && !failed && <span className="text-[13px] text-muted">Hentingen fortsetter i bakgrunnen.</span>}
        </div>
      </div>
    </div>
  );
}

/** Liten statuslinje i sidepanelet som fortsetter hentingen etter at kunden har gått ut av trakten */
export function BackgroundImport({ orgId }: { orgId: string }) {
  const [enabled] = useState(() => hasFlag(orgId));
  const { step, error } = useAutoImport(orgId, enabled, 8000);
  if (!enabled || !step || step.stage === "done" || step.stage === "off") return null;
  if (error || step.stage === "error") {
    return (
      <Link to={`/o/${orgId}/boligmappa`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-warn hover:bg-panel-2">
        <TriangleAlert className="size-3.5" />
        Boligmappa-hentingen stoppet
      </Link>
    );
  }
  return (
    <Link to={`/o/${orgId}/boligmappa`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-panel-2">
      <Spinner className="size-3.5 text-accent" />
      <span className="flex-1">Henter fra Boligmappa</span>
      <span className="text-muted tabular-nums">{step.importedDocuments.toLocaleString("nb-NO")} dok.</span>
    </Link>
  );
}
