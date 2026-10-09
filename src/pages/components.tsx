import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CalendarCheck, Ellipsis, Pencil, Plus, Search, Sparkles, Trash2, Upload, Wrench } from "lucide-react";
import type { Component, Document, Task, TreeProperty } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDate } from "@/lib/format";
import { ConditionBadge, ServiceBadge } from "@/components/domain";
import { Button, Card, CardHeader, EmptyState, ErrorState, IconButton, Input, KeyValues, Loading, Menu, MenuItem, PageHeader, Select, useConfirm, useToast } from "@/components/ui";
import { ComponentTable, DocumentTable, TaskTable } from "@/components/lists";
import { ComponentFormModal, TaskFormModal, UploadModal } from "@/components/forms";

export function ComponentsPage() {
  useSetFocus("org");
  const [q, setQ] = useState("");
  const [building, setBuilding] = useState("");
  const [due, setDue] = useState("");
  const [create, setCreate] = useState(false);
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (building) params.set("building_id", building);
  if (due) params.set("service_due_before", new Date(Date.now() + Number(due) * 864e5).toISOString().slice(0, 10));
  const comps = useOrgQuery<Component[]>(`/components?${params}`, { placeholderData: (prev) => prev });

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<Wrench className="size-5" />}
        title="FDV-register"
        subtitle="Tekniske anlegg og utstyr med NS 3451, TFM, serviceintervaller og tilstand."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
            Ny komponent
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Søk på navn, produsent, modell eller TFM …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="w-auto min-w-44" value={building} onChange={(e) => setBuilding(e.target.value)}>
          <option value="">Alle bygg</option>
          {tree.data?.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select className="w-auto min-w-44" value={due} onChange={(e) => setDue(e.target.value)}>
          <option value="">All service</option>
          <option value="0">På overtid</option>
          <option value="30">Innen 30 dager</option>
          <option value="90">Innen 90 dager</option>
        </Select>
      </div>
      {comps.isLoading ? (
        <Loading />
      ) : comps.data?.length ? (
        <ComponentTable components={comps.data} />
      ) : (
        <EmptyState icon={<Wrench className="size-5" />} title="Ingen komponenter" description="Registrer komponenter manuelt, fra IFC-modellen, eller la en agent hente dem fra dokumentasjonen." />
      )}
      <ComponentFormModal open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

export function ComponentPage() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const q = useOrgQuery<Component & { documents: Document[]; tasks: Task[] }>(`/components/${id}`);
  useSetFocus("component", id, q.data?.name);
  const [modal, setModal] = useState<null | "edit" | "task" | "upload">(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const c = q.data!;

  const registerService = async () => {
    const today = new Date().toISOString().slice(0, 10);
    await call(`/components/${c.id}`, { method: "PATCH", body: { last_service_at: today } });
    toast("Service registrert i dag – neste service er beregnet", "ok");
  };
  const remove = async () => {
    if (!(await confirm({ title: "Slette komponenten?", message: `«${c.name}» fjernes fra FDV-registeret.`, confirm: "Slett", danger: true }))) return;
    await call(`/components/${c.id}`, { method: "DELETE" });
    navigate(`/o/${orgId}/components`);
  };
  const loc = { building_id: c.building_id ?? "", floor_id: c.floor_id ?? "", room_id: c.room_id ?? "" };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "FDV-register", to: `/o/${orgId}/components` }, ...(c.building_id ? [{ label: c.building_name ?? "Bygg", to: `/o/${orgId}/buildings/${c.building_id}` }] : [])]}
        icon={<Wrench className="size-5" />}
        title={c.name}
        subtitle={[c.manufacturer, c.model, c.tfm].filter(Boolean).join(" · ") || c.category || "Komponent"}
        actions={
          <>
            {c.service_interval_months && (
              <Button icon={<CalendarCheck className="size-4" />} onClick={registerService}>
                Registrer service i dag
              </Button>
            )}
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => panel.ask(`Når er neste service for «${c.name}», og hva skal gjøres? Bruk dokumentasjonen.`)}>
              Hva skal gjøres?
            </Button>
            <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
              {(close) => (
                <>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setModal("edit"))}>
                    Rediger
                  </MenuItem>
                  <MenuItem icon={<Upload className="size-4" />} onClick={() => (close(), setModal("upload"))}>
                    Last opp dokumentasjon
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), remove())}>
                    Slett
                  </MenuItem>
                </>
              )}
            </Menu>
          </>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Oppgaver</h2>
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setModal("task")}>
                Ny oppgave
              </Button>
            </div>
            {c.tasks.length ? <TaskTable tasks={c.tasks} onOpen={setOpenTask} showBuilding={false} /> : <div className="text-[13px] text-muted">Ingen oppgaver for komponenten.</div>}
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Dokumentasjon</h2>
              <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => setModal("upload")}>
                Last opp
              </Button>
            </div>
            {c.documents.length ? (
              <DocumentTable documents={c.documents} showLocation={false} />
            ) : (
              <EmptyState title="Ingen dokumentasjon knyttet til komponenten" description="Last opp produktdatablad og bruks- og vedlikeholdsanvisning." />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Service" />
            <KeyValues
              items={[
                ["Neste service", <ServiceBadge next={c.next_service_at} />],
                ["Siste service", formatDate(c.last_service_at)],
                ["Intervall", c.service_interval_months ? `Hver ${c.service_interval_months}. måned` : null],
                ["Tilstand", <ConditionBadge condition={c.condition} />],
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="Detaljer" />
            <KeyValues
              items={[
                ["NS 3451", c.ns3451],
                ["TFM", c.tfm ? <span className="font-mono text-[12.5px]">{c.tfm}</span> : null],
                ["Kategori", c.category],
                ["Produsent", c.manufacturer],
                ["Modell", c.model],
                ["Serienr.", c.serial_number],
                ["Leverandør", c.supplier],
                ["Installert", formatDate(c.installed_at)],
                ["Garanti til", formatDate(c.warranty_until)],
                [
                  "Plassering",
                  c.room_id ? (
                    <Link className="hover:underline" to={`/o/${orgId}/rooms/${c.room_id}`}>
                      {[c.building_name, c.floor_name, c.room_name].filter(Boolean).join(" › ")}
                    </Link>
                  ) : (
                    [c.building_name, c.floor_name].filter(Boolean).join(" › ")
                  ),
                ],
                ["IFC GUID", c.ifc_guid ? <span className="font-mono text-[12px] break-all">{c.ifc_guid}</span> : null],
              ]}
            />
            {c.notes && <p className="mt-3 border-t border-line pt-3 text-[13px] whitespace-pre-wrap text-ink-2">{c.notes}</p>}
          </Card>
        </div>
      </div>
      <ComponentFormModal open={modal === "edit"} onClose={() => setModal(null)} component={c} />
      <TaskFormModal open={modal === "task" || !!openTask} onClose={() => (setModal(null), setOpenTask(null))} task={openTask ?? undefined} defaults={{ ...loc, component_id: c.id }} />
      <UploadModal open={modal === "upload"} onClose={() => setModal(null)} defaults={{ ...loc, component_id: c.id }} />
      {dialog}
    </div>
  );
}
