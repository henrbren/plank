import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Box, ChevronRight, Eye, EyeOff, Layers, Maximize, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { Document, Floor, IfcSummary } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Badge, Button, Checkbox, ErrorState, IconButton, Loading, useConfirm, useToast } from "@/components/ui";
import { ComponentFormModal } from "@/components/forms";
import { IfcViewer, type SelectedElement } from "./viewer";

export default function ModelPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { orgId } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const panel = useAgentPanel();
  const doc = useOrgQuery<Document>(`/documents/${id}`);
  const summary = useOrgQuery<IfcSummary | null>(`/ifc/summary/${id}`);
  const building = useOrgQuery<{ id: string; name: string; property_id: string; floors: Floor[] }>(doc.data?.building_id ? `/portfolio/buildings/${doc.data.building_id}` : null);
  useSetFocus("document", id, doc.data?.title);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<IfcViewer | null>(null);
  const [progress, setProgress] = useState<string>("Laster ned modellen …");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [storeys, setStoreys] = useState<{ id: number; name: string; guid: string }[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const [importing, setImporting] = useState(false);
  const [createLocations, setCreateLocations] = useState(true);
  const [newComponent, setNewComponent] = useState(false);
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});

  // Last og vis modellen
  useEffect(() => {
    if (!containerRef.current || !doc.data) return;
    let cancelled = false;
    const viewer = new IfcViewer(containerRef.current);
    viewerRef.current = viewer;
    (async () => {
      try {
        const res = await fetch(`/api/orgs/${orgId}/documents/${id}/file`, { credentials: "same-origin" });
        if (!res.ok || !res.body) throw new Error(`Kunne ikke laste ned filen (${res.status})`);
        const total = Number(res.headers.get("content-length") ?? doc.data!.size);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (!cancelled) setProgress(`Laster ned modellen … ${Math.round((received / Math.max(total, 1)) * 100)} %`);
        }
        const data = new Uint8Array(received);
        let offset = 0;
        for (const c of chunks) {
          data.set(c, offset);
          offset += c.length;
        }
        if (cancelled) return;
        await viewer.load(data, (m) => !cancelled && setProgress(m));
        if (cancelled) return;
        setStoreys(viewer.getStoreyList());
        setTypeCounts(viewer.typeCounts());
        setReady(true);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : "Kunne ikke vise modellen");
      }
    })();
    return () => {
      cancelled = true;
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [doc.data?.id, orgId, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const floorByGuid = useMemo(() => new Map((building.data?.floors ?? []).filter((f) => f.ifc_guid).map((f) => [f.ifc_guid!, f.id])), [building.data]);

  const onClick = async (e: React.MouseEvent) => {
    const v = viewerRef.current;
    if (!v || !ready) return;
    // Ignorer dra-bevegelser
    const down = (e.currentTarget as HTMLElement).dataset.down?.split(",").map(Number);
    if (down && Math.hypot(e.clientX - down[0]!, e.clientY - down[1]!) > 4) return;
    const hit = v.pick(e.clientX, e.clientY);
    v.select(hit);
    setSelected(hit != null ? await v.describe(hit) : null);
  };

  const runImport = async () => {
    const v = viewerRef.current;
    if (!v) return;
    setImporting(true);
    try {
      const st = await v.getStoreys();
      const elements = v.getElements();
      const res = await call<{ elements: number; floors_created: number; rooms_created: number; rooms_updated: number }>("/ifc/import", {
        body: {
          document_id: id,
          schema: v.schema,
          storeys: st.map((s) => ({ guid: s.guid, name: s.name, elevation: s.elevation, spaces: s.spaces.map((sp) => ({ guid: sp.guid, name: sp.name, long_name: sp.long_name, area: sp.area })) })),
          elements: elements.slice(0, 30000),
          create_locations: createLocations && Boolean(doc.data?.building_id),
        },
      });
      toast(`Indekserte ${res.elements} elementer${res.floors_created || res.rooms_created ? ` · ${res.floors_created} etasjer og ${res.rooms_created} rom opprettet` : ""}`, "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Import feilet", "bad");
    } finally {
      setImporting(false);
    }
  };

  if (doc.isLoading) return <Loading />;
  if (doc.error) return <ErrorState error={doc.error} />;
  const d = doc.data!;
  const remove = async () => {
    if (!(await confirm({ title: "Slette BIM-modellen?", message: `«${d.title}» og indeksen slettes. Etasjer og rom i registeret beholdes.`, confirm: "Slett", danger: true }))) return;
    await call(`/documents/${d.id}`, { method: "DELETE" });
    toast("BIM-modellen er slettet");
    navigate(d.building_id ? `/o/${orgId}/buildings/${d.building_id}?tab=bim` : `/o/${orgId}/documents`);
  };
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return (
    <div className="flex h-full flex-col">
      {dialog}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            {d.building_id ? (
              <Link to={`/o/${orgId}/buildings/${d.building_id}?tab=bim`} className="hover:text-ink">
                {d.building_name}
              </Link>
            ) : (
              <Link to={`/o/${orgId}/documents`} className="hover:text-ink">
                Dokumenter
              </Link>
            )}
            <ChevronRight className="size-3" />
            <span>BIM</span>
          </div>
          <div className="flex items-center gap-2">
            <Box className="size-4 text-info" />
            <h1 className="truncate text-[15px] font-semibold">{d.title}</h1>
            <span className="hidden text-[12px] text-muted sm:inline">
              {formatBytes(d.size)}
              {viewerRef.current && ready ? ` · ${viewerRef.current.schema}` : ""}
            </span>
          </div>
        </div>
        <Button size="sm" icon={<Sparkles className="size-3.5" />} disabled={!summary.data} onClick={() => panel.ask(`Gi meg en oversikt over BIM-modellen «${d.title}»: etasjer, rom og mengder per elementtype.`)}>
          Analyser modellen
        </Button>
        <IconButton label="Tilpass visning" onClick={() => viewerRef.current?.fit()}>
          <Maximize className="size-4" />
        </IconButton>
        <IconButton label="Vis/skjul panel" active={showPanel} onClick={() => setShowPanel((s) => !s)}>
          <Layers className="size-4" />
        </IconButton>
        <IconButton label="Slett modell" onClick={() => void remove()}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {showPanel && (
          <div className="absolute inset-y-0 left-0 z-10 flex w-72 flex-col overflow-y-auto border-r border-line bg-panel/95 backdrop-blur sm:static sm:bg-panel">
            <div className="border-b border-line p-4">
              <div className="mb-1 text-[12px] font-semibold tracking-wide text-muted uppercase">Indeks for agenter</div>
              {summary.data ? (
                <p className="text-[12.5px] text-ink-2">
                  Indeksert {formatDateTime(summary.data.indexed_at)} · {Object.values(summary.data.stats?.by_type ?? {}).reduce((a, n) => a + n, 0)} elementer
                </p>
              ) : (
                <p className="text-[12.5px] text-ink-2">Modellen er ikke indeksert ennå. Indekser den for å la agentene spørre mot den.</p>
              )}
              {d.building_id && (
                <div className="-mx-2 mt-1">
                  <Checkbox checked={createLocations} onChange={setCreateLocations} label="Importer etasjer og rom" description={`Opprettes i «${d.building_name}» (matches på GUID)`} />
                </div>
              )}
              <Button size="sm" variant={summary.data ? "secondary" : "accent"} className="mt-2 w-full" loading={importing} disabled={!ready} onClick={runImport}>
                {summary.data ? "Indekser på nytt" : "Indekser modellen"}
              </Button>
            </div>
            <div className="p-4">
              <div className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Etasjer</div>
              {storeys.length === 0 && <div className="text-[12.5px] text-muted">{ready ? "Ingen etasjer i modellen." : "…"}</div>}
              <ul className="-mx-1.5">
                {storeys.map((s) => {
                  const isHidden = hidden.has(s.id);
                  return (
                    <li key={s.id} className="group flex items-center gap-1 rounded-md px-1.5 hover:bg-panel-2">
                      <button
                        className="min-w-0 flex-1 truncate py-1.5 text-left text-[13px]"
                        title="Vis bare denne etasjen"
                        onClick={() => {
                          viewerRef.current?.isolateStorey(s.id);
                          setHidden(new Set(storeys.filter((x) => x.id !== s.id).map((x) => x.id)));
                        }}
                      >
                        {s.name}
                        {floorByGuid.has(s.guid) && <span className="ml-1.5 text-[11px] text-ok">i Plank</span>}
                      </button>
                      <IconButton
                        label={isHidden ? "Vis" : "Skjul"}
                        size="sm"
                        onClick={() => {
                          viewerRef.current?.setStoreyVisible(s.id, isHidden);
                          const next = new Set(hidden);
                          if (isHidden) next.delete(s.id);
                          else next.add(s.id);
                          setHidden(next);
                        }}
                      >
                        {isHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
              {hidden.size > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 -ml-2"
                  onClick={() => {
                    viewerRef.current?.isolateStorey(null);
                    setHidden(new Set());
                  }}
                >
                  Vis alle
                </Button>
              )}
              {topTypes.length > 0 && (
                <>
                  <div className="mt-5 mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Elementtyper</div>
                  <ul className="space-y-1 text-[12.5px]">
                    {topTypes.map(([t, n]) => (
                      <li key={t} className="flex justify-between gap-2">
                        <span className="truncate font-mono text-[11.5px] text-ink-2">{t.replace(/^IFC/, "")}</span>
                        <span className="text-muted tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}

        <div
          className="relative min-w-0 flex-1 bg-[radial-gradient(ellipse_at_top,var(--panel)_0%,var(--panel-2)_70%)]"
          onPointerDown={(e) => ((e.currentTarget as HTMLElement).dataset.down = `${e.clientX},${e.clientY}`)}
          onClick={onClick}
        >
          <div ref={containerRef} className="absolute inset-0" />
          {!ready && !error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-4 py-2.5 text-[13px] text-ink-2 shadow-card">
                <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                {progress || "Laster …"}
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-md rounded-xl border border-bad/30 bg-bad-soft p-4 text-[13.5px] text-bad">{error}</div>
            </div>
          )}
          {ready && !selected && <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-[12px] whitespace-nowrap text-bg">Klikk på et element for å se egenskaper</div>}
        </div>

        {selected && (
          <div className="absolute inset-y-0 right-0 z-10 flex w-80 max-w-full flex-col border-l border-line bg-panel shadow-pop sm:static sm:shadow-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-2 border-b border-line p-4">
              <div className="min-w-0 flex-1">
                <Badge tone="info">{selected.type.replace(/^IFC/, "")}</Badge>
                <div className="mt-1.5 text-[14.5px] font-semibold break-words">{selected.name ?? "Uten navn"}</div>
                {selected.storey && <div className="text-[12.5px] text-muted">{selected.storey}</div>}
              </div>
              <IconButton
                label="Lukk"
                size="sm"
                onClick={() => {
                  viewerRef.current?.select(null);
                  setSelected(null);
                }}
              >
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12.5px]">
              <div className="mb-3 font-mono text-[11.5px] break-all text-muted">GUID {selected.guid}</div>
              {selected.attributes.length > 0 && (
                <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {selected.attributes.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted">{k}</dt>
                      <dd className="break-words">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {selected.psets.map((p) => (
                <details key={p.name} className="mb-2 rounded-lg border border-line" open={selected.psets.length <= 2}>
                  <summary className="cursor-pointer px-2.5 py-1.5 font-medium">{p.name}</summary>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line px-2.5 py-2">
                    {p.values.map(([k, v], i) => (
                      <div key={i} className="contents">
                        <dt className="text-muted">{k}</dt>
                        <dd className="break-words">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-line p-3">
              <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!d.building_id} onClick={() => setNewComponent(true)}>
                Registrer som komponent
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Sparkles className="size-3.5" />}
                onClick={() => panel.ask(`Fortell meg om IFC-elementet «${selected.name ?? selected.type}» (${selected.type}, GUID ${selected.guid}) i modellen «${d.title}». Finnes det i FDV-registeret, og hva bør vi vite om drift og vedlikehold?`)}
              >
                Spør agenten om elementet
              </Button>
            </div>
          </div>
        )}
      </div>
      <ComponentFormModal
        open={newComponent}
        onClose={() => setNewComponent(false)}
        defaults={{
          property_id: building.data?.property_id,
          building_id: d.building_id ?? undefined,
          floor_id: selected?.storeyGuid ? floorByGuid.get(selected.storeyGuid) : undefined,
          ifc_guid: selected?.guid ?? undefined,
          name: selected?.name ?? undefined,
        }}
      />
    </div>
  );
}

