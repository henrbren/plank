import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Box, Building2, DoorOpen, Ellipsis, FileText, LayoutDashboard, Layers, MapPin, Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import type { Artifact, Building, Component, Document, Floor, Property, Room, Task } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatArea, formatDate } from "@/lib/format";
import { Button, Card, CardHeader, cn, EmptyState, ErrorState, IconButton, KeyValues, Loading, Menu, MenuItem, PageHeader, Stat, Tabs, useConfirm, useToast } from "@/components/ui";
import { BuildingFormModal, ComponentFormModal, FloorFormModal, PropertyFormModal, RoomFormModal, TaskFormModal, UploadModal } from "@/components/forms";
import { FloorplanModal } from "@/features/floorplan/FloorplanModal";
import { PlaceCover, PlaceFrame } from "@/features/places/PlacePhoto";
import { ComponentTable, DocumentTable, TableShell, TaskTable } from "@/components/lists";

function useDelete(path: string, label: string, after: string) {
  const call = useOrgApi();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const run = async () => {
    const ok = await confirm({ title: `Slette ${label}?`, message: "Dette kan ikke angres. Underliggende etasjer og rom slettes også.", confirm: "Slett", danger: true });
    if (!ok) return;
    await call(path, { method: "DELETE" });
    navigate(after);
  };
  return { run, dialog };
}

// ─── Eiendom ─────────────────────────────────────────────────────────────────

