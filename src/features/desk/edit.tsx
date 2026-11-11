import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { DeskCase, DeskEditor, DeskPlace, DeskSaved, LeaseKind, TreeProperty } from "@shared/types";
import { useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { Button, Field, IconButton, Input, Modal, Select, useConfirm, useToast } from "@/components/ui";

type Shape = "ledig" | "leie" | "vedtak";
type UnitStatus = NonNullable<DeskEditor["record"]["status"]>;

const STATUS: { id: UnitStatus; label: string }[] = [
  { id: "vacant", label: "Ledig" },
  { id: "make_ready", label: "Klargjøres" },
  { id: "reserved", label: "Holdt av" },
  { id: "occupied", label: "Utleid" },
];

function parseKr(raw: string): number | null {
  const t = raw.replace(/[\s\u00a0]/g, "");
  if (!t) return null;
  if (!/^\d+$/.test(t)) throw new Error("Skriv beløpet i hele kroner, uten øre");
  const n = Number(t);
  if (n > 2_000_000_000) throw new Error("Beløpet er for stort");
  return n;
}

function parseArea(raw: string): number | null {
  const t = raw.replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Arealet må være et tall");
  const n = Number(t);
  if (n > 10_000_000) throw new Error("Arealet er for stort");
  return n;
}

function parseCount(raw: string, label: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) throw new Error(`${label} må være et heltall`);
  return Number(t);
}

function blankMoney(n: number | null | undefined) {
  return n == null || n === 0 ? "" : String(n);
}

function asEditor(data: DeskCase | DeskEditor): DeskEditor {
  if ("facts" in data) return { title: data.title, caseId: data.id, record: data.record };
  return data;
}

function KindPick({ kind, onChange }: { kind: LeaseKind; onChange: (k: LeaseKind) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(["bolig", "naering"] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={kind === k}
          onClick={() => onChange(k)}
          className={kind === k ? "rounded-lg border border-ink bg-panel-2 px-3 py-2 text-[13.5px] font-medium" : "rounded-lg border border-line px-3 py-2 text-[13.5px] hover:border-line-strong"}
        >
          {k === "bolig" ? "Bolig" : "Næring"}
        </button>
      ))}
    </div>
  );
}

