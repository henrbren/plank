import { useState, type FormEvent } from "react";
import { useOrgApi } from "@/lib/app";
import { formatArea } from "@/lib/format";
import { Button, Modal, useToast } from "@/components/ui";

interface DraftRoom {
  key: string;
  number: string | null;
  name: string;
  usage: string | null;
  area: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  d: number | null;
  on: boolean;
}
interface DraftFloor {
  key: string;
  name: string;
  level: number;
  rooms: DraftRoom[];
}
interface PlanResponse {
  documentId: string;
  note: string;
  floors: { name: string; level: number; rooms: Omit<DraftRoom, "key" | "on">[] }[];
}

export function FloorplanModal({ open, onClose, onCreated, buildingId }: { open: boolean; onClose: () => void; onCreated?: (result: { modelId: string | null }) => void; buildingId: string }) {
  const call = useOrgApi();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<"read" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [floors, setFloors] = useState<DraftFloor[] | null>(null);
  const [bim, setBim] = useState(true);

  const reset = () => {
    setFile(null);
    setBusy(null);
    setError(null);
    setNote(null);
    setFloors(null);
    setBim(true);
  };

  const close = () => {
    reset();
    onClose();
  };

  const read = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy("read");
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const plan = await call<PlanResponse>(`/portfolio/buildings/${buildingId}/floorplan`, { form }, false);
      setNote(plan.note || null);
      setFloors(
        plan.floors.map((floor, fi) => ({
          key: `f${fi}`,
          name: floor.name,
          level: floor.level,
          rooms: floor.rooms.map((room, ri) => ({ ...room, x: room.x ?? null, y: room.y ?? null, w: room.w ?? null, d: room.d ?? null, key: `f${fi}r${ri}`, on: true })),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke lese plantegningen");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!floors) return;
    const payload = floors
      .map((floor) => ({
        name: floor.name,
        level: floor.level,
        rooms: floor.rooms.filter((r) => r.on).map(({ number, name, usage, area, x, y, w, d }) => ({ number, name, usage, area, x, y, w, d })),
        hadRooms: floor.rooms.length > 0,
      }))
      .filter((floor) => floor.rooms.length > 0 || !floor.hadRooms)
      .map(({ name, level, rooms }) => ({ name, level, rooms }));
    if (payload.length === 0) {
      setError("Velg minst én etasje.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const result = await call<{ modelId: string | null; layout: "plan" | "rekke" | null }>(`/portfolio/buildings/${buildingId}/floorplan/apply`, { body: { floors: payload, bim } });
      onCreated?.(result);
      if (result.layout === "rekke") toast("Vi så ikke hvordan rommene ligger, så 3D-modellen ble en forenklet rekke. Prøv et tydeligere bilde av plantegningen.", "bad");
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke legge inn etasjene");
      setBusy(null);
    }
  };

  const toggleRoom = (floorKey: string, roomKey: string) => {
    setFloors((prev) => prev?.map((floor) => (floor.key === floorKey ? { ...floor, rooms: floor.rooms.map((room) => (room.key === roomKey ? { ...room, on: !room.on } : room)) } : floor)) ?? null);
  };

  const toggleFloor = (floorKey: string, on: boolean) => {
    setFloors((prev) => prev?.map((floor) => (floor.key === floorKey ? { ...floor, rooms: floor.rooms.map((room) => ({ ...room, on })) } : floor)) ?? null);
  };

  const selected = floors?.reduce((n, floor) => n + floor.rooms.filter((r) => r.on).length, 0) ?? 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Les plantegning"
      size="lg"
      footer={
        floors ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={busy === "save"}>
              Velg en annen fil
            </Button>
            {floors.length > 0 && (
              <Button variant="primary" loading={busy === "save"} disabled={selected === 0 && floors.every((f) => f.rooms.length > 0)} onClick={() => void save()}>
                {bim && selected > 0 ? `Legg inn ${selected} rom og BIM` : `Legg inn ${selected > 0 ? `${selected} rom` : "etasjene"}`}
              </Button>
            )}
          </>
        ) : null
      }
    >
      {!floors ? (
        <form onSubmit={read}>
          <p className="text-[14px] leading-relaxed text-ink-2">
            Last opp PDF eller bilde av plantegningen. Vi leser etasjer, romnummer og arealer som står på tegningen, og kan lage en BIM-modell der rommene er koblet til bygget. Du ser forslaget før noe legges inn.
          </p>
          <input
            className="mt-4 block w-full text-[13.5px] file:mr-3 file:rounded-lg file:border file:border-line file:bg-panel-2 file:px-3 file:py-1.5 file:text-[13px]"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-2 text-[12.5px] text-muted">Helst under 15 MB. Et tydelig bilde av én etasje leses best.</p>
          {error && <p className="mt-3 text-[13.5px] text-bad">{error}</p>}
          <Button className="mt-4" type="submit" variant="primary" loading={busy === "read"} disabled={!file}>
            {busy === "read" ? "Leser tegningen …" : "Les plantegningen"}
          </Button>
          {busy === "read" && <p className="mt-2 text-[12.5px] text-muted">Dette kan ta et minutt.</p>}
        </form>
      ) : (
        <div>
          <p className="text-[14px] leading-relaxed text-ink-2">Tegningen er lagret under Dokumenter. Ta bort rom som er feil, og legg inn resten.</p>
          {note && <p className="mt-3 rounded-xl bg-panel-2 px-4 py-3 text-[13.5px] text-ink-2">{note}</p>}
          {floors.length === 0 ? (
            <p className="mt-4 text-[14px] text-ink-2">Vi fant ingen etasjer på tegningen. Prøv et tydeligere bilde, eller legg inn etasjen selv.</p>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              {floors.map((floor) => {
                const allOn = floor.rooms.length > 0 && floor.rooms.every((r) => r.on);
                const someOn = floor.rooms.some((r) => r.on);
                return (
                  <section key={floor.key}>
                    <label className="flex items-center gap-2 text-[14px] font-medium">
                      {floor.rooms.length > 0 && (
                        <input
                          type="checkbox"
                          className="size-4 accent-current"
                          checked={allOn}
                          ref={(el) => {
                            if (el) el.indeterminate = someOn && !allOn;
                          }}
                          onChange={() => toggleFloor(floor.key, !allOn)}
                        />
                      )}
                      {floor.name}
                      <span className="text-[12.5px] font-normal text-muted">{floor.rooms.length === 0 ? "ingen rom lest" : `${floor.rooms.length} rom`}</span>
                    </label>
                    {floor.rooms.length > 0 && (
                      <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                        {floor.rooms.map((room) => (
                          <li key={room.key}>
                            <label className="flex items-center gap-3 px-3 py-2 text-[13.5px]">
                              <input type="checkbox" className="size-4 accent-current" checked={room.on} onChange={() => toggleRoom(floor.key, room.key)} />
                              <span className="min-w-0 flex-1 truncate">
                                {room.number ? `${room.number} ${room.name}` : room.name}
                                {room.usage ? <span className="text-muted"> · {room.usage}</span> : null}
                              </span>
                              <span className="shrink-0 tabular-nums text-muted">{room.area != null ? formatArea(room.area) : ""}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {selected > 0 && (
            <label className="mt-4 flex items-start gap-2 text-[13.5px] text-ink-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-current" checked={bim} onChange={(e) => setBim(e.target.checked)} />
              <span>
                Lag BIM-modell
                <span className="mt-0.5 block text-[12.5px] text-muted">Etasjer, dekke og rom i 3D, koblet til de samme rommene. Plasseringen følger tegningen når veggene er lesbare.</span>
              </span>
            </label>
          )}
          {error && <p className="mt-3 text-[13.5px] text-bad">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