export function PropertyPage() {
  const { id } = useParams();
  const { orgId, canEdit } = useOrg();
  const q = useOrgQuery<Property & { document_count: number; buildings: (Building & { floor_count: number; open_tasks: number; document_count: number })[] }>(`/portfolio/properties/${id}`);
  const tasks = useOrgQuery<Task[]>(`/tasks?property_id=${id}`);
  useSetFocus("property", id, q.data?.name);
  const panel = useAgentPanel();
  const [edit, setEdit] = useState(false);
  const [newBuilding, setNewBuilding] = useState(false);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const del = useDelete(`/portfolio/properties/${id}`, "eiendommen", `/o/${orgId}`);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const p = q.data!;
  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<MapPin className="size-5" />}
        title={p.name}
        subtitle={[p.address, [p.postal_code, p.city].filter(Boolean).join(" "), p.gnr && `gnr. ${p.gnr}/bnr. ${p.bnr ?? "–"}`].filter(Boolean).join(" · ") || "Eiendom"}
        actions={
          <>
            <Button icon={<Sparkles className="size-4" />} onClick={() => panel.ask(`Gi meg en kort statusoversikt for eiendommen «${p.name}»: bygg, åpne oppgaver, service som forfaller og viktige mangler.`)}>
              Statusoversikt
            </Button>
            {canEdit && (
              <>
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewBuilding(true)}>
                  Nytt bygg
                </Button>
                <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
                  {(close) => (
                    <>
                      <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setEdit(true))}>
                        Rediger
                      </MenuItem>
                      <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), del.run())}>
                        Slett eiendom
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </>
            )}
          </>
        }
      />
      <PlaceCover kind="properties" id={p.id} name={p.name} hasImage={p.has_image} updatedAt={p.updated_at} />
      {p.description && <p className="-mt-2 mb-6 max-w-3xl text-[14px] text-ink-2">{p.description}</p>}

      {p.document_count > 0 && (
        <Link to={`/o/${orgId}/documents?eiendom=${p.id}`} className="mb-6 flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 hover:border-line-strong">
          <FileText className="size-4 shrink-0 text-muted" />
          <span className="text-[14px] font-medium">{p.document_count === 1 ? "Ett dokument" : `${p.document_count} dokumenter`} på eiendommen</span>
        </Link>
      )}

      <h2 className="mb-3 text-[15px] font-semibold">Bygg</h2>
      {p.buildings.length === 0 ? (
        <EmptyState icon={<Building2 className="size-5" />} title="Ingen bygg ennå" description="Legg til byggene på eiendommen for å registrere etasjer, rom og komponenter." action={canEdit ? <Button variant="primary" onClick={() => setNewBuilding(true)}>Nytt bygg</Button> : undefined} />
      ) : (
        <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {p.buildings.map((b) => (
            <Link key={b.id} to={`/o/${orgId}/buildings/${b.id}`} className="group overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-line-strong">
              <PlaceFrame kind="buildings" id={b.id} hasImage={b.has_image} updatedAt={b.updated_at} />
              <div className="p-4">
              <div className="min-w-0">
                <div className="truncate font-semibold">{b.name}</div>
                <div className="text-[12.5px] text-muted">{[b.building_type, b.year_built, b.gross_area && formatArea(b.gross_area)].filter(Boolean).join(" · ") || "Bygg"}</div>
              </div>
              <div className="mt-3 flex gap-4 text-[12.5px] text-ink-2">
                <span>{b.floor_count} etasjer</span>
                <span>{b.document_count} dokumenter</span>
                <span className={b.open_tasks > 0 ? "text-warn" : ""}>{b.open_tasks} åpne oppgaver</span>
              </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {tasks.data && tasks.data.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 text-[15px] font-semibold">Åpne oppgaver</h2>
          <TaskTable tasks={tasks.data} onOpen={setOpenTask} />
        </>
      )}
      <PropertyFormModal open={edit} onClose={() => setEdit(false)} property={p} />
      <BuildingFormModal open={newBuilding} onClose={() => setNewBuilding(false)} propertyId={p.id} />
      <TaskFormModal open={!!openTask} onClose={() => setOpenTask(null)} task={openTask ?? undefined} />
      {del.dialog}
    </div>
  );
}

// ─── Bygg ────────────────────────────────────────────────────────────────────

type BuildingDetail = Building & {
  property_name: string;
  floors: (Floor & { room_count: number; room_area: number | null })[];
  stats: { documents: number; components: number; open_tasks: number; artifacts: number; ifc_models: number } | null;
};

type Tab = "overview" | "documents" | "components" | "tasks" | "bim" | "artifacts";

export function BuildingPage() {
  const { id } = useParams();
  const { orgId, canEdit } = useOrg();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });
  const q = useOrgQuery<BuildingDetail>(`/portfolio/buildings/${id}`);
  useSetFocus("building", id, q.data?.name);
  const panel = useAgentPanel();
  const [modal, setModal] = useState<null | "edit" | "floor" | "plan" | "upload" | "component" | "task">(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const del = useDelete(`/portfolio/buildings/${id}`, "bygget", `/o/${orgId}/properties/${q.data?.property_id ?? ""}`);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const b = q.data!;
  const s = b.stats;
  const nextLevel = b.floors.length ? Math.max(...b.floors.map((f) => f.level)) + 1 : 0;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: b.property_name, to: `/o/${orgId}/properties/${b.property_id}` }]}
        icon={<Building2 className="size-5" />}
        title={b.name}
        subtitle={[b.building_type, b.year_built && `bygget ${b.year_built}`, b.gross_area && `BTA ${formatArea(b.gross_area)}`, b.building_number && `bygningsnr. ${b.building_number}`].filter(Boolean).join(" · ") || "Bygg"}
        actions={
          <>
            {canEdit && (
              <Button icon={<Upload className="size-4" />} onClick={() => setModal("upload")}>
                Last opp
              </Button>
            )}
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => panel.ask(`Oppsummer status for bygget «${b.name}»: åpne oppgaver og avvik, service som forfaller, tilstand og dokumentasjonsmangler.`)}>
              Oppsummer
            </Button>
            {canEdit && (
              <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
                {(close) => (
                  <>
                    <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setModal("edit"))}>
                      Rediger bygg
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), del.run())}>
                      Slett bygg
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </>
        }
      />
      <PlaceCover kind="buildings" id={b.id} name={b.name} hasImage={b.has_image} updatedAt={b.updated_at} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Oversikt" },
          { value: "documents", label: "Dokumenter", count: s?.documents },
          { value: "components", label: "Komponenter", count: s?.components },
          { value: "tasks", label: "Oppgaver", count: s?.open_tasks },
          { value: "bim", label: "BIM", count: s?.ifc_models },
          { value: "artifacts", label: "Sider", count: s?.artifacts },
        ]}
      />

      {tab === "overview" && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Etasjer</h2>
              <div className={cn("flex gap-2", !canEdit && "hidden")}>
                <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => setModal("plan")}>
                  Fra plantegning
                </Button>
                <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setModal("floor")}>
                  Ny etasje
                </Button>
              </div>
            </div>
            {b.floors.length === 0 ? (
              <EmptyState
                icon={<Layers className="size-5" />}
                title="Ingen etasjer"
                description={canEdit ? "Last opp en plantegning, så leser vi etasjer og rom og kan lage en BIM-modell. Du kan også legge dem inn selv, eller hente dem fra en IFC-modell." : "Det er ikke registrert etasjer i bygget ennå."}
                action={
                  canEdit && <div className="flex flex-wrap gap-2">
                    <Button variant="primary" onClick={() => setModal("plan")}>Fra plantegning</Button>
                    <Button onClick={() => setModal("floor")}>Ny etasje</Button>
                    <Button variant="ghost" onClick={() => setTab("bim")}>
                      Importer fra IFC
                    </Button>
                  </div>
                }
              />
            ) : (
              <TableShell
                head={
                  <tr className="text-[11.5px] tracking-wide text-muted uppercase">
                    <th className="px-3 py-2 text-left font-semibold">Etasje</th>
                    <th className="px-3 py-2 text-left font-semibold">Nivå</th>
                    <th className="px-3 py-2 text-left font-semibold">Rom</th>
                    <th className="px-3 py-2 text-left font-semibold">Romareal</th>
                  </tr>
                }
              >
                {[...b.floors]
                  .sort((x, y) => y.level - x.level)
                  .map((f) => (
                    <tr key={f.id} className="hover:bg-panel-2/50">
                      <td className="px-3 py-2.5">
                        <Link to={`/o/${orgId}/floors/${f.id}`} className="flex items-center gap-2 font-medium hover:underline">
                          <Layers className="size-4 text-muted" />
                          {f.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-ink-2 tabular-nums">{f.level}</td>
                      <td className="px-3 py-2.5 text-ink-2 tabular-nums">{f.room_count}</td>
                      <td className="px-3 py-2.5 text-ink-2 tabular-nums">{formatArea(f.room_area)}</td>
                    </tr>
                  ))}
              </TableShell>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Åpne oppgaver" value={s?.open_tasks ?? 0} />
              <Stat label="Komponenter" value={s?.components ?? 0} />
            </div>
            <Card>
              <CardHeader title="Om bygget" />
              <KeyValues
                items={[
                  ["Eiendom", <Link className="hover:underline" to={`/o/${orgId}/properties/${b.property_id}`}>{b.property_name}</Link>],
                  ["Formål", b.building_type],
                  ["Byggeår", b.year_built],
                  ["BTA", formatArea(b.gross_area)],
                  ["Bygningsnr.", b.building_number],
                  ["Registrert", formatDate(b.created_at)],
                ]}
              />
              {b.description && <p className="mt-3 border-t border-line pt-3 text-[13.5px] text-ink-2">{b.description}</p>}
            </Card>
          </div>
        </div>
      )}

      {tab === "documents" && <BuildingDocuments buildingId={b.id} propertyId={b.property_id} propertyName={b.property_name} onUpload={() => setModal("upload")} />}
      {tab === "components" && <BuildingComponents buildingId={b.id} onNew={() => setModal("component")} />}
      {tab === "tasks" && <BuildingTasks buildingId={b.id} onNew={() => setModal("task")} onOpen={setOpenTask} />}
      {tab === "bim" && <BuildingBim buildingId={b.id} onUpload={() => setModal("upload")} onPlan={() => setModal("plan")} />}
      {tab === "artifacts" && <BuildingArtifacts building={b} />}

      <BuildingFormModal open={modal === "edit"} onClose={() => setModal(null)} building={b} />
      <FloorFormModal open={modal === "floor"} onClose={() => setModal(null)} buildingId={b.id} nextLevel={nextLevel} />
      <FloorplanModal
        open={modal === "plan"}
        onClose={() => setModal(null)}
        buildingId={b.id}
        onCreated={(result) => {
          if (result.modelId) setTab("bim");
        }}
      />
      <UploadModal open={modal === "upload"} onClose={() => setModal(null)} defaults={{ property_id: b.property_id, building_id: b.id }} />
      <ComponentFormModal open={modal === "component"} onClose={() => setModal(null)} defaults={{ property_id: b.property_id, building_id: b.id }} />
      <TaskFormModal open={modal === "task" || !!openTask} onClose={() => (setModal(null), setOpenTask(null))} task={openTask ?? undefined} defaults={{ property_id: b.property_id, building_id: b.id }} />
      {del.dialog}
    </div>
  );
}

function SectionHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {action}
    </div>
  );
}

function BuildingDocuments({ buildingId, propertyId, propertyName, onUpload }: { buildingId: string; propertyId: string; propertyName: string; onUpload: () => void }) {
  const { orgId, canEdit } = useOrg();
  const docs = useOrgQuery<Document[]>(`/documents?building_id=${buildingId}`, { refetchInterval: (q) => ((q.state.data as Document[] | undefined)?.some((d) => d.status === "processing") ? 3000 : false) });
  const onProperty = useOrgQuery<Document[]>(`/documents?property_id=${propertyId}`);
  if (docs.isLoading) return <Loading />;
  const elsewhere = (onProperty.data ?? []).filter((d) => d.building_id !== buildingId).length;
  return (
    <>
      <SectionHead title="Dokumenter" action={canEdit && <Button size="sm" icon={<Upload className="size-3.5" />} onClick={onUpload}>Last opp</Button>} />
      {elsewhere > 0 && (
        <p className="mb-3 rounded-xl bg-panel-2 px-4 py-3 text-[13.5px] text-ink-2">
          {elsewhere === 1 ? "Ett dokument ligger" : `${elsewhere} dokumenter ligger`} på eiendommen {propertyName}, og vises ikke i denne listen.{" "}
          <Link to={`/o/${orgId}/documents?eiendom=${propertyId}`} className="font-medium text-ink underline">
            Se eiendommens dokumenter
          </Link>
        </p>
      )}
      {docs.data?.length ? <DocumentTable documents={docs.data} showLocation={false} /> : <EmptyState title="Ingen dokumenter på bygget" description="Last opp FDV-dokumentasjon, produktdatablad, tegninger og rapporter. Dokumenter som gjelder hele eiendommen, ligger ikke i denne listen." action={canEdit ? <Button onClick={onUpload}>Last opp</Button> : undefined} />}
    </>
  );
}

