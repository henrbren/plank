import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CalendarDays, Check, FolderTree, KeyRound, TriangleAlert } from "lucide-react";
import type { LaftBuilding, LaftDashboard, LaftDocumentNode, LaftStatus, LaftWorkOrderList } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { formatDate } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Input, Loading, PageHeader, Stat, Tabs, useConfirm, useToast } from "@/components/ui";
import { LaftLoginForm } from "@/features/laft/LaftLogin";

type Tab = "overview" | "buildings" | "orders" | "documents";

export function LaftPage() {
  const { orgId, isAdmin } = useOrg();
  const qc = useQueryClient();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  const tab = ((params.get("tab") as Tab) || "overview") as Tab;
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const status = useOrgQuery<LaftStatus>("/laft");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["org", orgId] });

  const adopt = async (accountId: string) => {
    setBusy("adopt");
    try {
      const res = await call<{ agentsGranted: number }>("/laft/adopt", { body: { accountId } });
      toast(res.agentsGranted ? `Koblet til. ${res.agentsGranted} agenter kan nå lese LAFT.` : "Koblet til LAFT.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke koble til", "bad");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: "Koble fra LAFT?", message: "Bygg og dokumenter som allerede er hentet inn, blir stående. Agentene mister tilgangen til LAFT.", confirm: "Koble fra", danger: true }))) return;
    await call("/laft", { method: "DELETE" });
    toast("LAFT er koblet fra");
  };

  if (status.isLoading) return <Loading />;
  if (status.error || !status.data) return <ErrorState error={status.error} />;
  const s = status.data;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      {dialog}
      <PageHeader
        icon={<KeyRound className="size-5" />}
        title="LAFT"
        subtitle={s.account ? `${s.account.areaName ?? s.account.serverName} · ${s.account.email}` : "Bygg, arbeidsordrer og dokumentarkiv fra LAFT, slik agentene kan bruke dem."}
        actions={
          s.account && isAdmin ? (
            <Button variant="ghost" onClick={() => void disconnect()}>
              Koble fra
            </Button>
          ) : null
        }
      />

      {!s.configured && <EmptyState title="LAFT er ikke satt opp på serveren" description="LAFT_TOKEN_KEY mangler. Når den er satt, kan du logge inn med LAFT og hente porteføljen hit." />}

      {s.configured && !s.account && (
        <div className="grid gap-6 @xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="text-[16px] font-semibold">Koble organisasjonen til LAFT</h2>
            <p className="mt-1.5 mb-5 text-[13.5px] text-ink-2">
              Du logger inn med din egen LAFT-bruker. Agentene får samme lesetilgang som deg – bygg, arbeidsordrer, rutiner og dokumentarkiv.
            </p>
            {s.available.length > 0 && (
              <div className="mb-5 space-y-2">
                <div className="text-[12px] font-semibold tracking-wide text-muted uppercase">Allerede innlogget</div>
                {s.available.map((a) => (
                  <button
                    key={a.id}
                    disabled={busy === "adopt"}
                    onClick={() => void adopt(a.id)}
                    className="flex w-full items-center justify-between rounded-xl border border-line px-3 py-2.5 text-left hover:border-line-strong"
                  >
                    <span>
                      <span className="block text-[13.5px] font-medium">{a.areaName ?? a.serverName}</span>
                      <span className="block text-[12.5px] text-muted">{a.email}</span>
                    </span>
                    <span className="text-[13px] text-accent">Bruk denne</span>
                  </button>
                ))}
                <div className="pt-2 text-[12.5px] text-muted">Eller logg inn med en annen LAFT-bruker</div>
              </div>
            )}
            <LaftLoginForm
              mode="connect"
              orgId={orgId}
              onDone={(r) => {
                void refresh();
                toast(r.agentsGranted ? `Koblet til. ${r.agentsGranted} agenter kan nå lese LAFT.` : "Koblet til LAFT.");
              }}
            />
          </div>
          <aside className="rounded-2xl border border-line bg-panel-2 p-5 text-[13.5px] leading-relaxed text-ink-2">
            <div className="font-semibold text-ink">Hva agentene kan gjøre</div>
            <ul className="mt-3 space-y-2">
              <li>Se alle bygg, etasjer og rom i LAFT</li>
              <li>Følge arbeidsordrer, rutiner og avvik</li>
              <li>Lese og hente dokumenter fra arkivet</li>
              <li>Lage sider som viser levende LAFT-data</li>
            </ul>
          </aside>
        </div>
      )}

      {s.account && s.account.status === "expired" && (
        <div className="mb-5 rounded-xl border border-warn/30 bg-warn-soft p-4 text-[13.5px] text-warn">
          Tilkoblingen har utløpt. Logg inn på nytt for at agentene skal kunne lese LAFT.
          {isAdmin && (
            <div className="mt-3 max-w-md">
              <LaftLoginForm mode="connect" orgId={orgId} onDone={() => (refresh(), toast("LAFT er koblet til igjen"))} />
            </div>
          )}
        </div>
      )}

      {s.account && s.account.status === "ok" && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "overview", label: "Oversikt" },
              { value: "buildings", label: "Bygg", count: s.imported.buildings || undefined },
              { value: "orders", label: "Arbeidsordrer" },
              { value: "documents", label: "Dokumenter", count: s.imported.documents || undefined },
            ]}
          />
          {tab === "overview" && <Overview status={s} onAsk={(q) => panel.ask(q, { newConversation: true })} />}
          {tab === "buildings" && <Buildings />}
          {tab === "orders" && <Orders />}
          {tab === "documents" && <Documents />}
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
          const r = await call<{ changed: number }>("/laft/grant", { body: { write: false } });
          toast(r.changed ? `Ga LAFT til ${r.changed} agenter` : "Agentene har allerede tilgang");
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

