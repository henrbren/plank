import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, FileText, FolderTree, RefreshCw } from "lucide-react";
import type { BmBuilding, BmDocument, BmEstate, BmTree } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { api } from "@/lib/api";
import { formatArea, formatDateTime, formatOrgNr } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Stat, Tabs, useConfirm, useToast } from "@/components/ui";

type Tab = "overview" | "buildings" | "documents";

interface SyncStep {
  status: string;
  phase: string;
  page: number;
  error: string | null;
  waited?: boolean;
  retryInMs?: number | null;
}
interface ImportStep {
  createdProperties: number;
  createdBuildings: number;
  importedDocuments: number;
  remainingDocuments: number;
  message: string | null;
  done: boolean;
}

function phaseLabel(tree: BmTree): string {
  if (tree.status === "ready") return "Klar til å ta inn";
  if (tree.status === "error") return tree.error || "Hentingen stoppet. Trykk Oppdater for å fortsette.";
  if (tree.phase === "buildings") return "Henter bygg …";
  if (tree.phase === "properties") return "Henter leiligheter …";
  if (tree.phase === "documents") return "Henter dokumentlister …";
  return "Henter fra Boligmappa …";
}

export function BoligmappaPage() {
  const { orgId, isAdmin } = useOrg();
  const qc = useQueryClient();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = ((params.get("tab") as Tab) || "overview") as Tab;
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const q = useOrgQuery<BmTree>("/boligmappa");
  const [orgNr, setOrgNr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refreshTree = async () => {
    const next = await api<BmTree>(`/orgs/${orgId}/boligmappa`);
    qc.setQueryData(["org", orgId, "/boligmappa"], next);
    void qc.invalidateQueries({ queryKey: ["org", orgId, "/activation"] });
    return next;
  };

  const runSync = async (restart: boolean, nr?: string) => {
    setBusy("sync");
    try {
      if (nr) {
        const res = await call<{ agentsGranted?: number }>("/boligmappa", { method: "PUT", body: { orgNr: nr } }, false);
        if (res.agentsGranted) toast(`Koblet til. ${res.agentsGranted} agenter kan nå lese Boligmappa.`);
      }
      let guard = 0;
      let waits = 0;
      let restarting = restart;
      for (;;) {
        const step = await call<SyncStep>("/boligmappa/sync", { body: { restart: restarting } }, false);
        restarting = false;
        await refreshTree();
        if (step.waited) {
          waits += 1;
          if (waits >= 8) {
            toast("Boligmappa svarer ikke nå. Det som er hentet ligger her, og vi prøver igjen i bakgrunnen.", "bad");
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(10_000, Math.max(1_500, step.retryInMs ?? 2_000))));
        } else waits = 0;
        if (step.status === "error") {
          toast(step.error || "Hentingen stoppet", "bad");
          break;
        }
        if (step.status === "ready" || ++guard > 400) break;
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke hente fra Boligmappa", "bad");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (
      !(await confirm({
        title: "Koble fra Boligmappa?",
        message: "Bygg og dokumenter som allerede er hentet inn, blir stående. Agentene mister tilgangen til Boligmappa-cachen.",
        confirm: "Koble fra",
        danger: true,
      }))
    )
      return;
    await call("/boligmappa", { method: "DELETE" });
    toast("Boligmappa er koblet fra");
  };

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const tree = q.data;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      {dialog}
      <PageHeader
        icon={<FolderTree className="size-5" />}
        title="Boligmappa"
        subtitle={tree.orgNr ? `${formatOrgNr(tree.orgNr)} · ${phaseLabel(tree)}` : "Bygg og dokumenter fra Boligmappa, slik agentene kan bruke dem."}
        actions={
          tree.orgNr && isAdmin ? (
            <>
              <Button icon={<RefreshCw className="size-4" />} loading={busy === "sync"} onClick={() => void runSync(tree.status === "ready")}>
                Oppdater
              </Button>
              <Button variant="ghost" onClick={() => void disconnect()}>
                Koble fra
              </Button>
            </>
          ) : null
        }
      />

      {!tree.configured && <EmptyState title="Boligmappa er ikke satt opp på serveren" description="Nøklene mangler. Når de er satt, kan du hente porteføljen hit og la agentene bruke den." />}

      {tree.configured && !tree.orgNr && (
        <div className="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="text-[16px] font-semibold">Koble organisasjonen til Boligmappa</h2>
            <p className="mt-1.5 mb-5 text-[13.5px] text-ink-2">
              Du skriver organisasjonsnummeret. Agentene får samme oversikt som deg – bygg, boenheter og dokumenter.
            </p>
            {isAdmin ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSync(true, orgNr);
                }}
              >
                <Field label="Organisasjonsnummer" hint="Ni siffer. Det står på en faktura, eller du søker opp firmanavnet hos Brønnøysund.">
                  <Input value={orgNr} inputMode="numeric" autoComplete="off" placeholder="999 999 999" onChange={(e) => setOrgNr(e.target.value)} />
                </Field>
                <Button className="mt-4" variant="primary" type="submit" loading={busy === "sync"}>
                  Hent byggene
                </Button>
              </form>
            ) : (
              <p className="text-[13.5px] text-muted">En administrator må koble til Boligmappa.</p>
            )}
          </div>
          <aside className="rounded-2xl border border-line bg-panel-2 p-5 text-[13.5px] leading-relaxed text-ink-2">
            <div className="font-semibold text-ink">Hva agentene kan gjøre</div>
            <ul className="mt-3 space-y-2">
              <li>Se alle bygg, boenheter og dokumenter i Boligmappa</li>
              <li>Hente bygg og filer inn i Plank</li>
              <li>Finne mangler i dokumentasjonen</li>
              <li>Lage sider som viser levende Boligmappa-data</li>
            </ul>
          </aside>
        </div>
      )}

      {tree.orgNr && tree.status === "error" && (
        <div className="mb-5 rounded-xl border border-warn/30 bg-warn-soft p-4 text-[13.5px] text-warn">
          {tree.error || "Hentingen stoppet."} Trykk Oppdater for at agentene skal få siste versjon.
        </div>
      )}

      {tree.orgNr && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "overview", label: "Oversikt" },
              { value: "buildings", label: "Bygg", count: tree.buildingCount || undefined },
              { value: "documents", label: "Dokumenter", count: tree.documentCount || undefined },
            ]}
          />
          {tab === "overview" && <Overview tree={tree} syncing={busy === "sync"} onAsk={(prompt) => panel.ask(prompt, { newConversation: true })} />}
          {tab === "buildings" && <Buildings tree={tree} refreshTree={refreshTree} />}
          {tab === "documents" && <Documents tree={tree} refreshTree={refreshTree} />}
        </>
      )}
    </div>
  );
}