function BuildingComponents({ buildingId, onNew }: { buildingId: string; onNew: () => void }) {
  const { canEdit } = useOrg();
  const comps = useOrgQuery<Component[]>(`/components?building_id=${buildingId}`);
  if (comps.isLoading) return <Loading />;
  return (
    <>
      <SectionHead title="FDV-register" action={canEdit && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onNew}>Ny komponent</Button>} />
      {comps.data?.length ? <ComponentTable components={comps.data} /> : <EmptyState title="Ingen komponenter" description="Registrer tekniske anlegg og utstyr – eller be Vedlikeholdsplanleggeren hente dem fra dokumentasjonen." action={canEdit ? <Button onClick={onNew}>Ny komponent</Button> : undefined} />}
    </>
  );
}

function BuildingTasks({ buildingId, onNew, onOpen }: { buildingId: string; onNew: () => void; onOpen: (t: Task) => void }) {
  const { canEdit } = useOrg();
  const [status, setStatus] = useState("open");
  const tasks = useOrgQuery<Task[]>(`/tasks?building_id=${buildingId}&status=${status}`);
  return (
    <>
      <SectionHead
        title="Oppgaver"
        action={
          <div className="flex gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-7 rounded-md border border-line-strong bg-panel px-2 text-[13px]">
              <option value="open">Åpne</option>
              <option value="done">Utførte</option>
              <option value="all">Alle</option>
            </select>
            {canEdit && (
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onNew}>
                Ny oppgave
              </Button>
            )}
          </div>
        }
      />
      {tasks.isLoading ? <Loading /> : tasks.data?.length ? <TaskTable tasks={tasks.data} onOpen={onOpen} showBuilding={false} /> : <EmptyState title="Ingen oppgaver" />}
    </>
  );
}