function Overview({ status, onAsk }: { status: LaftStatus; onAsk: (q: string) => void }) {
  const dash = useOrgQuery<LaftDashboard>("/laft/dashboard");
  const orders = useOrgQuery<LaftWorkOrderList>("/laft/work-orders?status=open&past_due=1&first=8");
  const a = status.account!;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 @xl:grid-cols-4">
        <Stat label="Forfalt" value={dash.data?.pastDue ?? "–"} hint="Åpne arbeidsordrer på overtid" />
        <Stat label="Rutiner på overtid" value={dash.data?.pastDueRoutines ?? "–"} />
        <Stat label="Forfaller denne uken" value={dash.data?.dueThisWeek ?? "–"} />
        <Stat label="Uten ansvarlig" value={dash.data?.unassigned ?? "–"} />
      </div>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Forfalt i LAFT</h2>
            <Button size="sm" variant="ghost" onClick={() => onAsk("Hva er det viktigste som er forfalt i LAFT nå? Prioriter sikkerhet og det som rammer driften.")}>
              La agenten prioritere
            </Button>
          </div>
          {orders.isLoading && <Loading />}
          {orders.data?.items.length === 0 && <p className="text-[13.5px] text-muted">Ingenting forfalt akkurat nå.</p>}
          <ul className="divide-y divide-line">
            {orders.data?.items.map((o) => (
              <li key={o.id} className="flex items-start justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium">{o.title}</span>
                  <span className="block text-[12.5px] text-muted">
                    {[o.building?.name, o.place, o.deadline && `frist ${formatDate(Date.parse(o.deadline))}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {o.state && <Badge>{o.state.name}</Badge>}
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-2xl border border-line bg-panel p-5 text-[13.5px]">
          <h2 className="text-[15px] font-semibold">Tilkobling</h2>
          <dl className="mt-3 space-y-2 text-ink-2">
            <div>
              <dt className="text-[12px] text-muted">Område</dt>
              <dd>{a.areaName ?? a.serverName}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Innlogget som</dt>
              <dd>
                {a.name ?? a.email}
                {a.role ? ` · ${a.role}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Hentet inn i Plank</dt>
              <dd>
                {status.imported.buildings} bygg · {status.imported.documents} dokumenter
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-muted">Agenter med LAFT</dt>
              <dd>
                {status.agents.read} leser · {status.agents.write} kan skrive
                {status.agents.read < status.agents.total && <GrantAgents />}
              </dd>
            </div>
          </dl>
          <Button className="mt-4" variant="primary" onClick={() => onAsk("Hent byggene fra LAFT inn i Plank, og lag en side i sidemenyen som viser forfalte arbeidsordrer og service denne uken.")}>
            Hent bygg og lag oversikt
          </Button>
        </section>
      </div>
    </div>
  );
}

function Buildings() {
  const { orgId, isAdmin } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const list = useOrgQuery<LaftBuilding[]>("/laft/buildings");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return (list.data ?? []).filter((b) => !n || `${b.name} ${b.address ?? ""} ${b.city ?? ""}`.toLowerCase().includes(n));
  }, [list.data, filter]);

  const runImport = async () => {
    setBusy(true);
    try {
      let ids = [...picked];
      let created = 0;
      while (ids.length) {
        const step = await call<{ remaining: string[]; createdBuildings: number; createdFloors: number; createdRooms: number; message: string | null }>("/laft/import", { body: { ids } });
        created += step.createdBuildings;
        if (step.message) {
          toast(step.message, "bad");
          break;
        }
        ids = step.remaining;
      }
      toast(created ? `Hentet ${created} bygg fra LAFT` : "Byggene var allerede inne");
      setPicked(new Set());
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke hente bygg", "bad");
    } finally {
      setBusy(false);
    }
  };

  if (list.isLoading) return <Loading />;
  if (list.error) return <ErrorState error={list.error} />;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input value={filter} placeholder="Filtrer på navn eller adresse" onChange={(e) => setFilter(e.target.value)} className="sm:max-w-xs" />
        <div className="flex-1" />
        {isAdmin && (
          <Button variant="primary" disabled={picked.size === 0} loading={busy} onClick={() => void runImport()}>
            {picked.size ? `Hent ${picked.size} bygg` : "Huk av byggene"}
          </Button>
        )}
      </div>
      {shown.length === 0 && <EmptyState title="Ingen bygg i LAFT" description="Brukeren som koblet til, har kanskje ikke tilgang til noen bygg." />}
      <div className="grid gap-3 @xl:grid-cols-2">
        {shown.map((b) => {
          const on = picked.has(b.id);
          return (
            <div key={b.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-start gap-3">
                {isAdmin && !b.plankBuildingId && (
                  <button
                    type="button"
                    aria-label={on ? "Fjern" : "Velg"}
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (on) next.delete(b.id);
                        else next.add(b.id);
                        return next;
                      })
                    }
                    className={`mt-0.5 flex size-5 items-center justify-center rounded border ${on ? "border-ink bg-ink text-bg" : "border-line-strong"}`}
                  >
                    {on && <Check className="size-3" />}
                  </button>
                )}
                <span className="flex size-10 items-center justify-center overflow-hidden rounded-lg bg-info-soft text-info">
                  {b.imageUrl ? <img src={b.imageUrl} alt="" className="size-full object-cover" /> : <Building2 className="size-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{b.name}</div>
                  <div className="text-[12.5px] text-muted">{[b.address, b.zip, b.city].filter(Boolean).join(" ") || b.type || "Bygg"}</div>
                  <div className="mt-1 text-[12.5px] text-ink-2">
                    {b.floors} etasjer · {b.rooms} rom
                    {b.plankBuildingId ? (
                      <Link to={`/o/${orgId}/buildings/${b.plankBuildingId}`} className="ml-2 text-accent hover:underline">
                        I Plank
                      </Link>
                    ) : (
                      <span className="ml-2 text-muted">Ikke hentet inn</span>
                    )}
                  </div>
                  <button type="button" className="mt-1 text-[12.5px] text-accent hover:underline" onClick={() => setOpenId(openId === b.id ? null : b.id)}>
                    {openId === b.id ? "Skjul etasjer" : "Vis etasjer og rom"}
                  </button>
                  {openId === b.id && <BuildingRooms id={b.id} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BuildingRooms({ id }: { id: string }) {
  const q = useOrgQuery<{ floors: { id: string; name: string; rooms: { id: string; name: string; number: string | null; area: number | null }[] }[] }>(`/laft/buildings/${id}`);
  if (q.isLoading) return <div className="mt-2 text-[12.5px] text-muted">Henter …</div>;
  if (!q.data?.floors.length) return <div className="mt-2 text-[12.5px] text-muted">Ingen etasjer lest.</div>;
  return (
    <ul className="mt-2 space-y-1.5 text-[12.5px]">
      {q.data.floors.map((f) => (
        <li key={f.id}>
          <span className="font-medium">{f.name}</span>
          <span className="text-muted"> · {f.rooms.map((r) => (r.number ? `${r.number} ${r.name}` : r.name)).join(", ") || "ingen rom"}</span>
        </li>
      ))}
    </ul>
  );
}

function Orders() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("open");
  const path = `/laft/work-orders?status=${status}&first=40${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
  const list = useOrgQuery<LaftWorkOrderList>(path);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={q} placeholder="Søk i arbeidsordrer" onChange={(e) => setQ(e.target.value)} className="sm:max-w-xs" />
        <select className="h-9 rounded-lg border border-line-strong bg-panel px-2 text-[13px]" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Åpne</option>
          <option value="closed">Lukkede</option>
          <option value="all">Alle</option>
        </select>
      </div>
      {list.isLoading && <Loading />}
      {list.data && list.data.items.length === 0 && <EmptyState icon={<CalendarDays className="size-5" />} title="Ingen arbeidsordrer" />}
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {list.data?.items.map((o) => (
          <li key={o.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <a href={o.url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">
                {o.title}
              </a>
              <span className="block text-[12.5px] text-muted">
                {[o.building?.name, o.place, o.responsible.join(", "), o.deadline && formatDate(Date.parse(o.deadline))].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {o.pastDue && <TriangleAlert className="size-4 text-bad" />}
              {o.state && <Badge>{o.state.name}</Badge>}
            </span>
          </li>
        ))}
      </ul>
      {list.data && list.data.total > list.data.items.length && <p className="mt-3 text-[12.5px] text-muted">{list.data.total} totalt. Be agenten om mer, eller søk mer presist.</p>}
    </div>
  );
}

function Documents() {
  const buildings = useOrgQuery<LaftBuilding[]>("/laft/buildings");
  const [building, setBuilding] = useState("");
  const [parent, setParent] = useState<number | null>(null);
  const [stack, setStack] = useState<{ id: number | null; name: string }[]>([{ id: null, name: "Rot" }]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const call = useOrgApi();
  const toast = useToast();
  const { orgId } = useOrg();
  const path = building ? `/laft/documents?building=${encodeURIComponent(building)}${parent ? `&parent=${parent}` : ""}` : null;
  const nodes = useOrgQuery<LaftDocumentNode[]>(path);

  const open = (n: LaftDocumentNode) => {
    if (!n.isFolder) return;
    setParent(n.id);
    setStack((s) => [...s, { id: n.id, name: n.name }]);
    setPicked(new Set());
  };

  const jump = (i: number) => {
    const next = stack.slice(0, i + 1);
    setStack(next);
    setParent(next[next.length - 1]!.id);
    setPicked(new Set());
  };

  const runImport = async () => {
    setBusy(true);
    try {
      const res = await call<{ imported: { documentId: string }[]; failed: { title: string }[] }>("/laft/documents/import", {
        body: { ids: [...picked], building_id: buildings.data?.find((b) => b.id === building)?.plankBuildingId },
      });
      toast(res.imported.length ? `Hentet ${res.imported.length} dokumenter` : "Ingen nye dokumenter");
      setPicked(new Set());
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
            setParent(null);
            setStack([{ id: null, name: "Rot" }]);
            setPicked(new Set());
          }}
        >
          <option value="">Velg bygg</option>
          {buildings.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {picked.size > 0 && (
          <Button variant="primary" loading={busy} onClick={() => void runImport()}>
            Hent {picked.size} filer
          </Button>
        )}
      </div>
      {building && (
        <div className="mb-3 flex flex-wrap gap-1 text-[12.5px] text-muted">
          {stack.map((s, i) => (
            <button key={`${s.id}-${i}`} type="button" className="hover:text-ink" onClick={() => jump(i)}>
              {s.name}
              {i < stack.length - 1 ? " /" : ""}
            </button>
          ))}
        </div>
      )}
      {!building && <EmptyState icon={<FolderTree className="size-5" />} title="Velg et bygg" description="Da ser du mappene og filene i LAFT-arkivet." />}
      {nodes.isLoading && <Loading />}
      <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
        {nodes.data?.map((n) => (
          <li key={n.id} className="flex items-center gap-3 px-4 py-2.5">
            {!n.isFolder && (
              <input
                type="checkbox"
                className="size-4 accent-current"
                checked={picked.has(n.id)}
                onChange={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.id)) next.delete(n.id);
                    else next.add(n.id);
                    return next;
                  })
                }
              />
            )}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(n)} disabled={!n.isFolder}>
              <span className="block truncate font-medium">{n.name}</span>
              <span className="block text-[12.5px] text-muted">
                {n.isFolder ? `${n.childrenCount} i mappen` : [n.contentType, n.size].filter(Boolean).join(" · ")}
              </span>
            </button>
            {n.plankDocumentId && (
              <Link to={`/o/${orgId}/documents/${n.plankDocumentId}`} className="text-[12.5px] text-accent hover:underline">
                I Plank
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