function GrantAgents() {
  const call = useOrgApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 text-accent hover:underline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await call<{ changed: number }>("/boligmappa/grant", { method: "POST" });
          toast(r.changed ? `Ga Boligmappa til ${r.changed} agenter` : "Agentene har allerede tilgang");
        } catch (err) {
          toast(err instanceof Error ? err.message : "Kunne ikke gi tilgang", "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      Gi de andre tilgang
    </button>
  );
}

function Overview({ tree, syncing, onAsk }: { tree: BmTree; syncing: boolean; onAsk: (q: string) => void }) {
  const pending = Math.max(0, tree.buildingCount - tree.imported.buildings);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 @xl:grid-cols-4">
        <Stat label="Bygg" value={tree.buildingCount} hint={syncing ? "Henter …" : `${tree.imported.buildings} i Plank`} />
        <Stat label="Boenheter" value={tree.unitCount} />
        <Stat label="Dokumenter" value={tree.documentCount} hint={`${tree.imported.documents} hentet inn`} />
        <Stat label="Venter" value={pending} hint="Bygg som ikke er i Plank ennå" />
      </div>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Hva agenten kan ta tak i</h2>
            <Button size="sm" variant="ghost" onClick={() => onAsk("Hva mangler i dokumentasjonen fra Boligmappa? Prioriter bygg som er hentet inn, og det som rammer sikkerhet og drift.")}>
              La agenten prioritere
            </Button>
          </div>
          <ul className="divide-y divide-line text-[13.5px]">
            <li className="flex items-start justify-between gap-3 py-2.5">
              <span>
                <span className="block font-medium">{pending === 1 ? "Ett bygg venter" : `${pending} bygg venter`}</span>
                <span className="block text-[12.5px] text-muted">Huk av dem under Bygg, eller be agenten hente dem inn.</span>
              </span>
              <Badge>{pending > 0 ? "Åpent" : "Ferdig"}</Badge>
            </li>
            <li className="flex items-start justify-between gap-3 py-2.5">
              <span>
                <span className="block font-medium">{tree.documentCount} dokumenter i Boligmappa</span>
                <span className="block text-[12.5px] text-muted">{tree.imported.documents} ligger i Plank. Resten hentes med bygget.</span>
              </span>
            </li>
          </ul>
        </section>
        <section className="rounded-2xl border border-line bg-panel p-5 text-[13.5px]">
          <h2 className="text-[15px] font-semibold">Tilkobling</h2>
          <dl className="mt-3 space-y-2 text-ink-2">
            <div>
              <dt className="text-[12px] text-muted">Organisasjonsnummer</dt>
              <dd>{tree.orgNr ? formatOrgNr(tree.orgNr) : "–"}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Sist oppdatert</dt>
              <dd>{tree.updatedAt ? formatDateTime(tree.updatedAt) : "–"}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Hentet inn i Plank</dt>
              <dd>
                {tree.imported.buildings} bygg · {tree.imported.documents} dokumenter
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Agenter med Boligmappa</dt>
              <dd>
                {tree.agents.withTool} av {tree.agents.total}
                {tree.agents.withTool < tree.agents.total && <GrantAgents />}
              </dd>
            </div>
          </dl>
          <Button className="mt-4" variant="primary" onClick={() => onAsk("Hent byggene fra Boligmappa inn i Plank, og lag en side i sidemenyen som viser dokumentdekning per bygg.")}>
            Hent bygg og lag oversikt
          </Button>
        </section>
      </div>
    </div>
  );
}

