import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Upload, X } from "lucide-react";
import {
  DOCUMENT_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type Building,
  type Component,
  type Floor,
  type Property,
  type Room,
  type Task,
  type TreeProperty,
} from "@shared/types";
import { useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { formatBytes } from "@/lib/format";
import { Button, Field, Input, Modal, Select, Textarea, useToast } from "./ui";

type Values = Record<string, string>;

function useForm(initial: Values, open: boolean) {
  const [values, setValues] = useState<Values>(initial);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (open) setValues(initialRef.current);
  }, [open]);
  const bind = (name: string) => ({
    value: values[name] ?? "",
    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [name]: e.target.value })),
  });
  return { values, setValues, bind };
}

const s = (v: unknown) => (v == null ? "" : String(v));

function FormModal({
  open,
  onClose,
  title,
  onSubmit,
  submitLabel = "Lagre",
  children,
  size,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onSubmit: () => Promise<void>;
  submitLabel?: string;
  children: ReactNode;
  size?: "md" | "lg";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size={size}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} onClick={() => submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {children}
        {error && <div className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</div>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

const grid2 = "grid grid-cols-1 gap-4 sm:grid-cols-2";

// ─── Eiendom ─────────────────────────────────────────────────────────────────

export function PropertyFormModal({ open, onClose, property }: { open: boolean; onClose: () => void; property?: Property }) {
  const call = useOrgApi();
  const navigate = useNavigate();
  const { orgId } = useOrg();
  const { values, bind } = useForm(
    {
      name: s(property?.name),
      address: s(property?.address),
      postal_code: s(property?.postal_code),
      city: s(property?.city),
      municipality: s(property?.municipality),
      gnr: s(property?.gnr),
      bnr: s(property?.bnr),
      description: s(property?.description),
    },
    open,
  );
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={property ? "Rediger eiendom" : "Ny eiendom"}
      onSubmit={async () => {
        if (property) await call(`/portfolio/properties/${property.id}`, { method: "PATCH", body: values });
        else {
          const p = await call<Property>("/portfolio/properties", { body: values });
          navigate(`/o/${orgId}/properties/${p.id}`);
        }
      }}
    >
      <Field label="Navn">
        <Input required autoFocus placeholder="F.eks. Sagbruket kontorpark" {...bind("name")} />
      </Field>
      <Field label="Adresse">
        <Input {...bind("address")} />
      </Field>
      <div className="grid grid-cols-[110px_1fr] gap-4">
        <Field label="Postnr.">
          <Input inputMode="numeric" {...bind("postal_code")} />
        </Field>
        <Field label="Sted">
          <Input {...bind("city")} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Kommune">
          <Input {...bind("municipality")} />
        </Field>
        <Field label="Gnr.">
          <Input {...bind("gnr")} />
        </Field>
        <Field label="Bnr.">
          <Input {...bind("bnr")} />
        </Field>
      </div>
      <Field label="Beskrivelse">
        <Textarea rows={3} {...bind("description")} />
      </Field>
    </FormModal>
  );
}

// ─── Bygg ────────────────────────────────────────────────────────────────────

export function BuildingFormModal({ open, onClose, propertyId, building }: { open: boolean; onClose: () => void; propertyId?: string; building?: Building }) {
  const call = useOrgApi();
  const navigate = useNavigate();
  const { orgId } = useOrg();
  const { values, bind } = useForm(
    {
      name: s(building?.name),
      building_number: s(building?.building_number),
      building_type: s(building?.building_type),
      year_built: s(building?.year_built),
      gross_area: s(building?.gross_area),
      description: s(building?.description),
    },
    open,
  );
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={building ? "Rediger bygg" : "Nytt bygg"}
      onSubmit={async () => {
        if (building) await call(`/portfolio/buildings/${building.id}`, { method: "PATCH", body: values });
        else {
          const b = await call<Building>("/portfolio/buildings", { body: { ...values, property_id: propertyId } });
          navigate(`/o/${orgId}/buildings/${b.id}`);
        }
      }}
    >
      <Field label="Navn">
        <Input required autoFocus placeholder="F.eks. Hovedbygg" {...bind("name")} />
      </Field>
      <div className={grid2}>
        <Field label="Bygningsnummer" hint="Fra matrikkelen">
          <Input {...bind("building_number")} />
        </Field>
        <Field label="Formål">
          <Input placeholder="Kontor, bolig, skole …" {...bind("building_type")} />
        </Field>
        <Field label="Byggeår">
          <Input inputMode="numeric" {...bind("year_built")} />
        </Field>
        <Field label="BTA (m²)">
          <Input inputMode="decimal" {...bind("gross_area")} />
        </Field>
      </div>
      <Field label="Beskrivelse">
        <Textarea rows={3} {...bind("description")} />
      </Field>
    </FormModal>
  );
}

// ─── Etasje ──────────────────────────────────────────────────────────────────

export function FloorFormModal({ open, onClose, buildingId, floor, nextLevel = 0 }: { open: boolean; onClose: () => void; buildingId?: string; floor?: Floor; nextLevel?: number }) {
  const call = useOrgApi();
  const { values, bind } = useForm({ name: s(floor?.name ?? `${nextLevel + 1}. etasje`), level: s(floor?.level ?? nextLevel), gross_area: s(floor?.gross_area) }, open);
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={floor ? "Rediger etasje" : "Ny etasje"}
      onSubmit={async () => {
        if (floor) await call(`/portfolio/floors/${floor.id}`, { method: "PATCH", body: values });
        else await call("/portfolio/floors", { body: { ...values, building_id: buildingId } });
      }}
    >
      <Field label="Navn">
        <Input required autoFocus {...bind("name")} />
      </Field>
      <div className={grid2}>
        <Field label="Nivå" hint="-1 = kjeller, 0 = 1. etasje, 1 = 2. etasje">
          <Input inputMode="numeric" {...bind("level")} />
        </Field>
        <Field label="BTA (m²)">
          <Input inputMode="decimal" {...bind("gross_area")} />
        </Field>
      </div>
    </FormModal>
  );
}