function BuildingBim({ buildingId, onUpload, onPlan }: { buildingId: string; onUpload: () => void; onPlan: () => void }) {
  const { orgId, canEdit } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const models = useOrgQuery<{ id: string; title: string; filename: string; size: number; created_at: number; schema: string | null; indexed_at: number | null; stats: { by_type: Record<string, number> } | null }[]>(`/ifc/models?building_id=${buildingId}`);
  const remove = async (model: { id: string; title: string }) => {
    if (!(await confirm({ title: "Slette BIM-modellen?", message: `«${model.title}» og indeksen slettes. Etasjer og rom i registeret beholdes.`, confirm: "Slett", danger: true }))) return;
    await call(`/documents/${model.id}`, { method: "DELETE" });
    toast("BIM-modellen er slettet");
  };
  if (models.isLoading) return <Loading />;
  return (
    <>
      {dialog}
      <SectionHead title="BIM-modeller (IFC)" action={canEdit && <Button size="sm" icon={<Upload className="size-3.5" />} onClick={onUpload}>Last opp IFC</Button>} />
      {models.data?.length ? (
        <div className="grid gap-3 @xl:grid-cols-2">
          {models.data.map((m) => {
            const total = m.stats ? Object.values(m.stats.by_type).reduce((a, n) => a + n, 0) : null;
            return (
              <Link key={m.id} to={`/o/${orgId}/models/${m.id}`} className="group flex items-start gap-3 rounded-xl border border-line bg-panel p-4 hover:border-line-strong">
                <span className="flex size-11 items-center justify-center rounded-xl bg-info-soft text-info">
                  <Box className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold group-hover:underline">{m.title}</span>
                  <span className="block text-[12.5px] text-muted">
                    {m.schema ?? "IFC"} · {formatDate(m.created_at)}
                  </span>
                  <span className="mt-2 block text-[12.5px] text-ink-2">{m.indexed_at ? `${total} elementer indeksert` : "Ikke indeksert – åpne modellen for å indeksere"}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Slett ${m.title}`}
                  title="Slett modell"
                  className={cn("rounded-md p-1.5 text-muted hover:bg-bad-soft hover:text-bad", !canEdit && "hidden")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void remove(m);
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Box className="size-5" />}
          title="Ingen IFC-modeller"
          description="Lag en modell fra plantegning, eller last opp en IFC-fil. Rommene i modellen kobles til etasjene i bygget."
          action={
            canEdit && <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={onPlan}>Fra plantegning</Button>
              <Button onClick={onUpload}>Last opp IFC</Button>
            </div>
          }
        />
      )}
    </>
  );
}

function BuildingArtifacts({ building }: { building: BuildingDetail }) {
  const { orgId } = useOrg();
  const panel = useAgentPanel();
  const agents = useOrgQuery<{ id: string; template: string | null }[]>("/agents");
  const list = useOrgQuery<Artifact[]>(`/artifacts?building_id=${building.id}`);
  const builder = agents.data?.find((a) => a.template === "sidebygger")?.id;
  return (
    <>
      <SectionHead
        title="Sider"
        action={
          <Button size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => panel.ask(`Lag en side (artifact) for bygget «${building.name}» (plank://building/${building.id}) som viser åpne oppgaver, service som forfaller og komponenter med dårlig tilstand.`, { agentId: builder, newConversation: true })}>
            Lag side med agent
          </Button>
        }
      />
      {list.data?.length ? (
        <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {list.data.map((a) => (
            <Link key={a.id} to={`/o/${orgId}/artifacts/${a.id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-line-strong">
              <LayoutDashboard className="mb-2 size-5 text-accent" />
              <div className="font-semibold">{a.title}</div>
              <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{a.description}</div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState icon={<LayoutDashboard className="size-5" />} title="Ingen sider for bygget" description="Be en agent lage et dashboard, en rapport eller en sjekkliste – med levende data fra Plank." />
      )}
    </>
  );
}

// ─── Etasje ──────────────────────────────────────────────────────────────────

export function FloorPage() {
  const { id } = useParams();
  const { orgId, canEdit } = useOrg();
  const q = useOrgQuery<Floor & { building_name: string; property_id: string; property_name: string; rooms: (Room & { component_count: number })[] }>(`/portfolio/floors/${id}`);
  const comps = useOrgQuery<Component[]>(`/components?floor_id=${id}`);
  useSetFocus("floor", id, q.data ? `${q.data.building_name} › ${q.data.name}` : undefined);
  const [modal, setModal] = useState<null | "edit" | "room" | "component">(null);
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const del = useDelete(`/portfolio/floors/${id}`, "etasjen", `/o/${orgId}/buildings/${q.data?.building_id ?? ""}`);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const f = q.data!;
  const totalArea = f.rooms.reduce((a, r) => a + (r.area ?? 0), 0);
  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[
          { label: f.property_name, to: `/o/${orgId}/properties/${f.property_id}` },
          { label: f.building_name, to: `/o/${orgId}/buildings/${f.building_id}` },
        ]}
        icon={<Layers className="size-5" />}
        title={f.name}
        subtitle={`${f.rooms.length} rom · ${formatArea(totalArea || null)} romareal · nivå ${f.level}`}
        actions={
          canEdit && (
            <>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setModal("room")}>
                Nytt rom
              </Button>
              <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
                {(close) => (
                  <>
                    <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setModal("edit"))}>
                      Rediger etasje
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), del.run())}>
                      Slett etasje
                    </MenuItem>
                  </>
                )}
              </Menu>
            </>
          )
        }
      />
      <h2 className="mb-3 text-[15px] font-semibold">Rom</h2>
      {f.rooms.length === 0 ? (
        <EmptyState icon={<DoorOpen className="size-5" />} title="Ingen rom" action={canEdit ? <Button onClick={() => setModal("room")}>Nytt rom</Button> : undefined} />
      ) : (
        <TableShell
          head={
            <tr className="text-[11.5px] tracking-wide text-muted uppercase">
              <th className="px-3 py-2 text-left font-semibold">Nr.</th>
              <th className="px-3 py-2 text-left font-semibold">Rom</th>
              <th className="px-3 py-2 text-left font-semibold">Funksjon</th>
              <th className="px-3 py-2 text-left font-semibold">Areal</th>
              <th className="px-3 py-2 text-left font-semibold">Komponenter</th>
              <th className="w-10" />
            </tr>
          }
        >
          {f.rooms.map((r) => (
            <tr key={r.id} className="hover:bg-panel-2/50">
              <td className="px-3 py-2.5 font-mono text-[12.5px] text-ink-2">{r.number ?? "–"}</td>
              <td className="px-3 py-2.5">
                <Link to={`/o/${orgId}/rooms/${r.id}`} className="font-medium hover:underline">
                  {r.name}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-ink-2">{r.usage ?? "–"}</td>
              <td className="px-3 py-2.5 text-ink-2 tabular-nums">{formatArea(r.area)}</td>
              <td className="px-3 py-2.5 text-ink-2 tabular-nums">{r.component_count}</td>
              <td className="px-2">
                {canEdit && (
                  <IconButton label="Rediger" size="sm" onClick={() => setEditRoom(r)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                )}
              </td>
            </tr>
          ))}
        </TableShell>
      )}
      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Komponenter i etasjen</h2>
        {canEdit && (
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setModal("component")}>
            Ny komponent
          </Button>
        )}
      </div>
      {comps.data?.length ? <ComponentTable components={comps.data} /> : <div className="text-[13px] text-muted">Ingen komponenter registrert.</div>}
      <FloorFormModal open={modal === "edit"} onClose={() => setModal(null)} floor={f} />
      <RoomFormModal open={modal === "room" || !!editRoom} onClose={() => (setModal(null), setEditRoom(null))} floorId={f.id} room={editRoom ?? undefined} />
      <ComponentFormModal open={modal === "component"} onClose={() => setModal(null)} defaults={{ property_id: f.property_id, building_id: f.building_id, floor_id: f.id }} />
      {del.dialog}
    </div>
  );
}

// ─── Rom ─────────────────────────────────────────────────────────────────────

export function RoomPage() {
  const { id } = useParams();
  const { orgId, canEdit } = useOrg();
  const q = useOrgQuery<Room & { floor_name: string; building_name: string; property_id: string }>(`/portfolio/rooms/${id}`);
  const comps = useOrgQuery<Component[]>(`/components?room_id=${id}`);
  const docs = useOrgQuery<Document[]>(`/documents?room_id=${id}`);
  useSetFocus("room", id, q.data ? `${q.data.number ? q.data.number + " " : ""}${q.data.name}` : undefined);
  const panel = useAgentPanel();
  const [modal, setModal] = useState<null | "edit" | "component" | "task">(null);
  const del = useDelete(`/portfolio/rooms/${id}`, "rommet", `/o/${orgId}/floors/${q.data?.floor_id ?? ""}`);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data!;
  const loc = { property_id: r.property_id, building_id: r.building_id, floor_id: r.floor_id, room_id: r.id };
  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[
          { label: r.building_name, to: `/o/${orgId}/buildings/${r.building_id}` },
          { label: r.floor_name, to: `/o/${orgId}/floors/${r.floor_id}` },
        ]}
        icon={<DoorOpen className="size-5" />}
        title={`${r.number ? r.number + " " : ""}${r.name}`}
        subtitle={[r.usage, formatArea(r.area)].filter((x) => x && x !== "–").join(" · ") || "Rom"}
        actions={
          <>
            {canEdit && (
              <Button icon={<Plus className="size-4" />} onClick={() => setModal("task")}>
                Meld avvik
              </Button>
            )}
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => panel.ask(`Hva finnes av tekniske komponenter, dokumentasjon og åpne oppgaver i rommet ${r.number ?? ""} ${r.name}?`)}>
              Spør om rommet
            </Button>
            {canEdit && (
              <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
                {(close) => (
                  <>
                    <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setModal("edit"))}>
                      Rediger rom
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), del.run())}>
                      Slett rom
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </>
        }
      />
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Komponenter</h2>
        {canEdit && (
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setModal("component")}>
            Ny komponent
          </Button>
        )}
      </div>
      {comps.data?.length ? <ComponentTable components={comps.data} showLocation={false} /> : <div className="text-[13px] text-muted">Ingen komponenter i rommet.</div>}
      {docs.data && docs.data.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 text-[15px] font-semibold">Dokumenter</h2>
          <DocumentTable documents={docs.data} showLocation={false} />
        </>
      )}
      <RoomFormModal open={modal === "edit"} onClose={() => setModal(null)} room={r} />
      <ComponentFormModal open={modal === "component"} onClose={() => setModal(null)} defaults={loc} />
      <TaskFormModal open={modal === "task"} onClose={() => setModal(null)} defaults={{ ...loc, type: "avvik" }} />
      {del.dialog}
    </div>
  );
}