function Buildings({ tree, refreshTree }: { tree: BmTree; refreshTree: () => Promise<BmTree> }) {
  const { orgId, isAdmin } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    const ids = tree.estates.flatMap((estate) => estate.buildings.filter((b) => !b.importedBuildingId).map((b) => b.bmn));
    if (ids.length === 0) return;
    seeded.current = true;
    setPicked(new Set(ids));
  }, [tree.estates]);

  const estates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tree.estates;
    return tree.estates
      .map((estate) => ({
        ...estate,
        buildings: estate.buildings.filter((b) => `${estate.name} ${b.name} ${b.buildingNumber ?? ""}`.toLowerCase().includes(needle)),
      }))
      .filter((estate) => estate.buildings.length > 0 || estate.name.toLowerCase().includes(needle));
  }, [tree.estates, filter]);

  const runImport = async () => {
    const bmns = [...picked];
    if (bmns.length === 0) return;
    setBusy(true);
    try {
      let buildings = 0;
      let docs = 0;
      for (;;) {
        const step = await call<ImportStep>("/boligmappa/import", { body: { bmns } }, false);
        buildings += step.createdBuildings;
        docs += step.importedDocuments;
        await refreshTree();
        if (step.createdProperties || step.createdBuildings || step.importedDocuments) {
          await qc.invalidateQueries({ queryKey: ["org", orgId, "/portfolio/tree"] });
          await qc.invalidateQueries({ queryKey: ["org", orgId, "/overview"] });
        }
        if (step.message) {
          toast(step.message, "bad");
          break;
        }
        if (step.done) {
          toast(buildings || docs ? `Hentet ${buildings} bygg og ${docs} dokumenter` : "Alt var allerede hentet inn");
          setPicked(new Set());
          break;
        }
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke hente bygg", "bad");
    } finally {
      setBusy(false);
    }
  };

  const toggleBuilding = (bmn: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(bmn)) next.delete(bmn);
      else next.add(bmn);
      return next;
    });
  };

  const toggleEstate = (estate: BmEstate) => {
    const ids = estate.buildings.map((b) => b.bmn);
    const allOn = ids.every((id) => picked.has(id));
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (allOn) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (tree.estates.length === 0) {
    return (
      <EmptyState
        icon={<Building2 className="size-5" />}
        title={tree.status === "ready" ? "Ingen bygg funnet" : "Henter hierarkiet"}
        description={tree.status === "ready" ? "Boligmappa hadde ingen bygg på dette nummeret." : "Byggene vises her om litt."}
      />
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input value={filter} placeholder="Filtrer på adresse eller bygg" onChange={(e) => setFilter(e.target.value)} className="sm:max-w-xs" />
        <div className="flex-1" />
        {isAdmin && (
          <Button variant="primary" disabled={picked.size === 0} loading={busy} onClick={() => void runImport()}>
            {picked.size ? `Hent ${picked.size} bygg` : "Huk av byggene"}
          </Button>
        )}
      </div>
      <div className="grid gap-3 @xl:grid-cols-2">
        {estates.map((estate) => {
          const ids = estate.buildings.map((b) => b.bmn);
          const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
          const open = openKey === estate.key;
          return (
            <div key={estate.key} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-start gap-3">
                {isAdmin && (
                  <button
                    type="button"
                    aria-label={allOn ? "Fjern" : "Velg"}
                    onClick={() => toggleEstate(estate)}
                    className={`mt-0.5 flex size-5 items-center justify-center rounded border ${allOn ? "border-ink bg-ink text-bg" : "border-line-strong"}`}
                  >
                    {allOn && <Check className="size-3" />}
                  </button>
                )}
                <span className="flex size-10 items-center justify-center rounded-lg bg-info-soft text-info">
                  <Building2 className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">
                    {estate.importedPropertyId ? (
                      <Link to={`/o/${orgId}/properties/${estate.importedPropertyId}`} className="hover:underline">
                        {estate.name}
                      </Link>
                    ) : (
                      estate.name
                    )}
                  </div>
                  <div className="text-[12.5px] text-muted">
                    {[estate.postalCode, estate.city].filter(Boolean).join(" ")}
                    {estate.gnr ? ` · gnr. ${estate.gnr}/bnr. ${estate.bnr ?? "–"}` : ""}
                  </div>
                  <div className="mt-1 text-[12.5px] text-ink-2">
                    {estate.buildings.length} bygg · {estate.documents} dokumenter
                    {estate.importedPropertyId ? (
                      <span className="ml-2 text-accent">I Plank</span>
                    ) : (
                      <span className="ml-2 text-muted">Ikke hentet inn</span>
                    )}
                  </div>
                  <button type="button" className="mt-1 text-[12.5px] text-accent hover:underline" onClick={() => setOpenKey(open ? null : estate.key)}>
                    {open ? "Skjul bygg" : "Vis bygg"}
                  </button>
                  {open && (
                    <ul className="mt-2 space-y-1.5 text-[12.5px]">
                      {estate.buildings.map((b) => (
                        <BuildingRow key={b.bmn} building={b} picked={picked.has(b.bmn)} onToggle={() => toggleBuilding(b.bmn)} />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BuildingRow({ building, picked, onToggle }: { building: BmBuilding; picked: boolean; onToggle: () => void }) {
  const { orgId, isAdmin } = useOrg();
  return (
    <li className="flex items-start gap-2">
      {isAdmin && !building.importedBuildingId && (
        <button
          type="button"
          aria-label={picked ? "Fjern" : "Velg"}
          onClick={onToggle}
          className={`mt-0.5 flex size-4 items-center justify-center rounded border ${picked ? "border-ink bg-ink text-bg" : "border-line-strong"}`}
        >
          {picked && <Check className="size-2.5" />}
        </button>
      )}
      <span className="min-w-0">
        {building.importedBuildingId ? (
          <Link to={`/o/${orgId}/buildings/${building.importedBuildingId}`} className="font-medium hover:underline">
            {building.name}
          </Link>
        ) : (
          <span className="font-medium">{building.name}</span>
        )}
        <span className="text-muted">
          {" "}
          ·{" "}
          {[building.buildingType, building.buildingNumber && `nr. ${building.buildingNumber}`, building.area ? formatArea(building.area) : null, `${building.documentCount} dokumenter`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </li>
  );
}

function Documents({ tree, refreshTree }: { tree: BmTree; refreshTree: () => Promise<BmTree> }) {
  const { orgId, isAdmin } = useOrg();
  const buildings = tree.estates.flatMap((e) => e.buildings);
  const [building, setBuilding] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const call = useOrgApi();
  const toast = useToast();
  const qc = useQueryClient();
  const path = `/boligmappa/documents${building ? `?building=${encodeURIComponent(building)}` : ""}`;
  const docs = useOrgQuery<BmDocument[]>(path);

  const runImport = async () => {
    const bmns = building ? [building] : [...picked];
    if (bmns.length === 0) return;
    setBusy(true);
    try {
      let docsCount = 0;
      for (;;) {
        const step = await call<ImportStep>("/boligmappa/import", { body: { bmns } }, false);
        docsCount += step.importedDocuments;
        await refreshTree();
        await qc.invalidateQueries({ queryKey: ["org", orgId, path] });
        if (step.message) {
          toast(step.message, "bad");
          break;
        }
        if (step.done) {
          toast(docsCount ? `Hentet ${docsCount} dokumenter` : "Ingen nye dokumenter");
          setPicked(new Set());
          break;
        }
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke hente dokumenter", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="h-9 min-w-52 rounded-lg border border-line-strong bg-panel px-2 text-[13px]"
          value={building}
          onChange={(e) => {
            setBuilding(e.target.value);
            setPicked(new Set());
          }}
        >
          <option value="">Alle bygg</option>
          {buildings.map((b) => (
            <option key={b.bmn} value={b.bmn}>
              {b.name}
            </option>
          ))}
        </select>
        {isAdmin && (building || picked.size > 0) && (
          <Button variant="primary" loading={busy} onClick={() => void runImport()}>
            {building ? "Hent dokumentene" : `Hent ${picked.size} bygg`}
          </Button>
        )}
      </div>
      {docs.isLoading && <Loading />}
      {docs.data && docs.data.length === 0 && <EmptyState icon={<FileText className="size-5" />} title="Ingen dokumenter" description="Oppdater fra Boligmappa, eller velg et annet bygg." />}
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {docs.data?.map((n) => (
          <li key={n.remoteId} className="flex items-center gap-3 px-4 py-2.5">
            {!n.importedDocumentId && !building && (
              <input
                type="checkbox"
                className="size-4 accent-current"
                checked={picked.has(n.ownerBmn)}
                onChange={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.ownerBmn)) next.delete(n.ownerBmn);
                    else next.add(n.ownerBmn);
                    return next;
                  })
                }
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{n.title}</span>
              <span className="block text-[12.5px] text-muted">{[n.ownerName, n.category, n.filename].filter(Boolean).join(" · ")}</span>
            </span>
            {n.importedDocumentId ? (
              <Link to={`/o/${orgId}/documents/${n.importedDocumentId}`} className="text-[12.5px] text-accent hover:underline">
                I Plank
              </Link>
            ) : n.error ? (
              <span className="text-[12.5px] text-bad">{n.error}</span>
            ) : (
              <span className="text-[12.5px] text-muted">Ikke hentet</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