function BuildingSelect({ value, onChange, tree }: { value: string; onChange: (v: string) => void; tree: TreeProperty[] | undefined }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Ikke knyttet til et bygg</option>
      {tree?.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

function FormShell({
  open,
  onClose,
  title,
  onSubmit,
  submitLabel,
  extra,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onSubmit: () => Promise<void>;
  submitLabel: string;
  extra?: ReactNode;
  children: ReactNode;
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
      size="lg"
      footer={
        <>
          {extra}
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
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

export function useRemoveLease() {
  const { orgId } = useOrg();
  const call = useOrgApi();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const remove = async (target: { caseId?: string | null; leaseId?: string | null; unitId?: string | null; title: string }) => {
    const ok = await confirm({
      title: `Fjerne ${target.title}?`,
      message: "Dette tas bort fra pulten. Ligger objektet bare her, fjernes det også. Brev slettes. Oppgaver blir liggende.",
      confirm: "Fjern",
      danger: true,
    });
    if (!ok) return false;
    const path = target.caseId
      ? `/desk/cases/${encodeURIComponent(target.caseId)}`
      : target.leaseId
        ? `/desk/leases/${target.leaseId}`
        : `/desk/units/${target.unitId}`;
    const res = await call<{ notice: string }>(path, { method: "DELETE" }, false);
    toast(res.notice, "ok");
    const goneKey = ["org", orgId, path] as const;
    // Ikke hent den åpne saken på nytt. Den er borte, og et kall nå gir 404.
    void qc.invalidateQueries({
      queryKey: ["org", orgId],
      predicate: (query) => query.queryKey[2] !== path,
    });
    setTimeout(() => {
      void qc.cancelQueries({ queryKey: goneKey });
      qc.removeQueries({ queryKey: goneKey });
    }, 400);
    return true;
  };
  return { remove, dialog };
}

export function LeaseCreateModal({ open, onClose, buildingId }: { open: boolean; onClose: () => void; buildingId?: string }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const call = useOrgApi();
  const toast = useToast();
  const tree = useOrgQuery<TreeProperty[]>(open ? "/portfolio/tree" : null);
  const [shape, setShape] = useState<Shape>("leie");
  const [kind, setKind] = useState<LeaseKind>("naering");
  const [tenant, setTenant] = useState("");
  const [unitName, setUnitName] = useState("");
  const [building, setBuilding] = useState(buildingId ?? "");
  const [rent, setRent] = useState("");
  const [market, setMarket] = useState("");
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [vacantSince, setVacantSince] = useState("");
  const [vedtakOn, setVedtakOn] = useState("");
  const [need, setNeed] = useState("");
  const [household, setHousehold] = useState("");
  const [area, setArea] = useState("");
  const [rooms, setRooms] = useState("");

  useEffect(() => {
    if (!open) return;
    setShape("leie");
    setKind("naering");
    setTenant("");
    setUnitName("");
    setBuilding(buildingId ?? "");
    setRent("");
    setMarket("");
    setStartOn("");
    setEndOn("");
    setVacantSince("");
    setVedtakOn("");
    setNeed("");
    setHousehold("");
    setArea("");
    setRooms("");
  }, [open, buildingId]);

  const submit = async () => {
    const body: Record<string, unknown> = { shape, kind: shape === "vedtak" ? "bolig" : kind };
    if (shape !== "ledig" && tenant.trim()) body.tenant_name = tenant.trim();
    if (shape !== "vedtak" && unitName.trim()) body.unit_name = unitName.trim();
    if (building) body.building_id = building;
    const rentN = parseKr(rent);
    const marketN = parseKr(market);
    if (rentN != null) body.rent_year = rentN;
    if (marketN != null) body.market_rent_year = marketN;
    if (startOn) body.start_on = startOn;
    if (endOn) body.end_on = endOn;
    if (vacantSince) body.vacant_since = vacantSince;
    if (vedtakOn) body.vedtak_on = vedtakOn;
    if (need.trim()) body.need = need.trim();
    if (household.trim()) body.household = household.trim();
    const areaN = parseArea(area);
    const roomsN = parseCount(rooms, "Rom");
    if (areaN != null) body.area_sqm = areaN;
    if (roomsN != null) body.rooms = roomsN;
    const res = await call<DeskSaved>("/desk/items", { body });
    toast(res.notice, "ok");
    onClose();
    if (res.item && !buildingId) navigate(`/o/${orgId}/pult/${res.item.id}`);
  };

  return (
    <FormShell open={open} onClose={onClose} title="Legg til" submitLabel="Legg til" onSubmit={submit}>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["leie", "Leieforhold"],
            ["ledig", "Ledig objekt"],
            ["vedtak", "Vedtak"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={shape === id}
            onClick={() => setShape(id)}
            className={shape === id ? "rounded-lg border border-ink bg-panel-2 px-2 py-2 text-[13px] font-medium" : "rounded-lg border border-line px-2 py-2 text-[13px] hover:border-line-strong"}
          >
            {label}
          </button>
        ))}
      </div>
      {shape === "vedtak" ? (
        <p className="text-[12.5px] text-muted">Gjelder bolig. Personen har ikke fått bolig ennå.</p>
      ) : (
        <KindPick kind={kind} onChange={setKind} />
      )}
      {shape !== "ledig" && (
        <Field label="Hvem">
          <Input required autoFocus value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder={shape === "vedtak" ? "Ola Pedersen" : "Navn på leietaker"} />
        </Field>
      )}
      {shape !== "vedtak" && (
        <Field label="Objekt">
          <Input required={shape === "ledig"} autoFocus={shape === "ledig"} value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder={kind === "bolig" ? "H0303" : "4. etasje"} />
        </Field>
      )}
      {shape !== "vedtak" && (
        <Field label="Bygg">
          <BuildingSelect value={building} onChange={setBuilding} tree={tree.data} />
        </Field>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {shape === "leie" && (
          <Field label="Leie per år" hint="Hele kroner. Tomt betyr at leien ikke er satt.">
            <Input inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value)} placeholder="456000" />
          </Field>
        )}
        {shape !== "vedtak" && (
          <Field label="Markedsleie per år" hint="Hele kroner. Tomt betyr at markedet ikke er satt.">
            <Input inputMode="numeric" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="480000" />
          </Field>
        )}
        {shape === "leie" && (
          <Field label="Fra">
            <Input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
          </Field>
        )}
        {shape === "leie" && (
          <Field label="Til" hint="Tomt er tidsubestemt.">
            <Input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} />
          </Field>
        )}
        {shape === "ledig" && (
          <Field label="Ledig fra" hint="Tomt betyr i dag.">
            <Input type="date" value={vacantSince} onChange={(e) => setVacantSince(e.target.value)} />
          </Field>
        )}
        {shape === "vedtak" && (
          <Field label="Vedtak" hint="Tomt betyr i dag.">
            <Input type="date" value={vedtakOn} onChange={(e) => setVedtakOn(e.target.value)} />
          </Field>
        )}
        {shape !== "vedtak" && (
          <Field label="Areal" hint="Kvadratmeter">
            <Input inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} />
          </Field>
        )}
        {shape !== "vedtak" && kind === "bolig" && (
          <Field label="Rom">
            <Input inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} />
          </Field>
        )}
      </div>
      {shape === "vedtak" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Behov">
            <Input value={need} onChange={(e) => setNeed(e.target.value)} placeholder="2 rom" />
          </Field>
          <Field label="Husstand">
            <Input value={household} onChange={(e) => setHousehold(e.target.value)} placeholder="1 voksen" />
          </Field>
        </div>
      )}
    </FormShell>
  );
}