// ─── Rom ─────────────────────────────────────────────────────────────────────

export function RoomFormModal({ open, onClose, floorId, room }: { open: boolean; onClose: () => void; floorId?: string; room?: Room }) {
  const call = useOrgApi();
  const { values, bind } = useForm({ name: s(room?.name), number: s(room?.number), usage: s(room?.usage), area: s(room?.area) }, open);
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={room ? "Rediger rom" : "Nytt rom"}
      onSubmit={async () => {
        if (room) await call(`/portfolio/rooms/${room.id}`, { method: "PATCH", body: values });
        else await call("/portfolio/rooms", { body: { ...values, floor_id: floorId } });
      }}
    >
      <div className="grid grid-cols-[120px_1fr] gap-4">
        <Field label="Romnr.">
          <Input autoFocus {...bind("number")} />
        </Field>
        <Field label="Navn">
          <Input required {...bind("name")} />
        </Field>
      </div>
      <div className={grid2}>
        <Field label="Funksjon">
          <Input placeholder="Kontor, teknisk rom …" {...bind("usage")} />
        </Field>
        <Field label="Areal (m²)">
          <Input inputMode="decimal" {...bind("area")} />
        </Field>
      </div>
    </FormModal>
  );
}

// ─── Plasseringsvelger ───────────────────────────────────────────────────────

export interface LocationValue {
  property_id: string;
  building_id: string;
  floor_id: string;
  room_id: string;
}

