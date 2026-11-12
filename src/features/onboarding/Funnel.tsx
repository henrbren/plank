import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Check, Clock, FileText, TriangleAlert } from "lucide-react";
import type { BmTree, TransferStatus } from "@shared/types";
import { Button, Loading, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe, useOrg } from "@/lib/app";
import { formatOrgNr } from "@/lib/format";
import { BmNotifyChoice } from "./BmNotify";
import { WizardShell } from "./Wizard";

function useTransfer(orgId: string, enabled: boolean) {
  const qc = useQueryClient();
  const seen = useRef<number | null>(null);
  const query = useQuery({
    queryKey: ["org", orgId, "/boligmappa/transfer"],
    queryFn: () => api<TransferStatus>(`/orgs/${orgId}/boligmappa/transfer`),
    enabled,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s || s.stage === "off") return false;
      if (s.stage === "done") return false;
      if (s.stage === "error" && !s.active) return false;
      return 2_500;
    },
  });
  const imported = query.data?.importedDocuments;
  useEffect(() => {
    if (imported == null || !orgId) return;
    if (seen.current != null && imported > seen.current) {
      void qc.invalidateQueries({
        predicate: (item) => {
          if (item.queryKey[0] !== "org" || item.queryKey[1] !== orgId) return false;
          const path = String(item.queryKey[2] ?? "");
          if (path.startsWith("/boligmappa")) return false;
          return path.startsWith("/documents") || path.startsWith("/overview") || path.startsWith("/portfolio") || path.startsWith("/activation");
        },
      });
    }
    seen.current = imported;
  }, [imported, orgId, qc]);
  return query;
}

function transferStory(status: TransferStatus | undefined): "run" | "missed" | "partial" | "stopped" | null {
  if (!status || status.stage === "off") return null;
  if (status.stage === "error" && !status.active) return "stopped";
  if (status.stage !== "done") return "run";
  if (status.importedDocuments === 0 && status.failedDocuments > 0 && (status.buildingCount > 0 || status.importedBuildings > 0)) return "missed";
  if (status.failedDocuments > 0 && status.importedDocuments > 0) return "partial";
  return null;
}