export function LeaseEditModal({
  open,
  onClose,
  target,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  target: { caseId: string } | { leaseId: string } | { unitId: string } | null;
  onSaved?: (saved: DeskSaved) => void;
}) {
  const { orgId } = useOrg();
  const call = useOrgApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { remove, dialog } = useRemoveLease();
  const path =
    !open || !target ? null : "caseId" in target ? `/desk/cases/${encodeURIComponent(target.caseId)}` : "leaseId" in target ? `/desk/leases/${target.leaseId}` : `/desk/units/${target.unitId}`;
  const q = useOrgQuery<DeskCase | DeskEditor>(path);
  const editor = q.data ? asEditor(q.data) : null;
  const tree = useOrgQuery<TreeProperty[]>(open ? "/portfolio/tree" : null);
  const rec = editor?.record;
  const [kind, setKind] = useState<LeaseKind>("bolig");
  const [tenant, setTenant] = useState("");
  const [unitName, setUnitName] = useState("");
  const [building, setBuilding] = useState("");
  const [address, setAddress] = useState("");
  const [rent, setRent] = useState("");
  const [market, setMarket] = useState("");
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [breakOn, setBreakOn] = useState("");
  const [indexOn, setIndexOn] = useState("");
  const [vacantSince, setVacantSince] = useState("");
  const [vedtakOn, setVedtakOn] = useState("");
  const [moveOutOn, setMoveOutOn] = useState("");
  const [keysOn, setKeysOn] = useState("");
  const [need, setNeed] = useState("");
  const [household, setHousehold] = useState("");
  const [area, setArea] = useState("");
  const [rooms, setRooms] = useState("");
  const [arrears, setArrears] = useState("");
  const [arrearsDays, setArrearsDays] = useState("");
  const [status, setStatus] = useState<UnitStatus>("occupied");

  useEffect(() => {
    if (!open || !rec) return;
    setKind(rec.kind);
    setTenant(rec.tenantName ?? "");
    setUnitName(rec.unitName ?? "");
    setBuilding(rec.buildingId ?? "");
    setAddress(rec.address ?? "");
    setRent(blankMoney(rec.rentYear));
    setMarket(blankMoney(rec.marketRentYear));
    setStartOn(rec.startOn ?? "");
    setEndOn(rec.endOn ?? "");
    setBreakOn(rec.breakOn ?? "");
    setIndexOn(rec.indexOn ?? "");
    setVacantSince(rec.vacantSince ?? "");
    setVedtakOn(rec.vedtakOn ?? "");
    setMoveOutOn(rec.moveOutOn ?? "");
    setKeysOn(rec.keysOn ?? "");
    setNeed(rec.need ?? "");
    setHousehold(rec.household ?? "");
    setArea(rec.areaSqm == null ? "" : String(rec.areaSqm));
    setRooms(rec.rooms == null ? "" : String(rec.rooms));
    setArrears(blankMoney(rec.arrearsNok));
    setArrearsDays(rec.arrearsDays ? String(rec.arrearsDays) : "");
    setStatus(rec.status ?? "occupied");
  }, [open, rec]);

  const showUnit = Boolean(rec?.unitId);
  const showLease = Boolean(rec?.leaseId) || showUnit;

  const submit = async () => {
    if (!editor || !rec) return;
    const body: Record<string, unknown> = { kind };
    if (showUnit) {
      body.unit_name = unitName.trim();
      body.building_id = building || null;
      body.address = address.trim() || null;
      body.area_sqm = parseArea(area);
      body.rooms = kind === "bolig" ? parseCount(rooms, "Rom") : null;
      body.market_rent_year = parseKr(market);
      body.status = status;
      body.vacant_since = vacantSince || null;
    }
    if (showLease) {
      body.tenant_name = tenant.trim() || null;
      body.rent_year = parseKr(rent);
      body.start_on = startOn || null;
      body.end_on = endOn || null;
      body.break_on = breakOn || null;
      body.index_on = indexOn || null;
      body.move_out_on = moveOutOn || null;
      body.keys_on = keysOn || null;
      body.vedtak_on = vedtakOn || null;
      body.need = need.trim() || null;
      body.household = household.trim() || null;
      body.arrears_nok = parseKr(arrears);
      body.arrears_days = parseCount(arrearsDays, "Dager");
    }
    const savePath = editor.caseId
      ? `/desk/cases/${encodeURIComponent(editor.caseId)}`
      : rec.leaseId
        ? `/desk/leases/${rec.leaseId}`
        : `/desk/units/${rec.unitId}`;
    const res = await call<DeskSaved>(savePath, { method: "PATCH", body }, false);
    if (res.item) qc.setQueryData(["org", orgId, `/desk/cases/${encodeURIComponent(res.item.id)}`], res.item);
    toast(res.notice, "ok");
    onSaved?.(res);
    onClose();
    await qc.invalidateQueries({ queryKey: ["org", orgId] });
  };

  const onRemove = async () => {
    if (!editor || !rec) return;
    const gone = await remove({
      caseId: editor.caseId,
      leaseId: rec.leaseId,
      unitId: rec.unitId,
      title: rec.tenantName ?? rec.unitName ?? editor.title,
    });
    if (!gone) return;
    onSaved?.({ item: null, notice: "" });
    onClose();
  };

  return (
    <>
      <FormShell
        open={open}
        onClose={onClose}
        title={editor ? `Rediger ${editor.title}` : "Rediger"}
        submitLabel="Lagre"
        onSubmit={submit}
        extra={
          editor && (
            <Button className="mr-auto" icon={<Trash2 className="size-3.5" />} onClick={() => void onRemove()}>
              Fjern
            </Button>
          )
        }
      >
        {!editor ? (
          <p className="text-[13.5px] text-muted">{q.error instanceof Error ? q.error.message : "Henter …"}</p>
        ) : (
          <>
            <KindPick kind={kind} onChange={setKind} />
            {showLease && (
              <Field label="Hvem" hint={!rec?.leaseId ? "Fyll inn for å legge til et leieforhold på objektet." : undefined}>
                <Input value={tenant} onChange={(e) => setTenant(e.target.value)} />
              </Field>
            )}
            {showUnit && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Objekt">
                    <Input required value={unitName} onChange={(e) => setUnitName(e.target.value)} />
                  </Field>
                  <Field label="Status">
                    <Select value={status} onChange={(e) => setStatus(e.target.value as UnitStatus)}>
                      {STATUS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Bygg">
                  <BuildingSelect value={building} onChange={setBuilding} tree={tree.data} />
                </Field>
                <Field label="Adresse">
                  <Input value={address} onChange={(e) => setAddress(e.target.value)} />
                </Field>
              </>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {showLease && (
                <Field label="Leie per år" hint="Hele kroner. Tomt betyr at leien ikke er satt.">
                  <Input inputMode="numeric" value={rent} onChange={(e) => setRent(e.target.value)} />
                </Field>
              )}
              {showUnit && (
                <Field label="Markedsleie per år" hint="Hele kroner. Tomt betyr at markedet ikke er satt.">
                  <Input inputMode="numeric" value={market} onChange={(e) => setMarket(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Restanse" hint="Hele kroner.">
                  <Input inputMode="numeric" value={arrears} onChange={(e) => setArrears(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Dager i restanse">
                  <Input inputMode="numeric" value={arrearsDays} onChange={(e) => setArrearsDays(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Fra">
                  <Input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Til" hint="Tomt er tidsubestemt.">
                  <Input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Opsjon">
                  <Input type="date" value={breakOn} onChange={(e) => setBreakOn(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Regulering">
                  <Input type="date" value={indexOn} onChange={(e) => setIndexOn(e.target.value)} />
                </Field>
              )}
              {showUnit && (
                <Field label="Ledig fra">
                  <Input type="date" value={vacantSince} onChange={(e) => setVacantSince(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Utflytting">
                  <Input type="date" value={moveOutOn} onChange={(e) => setMoveOutOn(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Nøkkel">
                  <Input type="date" value={keysOn} onChange={(e) => setKeysOn(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Vedtak">
                  <Input type="date" value={vedtakOn} onChange={(e) => setVedtakOn(e.target.value)} />
                </Field>
              )}
              {showUnit && (
                <Field label="Areal" hint="Kvadratmeter">
                  <Input inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} />
                </Field>
              )}
              {showUnit && kind === "bolig" && (
                <Field label="Rom">
                  <Input inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Behov">
                  <Input value={need} onChange={(e) => setNeed(e.target.value)} />
                </Field>
              )}
              {showLease && (
                <Field label="Husstand">
                  <Input value={household} onChange={(e) => setHousehold(e.target.value)} />
                </Field>
              )}
            </div>
          </>
        )}
      </FormShell>
      {dialog}
    </>
  );
}

export function LeasePlaceList({ places, canEdit }: { places: DeskPlace[]; canEdit: boolean }) {
  const { orgId } = useOrg();
  const [edit, setEdit] = useState<{ leaseId: string } | { unitId: string } | { caseId: string } | null>(null);
  if (places.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {places.map((p) => {
          const target = p.caseId ? { caseId: p.caseId } : p.leaseId ? { leaseId: p.leaseId } : { unitId: p.unitId ?? "" };
          const inner = (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{p.title}</div>
                <div className="truncate text-[12.5px] text-muted">{p.place}</div>
              </div>
              <div className="text-[13px] text-ink-2 tabular-nums">{p.line}</div>
            </>
          );
          return (
            <div key={`${p.leaseId ?? ""}-${p.unitId ?? ""}`} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3">
              {p.caseId ? (
                <Link to={`/o/${orgId}/pult/${p.caseId}`} className="flex min-w-0 flex-1 items-center gap-3">
                  {inner}
                </Link>
              ) : (
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => canEdit && setEdit(target)}>
                  {inner}
                </button>
              )}
              {canEdit && (
                <IconButton label="Rediger" onClick={() => setEdit(target)}>
                  <Pencil className="size-4" />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      <LeaseEditModal open={edit != null} target={edit} onClose={() => setEdit(null)} />
    </>
  );
}

export function BuildingLeases({ buildingId, showEmpty }: { buildingId: string; showEmpty: boolean }) {
  const { canEdit } = useOrg();
  const places = useOrgQuery<DeskPlace[]>(`/desk/buildings/${buildingId}`);
  const [add, setAdd] = useState(false);
  const rows = places.data ?? [];
  if (!showEmpty && rows.length === 0) return null;
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Leieobjekter</h2>
        {canEdit && (
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdd(true)}>
            Legg til
          </Button>
        )}
      </div>
      {places.isLoading ? (
        <p className="text-[13.5px] text-muted">Henter leieobjekter …</p>
      ) : rows.length === 0 ? (
        <p className="text-[13.5px] text-muted">Ingen leieobjekter i bygget ennå.</p>
      ) : (
        <LeasePlaceList places={rows} canEdit={canEdit} />
      )}
      <LeaseCreateModal open={add} onClose={() => setAdd(false)} buildingId={buildingId} />
    </section>
  );
}