export function LocationPicker({ value, onChange, requireBuilding }: { value: LocationValue; onChange: (v: LocationValue) => void; requireBuilding?: boolean }) {
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const props = tree.data ?? [];
  const property = props.find((p) => p.id === value.property_id) ?? props.find((p) => p.buildings.some((b) => b.id === value.building_id));
  const building = property?.buildings.find((b) => b.id === value.building_id);
  const floor = building?.floors.find((f) => f.id === value.floor_id);
  return (
    <div className={grid2}>
      <Field label="Eiendom">
        <Select value={property?.id ?? ""} onChange={(e) => onChange({ property_id: e.target.value, building_id: "", floor_id: "", room_id: "" })}>
          <option value="">{requireBuilding ? "Velg …" : "Ingen"}</option>
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Bygg">
        <Select value={value.building_id} disabled={!property} onChange={(e) => onChange({ ...value, property_id: property?.id ?? "", building_id: e.target.value, floor_id: "", room_id: "" })}>
          <option value="">{requireBuilding ? "Velg …" : "Hele eiendommen"}</option>
          {property?.buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Etasje">
        <Select value={value.floor_id} disabled={!building} onChange={(e) => onChange({ ...value, floor_id: e.target.value, room_id: "" })}>
          <option value="">–</option>
          {building?.floors.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Rom">
        <Select value={value.room_id} disabled={!floor} onChange={(e) => onChange({ ...value, room_id: e.target.value })}>
          <option value="">–</option>
          {floor?.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.number ? `${r.number} ${r.name}` : r.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

const emptyLoc = (v?: Partial<LocationValue>): LocationValue => ({ property_id: v?.property_id ?? "", building_id: v?.building_id ?? "", floor_id: v?.floor_id ?? "", room_id: v?.room_id ?? "" });

function locPayload(l: LocationValue) {
  return { property_id: l.property_id || null, building_id: l.building_id || null, floor_id: l.floor_id || null, room_id: l.room_id || null };
}

// ─── Komponent ───────────────────────────────────────────────────────────────

export function ComponentFormModal({ open, onClose, component, defaults }: { open: boolean; onClose: () => void; component?: Component; defaults?: Partial<LocationValue> & { ifc_guid?: string; name?: string } }) {
  const call = useOrgApi();
  const navigate = useNavigate();
  const { orgId } = useOrg();
  const [loc, setLoc] = useState<LocationValue>(emptyLoc());
  const initKey = JSON.stringify(component ? { building_id: component.building_id ?? "", floor_id: component.floor_id ?? "", room_id: component.room_id ?? "" } : (defaults ?? {}));
  useEffect(() => {
    if (open) setLoc(emptyLoc(JSON.parse(initKey)));
  }, [open, initKey]);
  const { values, bind } = useForm(
    {
      name: s(component?.name ?? defaults?.name),
      ns3451: s(component?.ns3451),
      tfm: s(component?.tfm),
      category: s(component?.category),
      manufacturer: s(component?.manufacturer),
      model: s(component?.model),
      serial_number: s(component?.serial_number),
      supplier: s(component?.supplier),
      installed_at: s(component?.installed_at),
      warranty_until: s(component?.warranty_until),
      service_interval_months: s(component?.service_interval_months),
      last_service_at: s(component?.last_service_at),
      condition: s(component?.condition),
      ifc_guid: s(component?.ifc_guid ?? defaults?.ifc_guid),
      notes: s(component?.notes),
    },
    open,
  );
  return (
    <FormModal
      open={open}
      onClose={onClose}
      size="lg"
      title={component ? "Rediger komponent" : "Ny komponent"}
      onSubmit={async () => {
        const body = { ...values, ...locPayload(loc) };
        delete (body as Record<string, unknown>).property_id;
        if (component) await call(`/components/${component.id}`, { method: "PATCH", body });
        else {
          const c = await call<Component>("/components", { body });
          navigate(`/o/${orgId}/components/${c.id}`);
        }
      }}
    >
      <Field label="Navn">
        <Input required autoFocus placeholder="F.eks. Ventilasjonsaggregat VA01" {...bind("name")} />
      </Field>
      <LocationPicker value={loc} onChange={setLoc} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="NS 3451" hint="F.eks. 36">
          <Input {...bind("ns3451")} />
        </Field>
        <Field label="TFM">
          <Input placeholder="=360.001" {...bind("tfm")} />
        </Field>
        <Field label="Kategori">
          <Input {...bind("category")} />
        </Field>
        <Field label="Produsent">
          <Input {...bind("manufacturer")} />
        </Field>
        <Field label="Modell">
          <Input {...bind("model")} />
        </Field>
        <Field label="Serienummer">
          <Input {...bind("serial_number")} />
        </Field>
        <Field label="Leverandør">
          <Input {...bind("supplier")} />
        </Field>
        <Field label="Installert">
          <Input type="date" {...bind("installed_at")} />
        </Field>
        <Field label="Garanti til">
          <Input type="date" {...bind("warranty_until")} />
        </Field>
        <Field label="Serviceintervall (mnd)">
          <Input inputMode="numeric" {...bind("service_interval_months")} />
        </Field>
        <Field label="Siste service">
          <Input type="date" {...bind("last_service_at")} />
        </Field>
        <Field label="Tilstandsgrad">
          <Select {...bind("condition")}>
            <option value="">–</option>
            {["TG0", "TG1", "TG2", "TG3", "TGIU"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="IFC GUID">
        <Input className="font-mono text-[13px]" {...bind("ifc_guid")} />
      </Field>
      <Field label="Notater">
        <Textarea rows={3} {...bind("notes")} />
      </Field>
    </FormModal>
  );
}

// ─── Oppgave ─────────────────────────────────────────────────────────────────

export function TaskFormModal({ open, onClose, task, defaults }: { open: boolean; onClose: () => void; task?: Task; defaults?: Partial<LocationValue> & { component_id?: string; type?: string } }) {
  const call = useOrgApi();
  const toast = useToast();
  const [loc, setLoc] = useState<LocationValue>(emptyLoc());
  const initKey = JSON.stringify(task ? { property_id: task.property_id ?? "", building_id: task.building_id ?? "", floor_id: task.floor_id ?? "", room_id: task.room_id ?? "" } : (defaults ?? {}));
  useEffect(() => {
    if (open) setLoc(emptyLoc(JSON.parse(initKey)));
  }, [open, initKey]);
  const { values, bind } = useForm(
    {
      title: s(task?.title),
      description: s(task?.description),
      type: s(task?.type ?? defaults?.type ?? "vedlikehold"),
      status: s(task?.status ?? "open"),
      priority: s(task?.priority ?? "normal"),
      due_date: s(task?.due_date),
      assignee: s(task?.assignee),
      component_id: s(task?.component_id ?? defaults?.component_id),
    },
    open,
  );
  const comps = useOrgQuery<Component[]>(loc.building_id ? `/components?building_id=${loc.building_id}` : null);
  return (
    <FormModal
      open={open}
      onClose={onClose}
      size="lg"
      title={task ? "Rediger oppgave" : "Ny oppgave"}
      onSubmit={async () => {
        const body = { ...values, ...locPayload(loc), component_id: values.component_id || null };
        if (task) await call(`/tasks/${task.id}`, { method: "PATCH", body });
        else {
          await call("/tasks", { body });
          toast("Oppgaven er opprettet", "ok");
        }
      }}
    >
      <Field label="Tittel">
        <Input required autoFocus {...bind("title")} />
      </Field>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Type">
          <Select {...bind("type")}>
            {Object.entries(TASK_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prioritet">
          <Select {...bind("priority")}>
            {Object.entries(TASK_PRIORITIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select {...bind("status")}>
            {Object.entries(TASK_STATUSES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Frist">
          <Input type="date" {...bind("due_date")} />
        </Field>
      </div>
      <Field label="Beskrivelse">
        <Textarea rows={4} {...bind("description")} />
      </Field>
      <LocationPicker value={loc} onChange={setLoc} />
      <div className={grid2}>
        <Field label="Komponent">
          <Select {...bind("component_id")} disabled={!loc.building_id}>
            <option value="">–</option>
            {comps.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ansvarlig">
          <Input placeholder="Navn eller e-post" {...bind("assignee")} />
        </Field>
      </div>
    </FormModal>
  );
}

// ─── Opplasting ──────────────────────────────────────────────────────────────

export function UploadModal({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: Partial<LocationValue> & { component_id?: string } }) {
  const call = useOrgApi();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState("annet");
  const [loc, setLoc] = useState<LocationValue>(emptyLoc());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultsKey = useMemo(() => JSON.stringify(defaults ?? {}), [defaults]);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setKind("annet");
      setLoc(emptyLoc(JSON.parse(defaultsKey)));
      setProgress(null);
    }
  }, [open, defaultsKey]);

  const add = (list: FileList | null) => {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list)]);
  };

  const upload = async () => {
    setBusy(true);
    let ok = 0;
    try {
      for (const [i, file] of files.entries()) {
        setProgress(`Laster opp ${i + 1} av ${files.length}: ${file.name}`);
        const form = new FormData();
        form.set("file", file);
        form.set("kind", kind);
        for (const [k, v] of Object.entries(locPayload(loc))) if (v) form.set(k, v);
        if (defaults?.component_id) form.set("component_id", defaults.component_id);
        await call("/documents", { form }, i === files.length - 1);
        ok++;
      }
      toast(`${ok} fil${ok === 1 ? "" : "er"} lastet opp – tekst hentes ut i bakgrunnen`, "ok");
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Opplasting feilet", "bad");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Last opp dokumenter"
      footer={
        <>
          {progress && <span className="mr-auto self-center text-[12.5px] text-muted">{progress}</span>}
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} disabled={files.length === 0} onClick={upload} icon={<Upload className="size-4" />}>
            Last opp {files.length > 0 ? files.length : ""}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            add(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${drag ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-panel-2"}`}
        >
          <Upload className="mb-2 size-6 text-muted" />
          <div className="text-[14px] font-medium">Slipp filer her, eller klikk for å velge</div>
          <div className="mt-1 text-[12.5px] text-muted">PDF, Word, Excel, bilder, tekst og IFC-modeller · maks 95 MB per fil</div>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => add(e.target.files)} />
        </div>
        {files.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-muted">{formatBytes(f.size)}</span>
                <button className="text-muted hover:text-ink" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label="Fjern">
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Field label="Dokumenttype" hint="Står den på «Annet», foreslår Plank type, tittel og NS 3451-kode automatisk.">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(DOCUMENT_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <LocationPicker value={loc} onChange={setLoc} />
      </div>
    </Modal>
  );
}