/** Liten status i sidepanelet. Den driver ingen henting. Serveren gjør jobben. */
export function BackgroundImport({ orgId }: { orgId: string }) {
  const transfer = useTransfer(orgId, true);
  const step = transfer.data;
  const story = transferStory(step);
  if (!step || !story) return null;
  if (story === "stopped" || story === "missed") {
    return (
      <Link to={`/velkommen/${orgId}`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-warn hover:bg-nav-hover">
        <TriangleAlert className="size-3.5" />
        {story === "missed" ? "Dokumentene kom ikke inn" : "Boligmappa-hentingen stoppet"}
      </Link>
    );
  }
  if (story === "partial") {
    return (
      <Link to={`/o/${orgId}/boligmappa`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-nav-ink-2 hover:bg-nav-hover">
        <TriangleAlert className="size-3.5 text-warn" />
        <span className="flex-1">{antall(step.failedDocuments, "dokument mangler", "dokumenter mangler")}</span>
      </Link>
    );
  }
  const label =
    step.phase === "properties"
      ? "Slår opp boenheter"
      : step.stage === "buildings" && step.buildingCount === 0
        ? "Slår opp bygg"
        : step.stage === "buildings" || step.stage === "import"
          ? "Legger inn bygg"
          : "Henter dokumenter";
  const known = step.documentCount > 0 || step.importedDocuments > 0;
  const figure = known
    ? `${step.importedDocuments.toLocaleString("nb-NO")} av ${Math.max(step.documentCount, step.importedDocuments).toLocaleString("nb-NO")}`
    : step.buildingCount > 0
      ? step.buildingCount.toLocaleString("nb-NO")
      : "";
  return (
    <Link to={`/velkommen/${orgId}`} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-nav-ink-2 hover:bg-nav-hover">
      <Spinner className="size-3.5 text-nav-ink" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {figure && <span className="shrink-0 text-nav-muted tabular-nums">{figure}</span>}
    </Link>
  );
}

/** På forsiden, der e-posten lander. Tallene er filer som faktisk ligger i arkivet. */
export function TransferNotice() {
  const { orgId, org } = useOrg();
  const qc = useQueryClient();
  const transfer = useTransfer(orgId, true);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const status = transfer.data;
  const story = transferStory(status);
  if (!status || !story) return null;
  const canAdmin = org.role === "owner" || org.role === "admin";
  const retry = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      await api(`/orgs/${orgId}/boligmappa/transfer`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["org", orgId, "/boligmappa/transfer"] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Kunne ikke starte på nytt");
    } finally {
      setRetrying(false);
    }
  };
  if (story === "partial") {
    return (
      <p className="mb-4 text-[13.5px] text-muted">
        {antall(status.importedDocuments, "dokument er i arkivet", "dokumenter er i arkivet")}.{" "}
        {antall(status.failedDocuments, "dokument lot seg ikke hente", "dokumenter lot seg ikke hente")}.{" "}
        <Link to={`/o/${orgId}/boligmappa`} className="text-ink underline-offset-2 hover:underline">
          Se Boligmappa
        </Link>
      </p>
    );
  }
  if (story === "run") {
    const total = Math.max(status.documentCount, status.importedDocuments + status.remainingDocuments, status.importedDocuments);
    const progress = total > 0 ? status.importedDocuments / total : 0.12;
    return (
      <div className="mb-6 rounded-2xl border border-line bg-panel px-5 py-4">
        <p className="flex items-start gap-2 text-[14.5px] text-ink">
          <Spinner className="mt-0.5 size-3.5 shrink-0" />
          <span>{workLine(status)}</span>
        </p>
        <div className={`mt-3 h-1.5 overflow-hidden rounded-full bg-panel-3 ${total > 0 ? "" : "animate-pulse"}`}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-6 flex items-start gap-2.5 rounded-2xl border border-warn bg-warn-soft px-5 py-4 text-[14px]">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{story === "missed" ? "Dokumentene kom ikke inn" : "Hentingen stoppet"}</div>
        <p className="mt-1 text-ink-2">
          {actionError ||
            (story === "missed"
              ? `${antall(status.failedDocuments, "dokument", "dokumenter")} lot seg ikke hente. Ingenting ligger i arkivet.`
              : "Det som allerede er inne, blir liggende.")}
        </p>
      </div>
      {canAdmin && (
        <Button size="sm" onClick={() => void retry()} loading={retrying}>
          Prøv igjen
        </Button>
      )}
    </div>
  );
}

function antall(n: number, en: string, flere: string): string {
  return `${n.toLocaleString("nb-NO")} ${n === 1 ? en : flere}`;
}

function Count({ icon, label, value }: { icon: ReactNode; label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-[12.5px] text-muted [&>svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[24px] font-semibold tabular-nums tracking-tight">{value == null ? "…" : value.toLocaleString("nb-NO")}</div>
    </div>
  );
}

/** Hva hentingen gjør akkurat nå. Tallene kommer fra Boligmappa-cachen, før filene er kopiert inn. */
function workLine(status: TransferStatus): string {
  if (status.message && status.retryInMs) {
    const minutes = Math.max(1, Math.round(status.retryInMs / 60_000));
    return `${status.message} Neste forsøk om ${minutes === 1 ? "ett minutt" : `${minutes} minutter`}.`;
  }
  if (status.phase === "properties") {
    return `Fant ${antall(status.buildingCount, "bygg", "bygg")}. Slår opp boenheter.`;
  }
  if (status.phase === "documents" || status.stage === "documents") {
    if (status.documentCount > 0 || status.importedDocuments > 0) {
      const left = status.remainingDocuments > 0 ? ` ${antall(status.remainingDocuments, "dokument gjenstår", "dokumenter gjenstår")}` : "";
      return `Fant ${antall(status.documentCount, "dokument", "dokumenter")}. ${antall(status.importedDocuments, "dokument ligger i arkivet", "dokumenter ligger i arkivet")}.${left ? `${left}.` : ""}`;
    }
    return status.importedBuildings > 0
      ? `${antall(status.importedBuildings, "bygg er inne", "bygg er inne")}. Henter dokumentlistene.`
      : "Henter dokumentlistene.";
  }
  if (status.buildingCount > 0) {
    const placed = status.importedBuildings > 0 ? ` ${antall(status.importedBuildings, "bygg er lagt inn", "bygg er lagt inn")}.` : " Legger dem inn nå.";
    return `Fant ${antall(status.buildingCount, "bygg", "bygg")}.${placed}`;
  }
  return "Slår opp byggene i Boligmappa. Navnene vises her med en gang de kommer.";
}

/** Fremdrift etter at organisasjonen er opprettet. Hentingen er allerede i gang på serveren. */
export function FunnelPage() {
  const { orgId = "" } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const org = me.data?.orgs.find((o) => o.id === orgId);
  const transfer = useTransfer(orgId, Boolean(org));
  const running = transfer.data && transfer.data.stage !== "off" && transfer.data.stage !== "done" && !(transfer.data.stage === "error" && !transfer.data.active);
  const tree = useQuery({
    queryKey: ["org", orgId, "/boligmappa"],
    queryFn: () => api<BmTree>(`/orgs/${orgId}/boligmappa`),
    enabled: Boolean(org) && Boolean(transfer.data && transfer.data.stage !== "off"),
    refetchInterval: running ? 2_500 : false,
  });
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notifyOverride, setNotifyOverride] = useState<boolean | null>(null);
  const [savingNotify, setSavingNotify] = useState(false);

  if (me.isLoading || (org && transfer.isLoading)) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  if (!org) return <Navigate to="/" replace />;

  const status = transfer.data;
  const estates = tree.data?.estates ?? [];
  const buildingsIn = (status?.importedBuildings ?? 0) > 0;
  const done = status?.stage === "done";
  const failed = status?.stage === "error" && !status.active;
  const empty = done && (status?.buildingCount ?? 0) === 0 && (status?.importedBuildings ?? 0) === 0;
  const imported = status?.importedDocuments ?? 0;
  const remaining = status?.remainingDocuments ?? 0;
  const missed = Boolean(done && !empty && imported === 0 && (status?.failedDocuments ?? 0) > 0);
  const listed = imported + remaining;
  const totalsKnown = done || imported > 0 || remaining > 0 || (status?.documentCount ?? 0) > 0;
  const progress = done && !missed ? 1 : listed > 0 ? imported / listed : 0;
  const canAdmin = org.role === "owner" || org.role === "admin";
  const orgNr = tree.data?.orgNr;

  const off = status?.stage === "off";
  const title = off
    ? "Organisasjonen er klar"
    : empty
      ? "Ingen bygg i Boligmappa"
      : done
        ? missed
          ? "Dokumentene kom ikke inn"
          : "Dokumentene er overført"
        : failed
          ? "Hentingen stoppet"
          : buildingsIn
            ? "Byggene er inne"
            : "Vi henter byggene fra Boligmappa";

  const lead = off
    ? status?.configured
      ? "Det er ikke startet noen henting fra Boligmappa. Du kan legge inn eiendommer selv, eller koble til senere."
      : "Boligmappa er ikke koblet til på denne serveren. Du kan legge inn bygg selv."
    : empty
      ? `Boligmappa har ingen bygg på ${org.name}${orgNr ? ` (${formatOrgNr(orgNr)})` : ""}. Du kan legge inn eiendommer selv.`
      : done
        ? missed
          ? canAdmin
            ? "Ingenting ble lagt i arkivet. Trykk Prøv igjen, så henter vi filene på nytt."
            : "Ingenting ble lagt i arkivet. En administrator kan hente filene på nytt."
          : `${antall(imported, "dokument", "dokumenter")} i ${antall(status?.importedBuildings ?? 0, "bygg", "bygg")} ligger i arkivet. ${status?.mailed ? "Vi har sendt deg en e-post." : ""}`
        : failed
          ? "Det som allerede er inne, blir liggende. Trykk Prøv igjen når du vil fortsette."
          : buildingsIn
            ? "Dokumentene kommer inn etterpå. Du kan se porteføljen mens det pågår."
            : `Vi slår opp ${org.name} og legger byggene inn med en gang vi finner dem.`;

  const notifyOn = notifyOverride ?? Boolean(org.bm_notify);
  const setNotify = async (on: boolean) => {
    setNotifyOverride(on);
    setSavingNotify(true);
    setActionError(null);
    try {
      await api(`/orgs/${orgId}/bm-notify`, { method: "PATCH", body: { on } });
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setNotifyOverride(Boolean(org.bm_notify));
      setActionError(err instanceof Error ? err.message : "Kunne ikke lagre valget");
    } finally {
      setSavingNotify(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      await api(`/orgs/${orgId}/boligmappa/transfer`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["org", orgId, "/boligmappa/transfer"] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Kunne ikke starte på nytt");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <WizardShell>
      <p className="text-[12.5px] font-semibold tracking-wide text-accent uppercase">{org.name}</p>
      <h1 className="mt-2 text-[34px] leading-[1.15] font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-ink-2">{lead}</p>
      {running && status && (
        <p className="mt-4 flex items-start gap-2 text-[14.5px] text-ink">
          <Spinner className="mt-0.5 size-3.5 shrink-0" />
          <span>{workLine(status)}</span>
        </p>
      )}
      {status && status.stage !== "off" && status.stage !== "done" && !failed && (
        <p className="mt-3 text-[13.5px] text-muted">Du kan lukke nettleseren. Vi sender en e-post når dokumentene er overført.</p>
      )}
      {status && (
        <div className="mt-6 rounded-2xl border border-line bg-panel">
          <BmNotifyChoice checked={notifyOn} onChange={(on) => void setNotify(on)} disabled={savingNotify} />
        </div>
      )}

      {status && status.stage !== "off" && (
        <>
          <div className="mt-8 grid grid-cols-3 gap-2.5">
            <Count icon={<Building2 />} label="Bygg" value={Math.max(status.importedBuildings, status.buildingCount)} />
            <Count icon={<FileText />} label="I arkivet" value={imported} />
            <Count icon={<Clock />} label="Igjen" value={totalsKnown ? (done ? 0 : remaining) : null} />
          </div>
          <div className={`mt-3 h-1.5 overflow-hidden rounded-full bg-panel-3 ${totalsKnown ? "" : "animate-pulse"}`}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.round((totalsKnown ? progress : 0.12) * 100)}%` }} />
          </div>
          {status.failedDocuments > 0 && !failed && (
            <p className="mt-2 text-[12.5px] text-muted">
              {missed
                ? `${antall(status.failedDocuments, "dokument", "dokumenter")} lot seg ikke hente.`
                : `${antall(status.failedDocuments, "dokument", "dokumenter")} prøves på nytt, eller er lagt til side etter flere forsøk.`}
            </p>
          )}
        </>
      )}

      {(failed || missed || actionError) && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-warn bg-warn-soft px-3.5 py-3 text-[13.5px]">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{missed ? "Ingenting kom inn" : failed ? "Hentingen stoppet" : "Noe gikk galt"}</div>
            <div className="text-ink-2">{actionError || (missed ? (canAdmin ? "Filene blir hentet på nytt. Det som allerede er inne, blir liggende." : "En administrator kan starte hentingen på nytt.") : status?.message || "Prøv igjen. Det som er inne, blir liggende.")}</div>
          </div>
          {canAdmin && (failed || missed) && (
            <Button size="sm" onClick={() => void retry()} loading={retrying}>
              Prøv igjen
            </Button>
          )}
        </div>
      )}

      {status?.message && status.active && status.stage !== "error" && <p className="mt-4 text-[13.5px] text-ink-2">{status.message}</p>}

      {running && estates.length === 0 && (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-[14px] text-ink-2">
          <Spinner className="size-3.5 shrink-0 text-muted" />
          Ingen bygg å vise ennå. Lista fylles så snart Boligmappa svarer.
        </div>
      )}

      {estates.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold tracking-wide text-muted uppercase">Fra Boligmappa</div>
          <ul className="divide-y divide-line">
            {estates.slice(0, 6).map((e) => {
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
                      <Check className="size-3.5" />
                      Inne
                    </span>
                  ) : (
                    <Spinner className="size-3.5 text-muted" />
                  )}
                </li>
              );
            })}
          </ul>
          {estates.length > 6 && <div className="border-t border-line px-4 py-2.5 text-[13px] text-muted">og {estates.length - 6} eiendommer til</div>}
        </div>
      )}

      {(buildingsIn || done || empty || status?.stage === "off") && (
        <Button variant="primary" size="lg" className="mt-8" onClick={() => navigate(`/o/${org.id}`)}>
          {empty || status?.stage === "off" ? "Legg inn selv" : "Se porteføljen"}
          <ArrowRight className="size-4" />
        </Button>
      )}
      {!buildingsIn && !done && !empty && status?.stage !== "off" && (
        <Link to={`/o/${org.id}`} className="mt-8 inline-block text-[13.5px] text-muted hover:text-ink">
          Se det som er inne
        </Link>
      )}
      {empty && (
        <Link to={`/o/${org.id}/laft`} className="mt-4 block text-[13.5px] text-muted hover:text-ink">
          Hent fra LAFT i stedet
        </Link>
      )}
    </WizardShell>
  );
}
