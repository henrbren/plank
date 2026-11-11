import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Download, Ellipsis, FileText, Pencil, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { DOCUMENT_KINDS, type Component, type Document, type DocumentBrief, type DocumentPlace, type SearchHit } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatBytes, formatDate, formatDateTime, formatOrgNr } from "@/lib/format";
import { DocKindBadge, DocStatus } from "@/components/domain";
import { Button, ButtonLink, Card, EmptyState, ErrorState, Field, IconButton, Input, KeyValues, Loading, Menu, MenuItem, Modal, PageHeader, Select, Tabs, Textarea, useConfirm, useToast } from "@/components/ui";
import { LocationPicker, UploadModal, type LocationValue } from "@/components/forms";
import { Markdown } from "@/features/chat/transcript";
import { DocumentChat, DocumentRail } from "@/features/documents/DocumentRail";
import { PlanLink, TrialNote } from "@/features/billing/TrialNote";

function placeKey(place: Pick<DocumentPlace, "kind" | "id">): string {
  return `${place.kind}:${place.id}`;
}

function docCountLabel(count: number): string {
  return count === 1 ? "1 dokument" : `${count} dokumenter`;
}

function previewOf(doc: { mime: string; filename: string }): "pdf" | "image" | "text" | null {
  const ext = doc.filename.split(".").pop()?.toLowerCase() ?? "";
  const generic = doc.mime === "application/octet-stream" || doc.mime === "binary/octet-stream" || doc.mime === "" || doc.mime === "text/plain";
  if (doc.mime === "application/pdf" || ext === "pdf") return "pdf";
  if ((doc.mime.startsWith("image/") && doc.mime !== "image/svg+xml") || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (doc.mime === "text/plain" || (generic && ext === "txt")) return "text";
  return null;
}

function visiblePlaces(items: DocumentPlace[], q: string, kind: "all" | "building" | "property"): DocumentPlace[] {
  const needle = q.trim().toLowerCase();
  return items.filter((item) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (!needle) return true;
    const kindWord = item.kind === "property" ? "eiendom" : item.kind === "building" ? "bygg" : "uten plassering";
    return [item.name, item.address, item.number, kindWord].join(" ").toLowerCase().includes(needle);
  });
}

function briefsFor(place: DocumentPlace, rows: DocumentBrief[]): DocumentBrief[] {
  if (place.kind === "loose") return rows.filter((d) => !d.property_id && !d.building_id);
  if (place.kind === "building") return rows.filter((d) => d.building_id === place.id);
  return rows.filter((d) => d.property_id === place.id);
}

export function DocumentsPage() {
  const { orgId, canEdit } = useOrg();
  const navigate = useNavigate();
  useSetFocus("org");
  const [params, setParams] = useSearchParams();
  const propertyId = params.get("eiendom") ?? "";
  const vis = params.get("vis") ?? (propertyId ? `property:${propertyId}` : "");
  const [kind, setKind] = useState<"all" | "building" | "property">("all");
  const [q, setQ] = useState("");
  const [textQ, setTextQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [upload, setUpload] = useState(false);
  const pushed = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(textQ.trim()), 250);
    return () => clearTimeout(t);
  }, [textQ]);
  const catalog = useOrgQuery<DocumentPlace[]>("/documents/catalog", {
    refetchInterval: (state) => ((state.state.data as DocumentPlace[] | undefined)?.some((p) => !p.files_ready) ? 5000 : false),
  });
  const briefs = useOrgQuery<DocumentBrief[]>("/documents?brief=1&limit=5000", {
    staleTime: 30_000,
    refetchInterval: (state) => ((state.state.data as DocumentBrief[] | undefined)?.some((d) => d.status === "processing") ? 3000 : false),
  });
  const hits = useOrgQuery<SearchHit[]>(debounced.length >= 2 ? `/documents/search?q=${encodeURIComponent(debounced)}` : null, {
    placeholderData: (prev) => prev,
  });
  const items = catalog.data ?? [];
  const visible = visiblePlaces(items, q, kind);
  const selected = items.find((item) => placeKey(item) === vis) ?? null;
  const selectedRows = useMemo(() => (selected ? briefsFor(selected, briefs.data ?? []) : []), [selected, briefs.data]);
  const buildings = items.filter((item) => item.kind === "building").length;
  const properties = items.filter((item) => item.kind === "property").length;
  const summary = items.length === 0 ? "" : `${buildings} bygg · ${properties} eiendommer${visible.length !== items.length ? ` · ${visible.length} synlige` : ""}`;

  const openPlace = useCallback((key: string, docId?: string) => {
    const next = new URLSearchParams(params);
    next.delete("eiendom");
    next.set("vis", key);
    if (docId) next.set("dok", docId);
    else next.delete("dok");
    pushed.current = true;
    setParams(next);
  }, [params, setParams]);

  const closePlace = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete("vis");
    next.delete("dok");
    next.delete("eiendom");
    setParams(next, { replace: true });
  }, [navigate, params, setParams]);

  useEffect(() => {
    if (!vis) pushed.current = false;
  }, [vis]);

  useEffect(() => {
    if (!selected || upload) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      closePlace();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, upload, closePlace]);

  const uploadDefaults = selected?.kind === "building"
    ? { property_id: selected.property_id ?? "", building_id: selected.id, floor_id: "", room_id: "" }
    : selected?.kind === "property"
      ? { property_id: selected.id, building_id: "", floor_id: "", room_id: "" }
      : undefined;

  return (
    <div className="px-5 py-7 sm:px-8">
      <PageHeader
        icon={<FileText className="size-5" />}
        title="Dokumenter"
        subtitle="FDV-dokumentasjon, produktdatablad, tegninger, rapporter og IFC-modeller. Tekst hentes ut og indekseres automatisk."
        actions={
          canEdit && (
            <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setUpload(true)}>
              Last opp
            </Button>
          )
        }
      />
      <TrialNote>
        Teksten i dokumentene blir søkbar for agenten. Abonnementet er det som gir den en fast pott AI-bruk hver måned. <PlanLink>Se planene</PlanLink>
      </TrialNote>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="min-w-60 flex-1">
          <Input type="search" placeholder="Søk på navn, adresse eller nummer" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="w-auto min-w-48" value={kind} onChange={(e) => setKind(e.target.value as "all" | "building" | "property")}>
          <option value="all">Bygg og eiendommer</option>
          <option value="building">Bare bygg</option>
          <option value="property">Bare eiendommer</option>
        </Select>
        <div className="relative min-w-52 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Søk i innholdet …" value={textQ} onChange={(e) => setTextQ(e.target.value)} />
        </div>
      </div>
      {summary && <p className="mb-3 text-[13px] text-muted">{summary}</p>}

      {debounced.length >= 2 ? (
        hits.isLoading && !hits.data ? (
          <Loading label="Søker …" />
        ) : hits.data?.length ? (
          <div className={hits.isFetching ? "flex flex-col gap-2 opacity-70" : "flex flex-col gap-2"}>
            {hits.data.map((h) => {
              const doc = briefs.data?.find((d) => d.id === h.document_id);
              const key = doc ? (doc.building_id ? `building:${doc.building_id}` : doc.property_id ? `property:${doc.property_id}` : "loose:loose") : "";
              return (
                <Link
                  key={h.document_id}
                  to={`/o/${orgId}/documents/${h.document_id}`}
                  onClick={(event) => {
                    if (!key || !items.some((item) => placeKey(item) === key)) return;
                    event.preventDefault();
                    openPlace(key, h.document_id);
                  }}
                  className="rounded-xl border border-line bg-panel p-4 hover:border-line-strong"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-muted" />
                    <span className="font-medium">{h.title}</span>
                    <DocKindBadge kind={h.kind} />
                    {h.building_name && <span className="text-[12px] text-muted">{h.building_name}</span>}
                  </div>
                  <p className="mt-2 line-clamp-3 text-[13px] whitespace-pre-line text-ink-2">
                    {h.snippet.split(/(«[^»]*»)/).map((part, i) =>
                      part.startsWith("«") ? (
                        <mark key={i} className="rounded bg-accent-soft px-0.5 text-ink">
                          {part.slice(1, -1)}
                        </mark>
                      ) : (
                        part
                      ),
                    )}
                  </p>
                </Link>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={<Search className="size-5" />} title="Ingen treff" description="Prøv færre eller andre ord. Tøm feltet for å se eiendommene." />
        )
      ) : catalog.isLoading ? (
        <Loading label="Henter bygg og eiendommer …" />
      ) : catalog.error ? (
        <ErrorState error={catalog.error} />
      ) : items.length === 0 ? (
        <EmptyState icon={<FileText className="size-5" />} title="Ingen eiendommer" description="Legg inn eiendommer og bygg, så samles dokumentene her." action={canEdit ? <Button onClick={() => setUpload(true)}>Last opp</Button> : undefined} />
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-[13.5px] text-muted">Ingen treff.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[0.7rem]">
          {visible.map((item) => {
            const key = placeKey(item);
            return (
              <button
                key={key}
                type="button"
                onClick={() => openPlace(key)}
                className="cursor-pointer rounded-xl border border-line bg-panel px-[0.95rem] py-[0.85rem] text-left font-[inherit] text-[inherit] [content-visibility:auto] hover:border-[#9eb0c8]"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className={`inline-block rounded-full px-[0.45rem] py-[0.12rem] text-[11px] font-bold ${item.kind === "property" ? "bg-[#ede9fe] text-[#5b21b6]" : item.kind === "building" ? "bg-[#e8eef6] text-[#314866]" : "bg-[#f2f4f7] text-[#667085]"}`}>
                    {item.kind === "property" ? "Eiendom" : item.kind === "building" ? "Bygg" : "Uten plassering"}
                  </span>
                  {!item.files_ready ? (
                    <span className="rounded-full bg-[#fff7ed] px-2 py-[0.16rem] text-[11.5px] font-semibold whitespace-nowrap text-[#9a3412]">Hentes …</span>
                  ) : (
                    <span className={`rounded-full px-2 py-[0.16rem] text-[11.5px] whitespace-nowrap ${item.document_count > 0 ? "bg-[#dcfce7] font-extrabold text-[#166534]" : "bg-[#f2f4f7] font-semibold text-[#98a2b3]"}`}>
                      {docCountLabel(item.document_count)}
                    </span>
                  )}
                </div>
                <div className="text-[14.5px] font-bold">{item.name}</div>
                {item.address && <div className="mt-0.5 text-[12px] text-muted">{item.address}</div>}
                {item.number && <div className="mt-0.5 font-mono text-[12px] text-muted">{item.number}</div>}
              </button>
            );
          })}
        </div>
      )}
      {selected && (
        <PlaceDocuments
          orgId={orgId}
          place={selected}
          rows={selectedRows}
          loading={briefs.isLoading}
          error={briefs.error}
          initialId={params.get("dok")}
          onClose={closePlace}
        />
      )}
      <UploadModal open={upload} onClose={() => setUpload(false)} defaults={uploadDefaults} />
    </div>
  );
}

/** Holder forrige side synlig til den neste er lastet, så byttet ikke blinker hvitt. */
function HeldPreview({ url, title, mode }: { url: string; title: string; mode: "frame" | "image" }) {
  const urlRef = useRef(url);
  urlRef.current = url;
  const loaded = useRef(new Set<string>());
  const [slotA, setSlotA] = useState(url);
  const [slotB, setSlotB] = useState<string | null>(null);
  const [showB, setShowB] = useState(false);
  const [painted, setPainted] = useState(false);
  const visible = showB && slotB ? slotB : slotA;

  useEffect(() => {
    if (url === visible) return;
    const ready = loaded.current.has(url);
    if (!showB && slotB === url && ready) {
      setShowB(true);
      setPainted(true);
      return;
    }
    if (showB && slotA === url && ready) {
      setShowB(false);
      setPainted(true);
      return;
    }
    if (!showB && slotB !== url) setSlotB(url);
    else if (showB && slotA !== url) setSlotA(url);
  }, [url, visible, showB, slotA, slotB]);

  useEffect(() => {
    if (url === visible) return;
    const t = window.setTimeout(() => {
      if (urlRef.current !== url) return;
      if (slotB === url) setShowB(true);
      else if (slotA === url) setShowB(false);
      setPainted(true);
    }, 2500);
    return () => window.clearTimeout(t);
  }, [url, visible, slotA, slotB]);

  const reveal = (event: SyntheticEvent<HTMLIFrameElement | HTMLImageElement>) => {
    const got = event.currentTarget.dataset.url;
    if (got) loaded.current.add(got);
    if (!got || got !== urlRef.current) return;
    setShowB(event.currentTarget.dataset.slot === "b");
    setPainted(true);
  };

  const hidden = "pointer-events-none opacity-0";
  const frame = "absolute inset-0 h-full w-full border-0 bg-white";
  return (
    <>
      {!painted && <div className="absolute inset-0 z-10 flex items-center justify-center text-[13.5px] text-muted">Åpner dokumentet …</div>}
      {url !== visible && <div className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-accent" />}
      {mode === "image" ? (
        <>
          <img src={slotA} alt="" data-slot="a" data-url={slotA} onLoad={reveal} className={`absolute inset-0 m-auto max-h-full max-w-full p-4 ${showB ? hidden : ""}`} />
          {slotB && <img src={slotB} alt={title} data-slot="b" data-url={slotB} onLoad={reveal} className={`absolute inset-0 m-auto max-h-full max-w-full p-4 ${showB ? "" : hidden}`} />}
        </>
      ) : (
        <>
          <iframe src={slotA} title={title} data-slot="a" data-url={slotA} onLoad={reveal} className={`${frame} ${showB ? hidden : ""}`} />
          {slotB && <iframe src={slotB} title={title} data-slot="b" data-url={slotB} onLoad={reveal} className={`${frame} ${showB ? "" : hidden}`} />}
        </>
      )}
    </>
  );
}

function PlaceDocuments({
  orgId,
  place,
  rows,
  loading,
  error,
  initialId,
  onClose,
}: {
  orgId: string;
  place: DocumentPlace;
  rows: DocumentBrief[];
  loading: boolean;
  error: unknown;
  initialId: string | null;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [about, setAbout] = useState(false);
  const [listQ, setListQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const previewArmed = useRef(false);
  const needle = listQ.trim().toLowerCase();
  const shown = needle ? rows.filter((d) => `${d.title} ${d.filename} ${d.building_name ?? ""}`.toLowerCase().includes(needle)) : rows;

  useEffect(() => {
    setListQ("");
    previewArmed.current = false;
    listRef.current?.focus();
  }, [place.kind, place.id]);

  useEffect(() => {
    if (!shown.length) return;
    setActiveId((cur) => {
      if (cur && shown.some((d) => d.id === cur)) return cur;
      if (initialId && shown.some((d) => d.id === initialId)) return initialId;
      return shown[0]!.id;
    });
  }, [place.kind, place.id, initialId, shown]);

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector(`[data-doc="${activeId}"]`);
    if (!(list && el instanceof HTMLElement)) return;
    // scrollIntoView hopper i sida, og content-visibility gjør at den ikke treffer lista.
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeId]);

  const active = rows.find((d) => d.id === activeId) ?? null;
  const detail = useOrgQuery<Document>(activeId ? `/documents/${activeId}` : null, {
    refetchInterval: (q) => ((q.state.data as Document | undefined)?.status === "processing" ? 2500 : false),
  });
  const railDoc = detail.data?.id === activeId ? detail.data : null;
  const railError = !railDoc && detail.error ? (detail.error instanceof Error ? detail.error.message : "Kunne ikke hente opplysningene.") : null;

  useEffect(() => {
    if (!about) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (window.matchMedia("(min-width: 1280px)").matches) return;
      event.stopImmediatePropagation();
      setAbout(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [about]);
  const fileUrl = active ? `/api/orgs/${orgId}/documents/${active.id}/file` : "";
  const preview = active ? previewOf(active) : null;
  const pageUrl = active ? (active.kind === "ifc" ? `/o/${orgId}/models/${active.id}` : `/o/${orgId}/documents/${active.id}`) : "";

  const onFocusIn = (event: ReactFocusEvent<HTMLElement>) => {
    if (previewArmed.current) return;
    if (event.target instanceof HTMLIFrameElement) listRef.current?.focus();
  };

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    const idx = shown.findIndex((d) => d.id === activeId);
    const next = event.key === "ArrowDown" ? shown[idx + 1] : shown[idx - 1];
    if (next) setActiveId(next.id);
  };

  return (
    <section ref={sectionRef} tabIndex={-1} className="fixed inset-0 z-[45] flex flex-col bg-bg text-ink outline-none" role="dialog" aria-modal="true" aria-label={place.name} onKeyDown={onListKey} onFocusCapture={onFocusIn}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-3 py-2.5">
        <Button size="sm" onClick={onClose}>Tilbake</Button>
        <div className="min-w-0">
          <div className="truncate font-bold">{place.name}</div>
          <div className="text-[12px] text-muted">
            {place.kind === "property" ? "Eiendom" : place.kind === "building" ? "Bygg" : "Uten plassering"}
            {place.number ? ` · ${place.number}` : ""}
            {rows.length ? ` · ${docCountLabel(rows.length)}` : ""}
          </div>
        </div>
        {active && (
          <div className="ml-auto flex gap-2">
            <Button size="sm" className="xl:hidden" aria-expanded={about} onClick={() => setAbout((open) => !open)}>
              Om filen
            </Button>
            <ButtonLink to={pageUrl} size="sm">{active.kind === "ifc" ? "Åpne modellen" : "Åpne"}</ButtonLink>
            <a href={`${fileUrl}?download=1`} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 text-[13px] font-medium hover:bg-panel-2">
              <Download className="size-3.5" />
              Last ned
            </a>
          </div>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:grid md:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]">
        <div className="flex max-h-[38vh] min-h-0 shrink-0 flex-col overflow-hidden border-b border-line md:h-full md:max-h-none md:shrink md:border-r md:border-b-0">
          {rows.length > 6 && (
            <div className="border-b border-line p-2">
              <Input value={listQ} onChange={(e) => setListQ(e.target.value)} placeholder="Filtrer i listen" aria-label="Filtrer i listen" />
            </div>
          )}
          <div ref={listRef} tabIndex={0} className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none">
            {loading ? (
              <div className="px-3.5 py-3 text-[13.5px] text-muted">Henter dokumenter …</div>
            ) : error ? (
              <div className="px-3.5 py-3 text-[13.5px] text-bad">{error instanceof Error ? error.message : "Kunne ikke hente dokumenter"}</div>
            ) : !place.files_ready && !rows.length ? (
              <div className="px-3.5 py-3 text-[13.5px] text-muted">Dokumentene hentes fortsatt inn.</div>
            ) : !rows.length ? (
              <div className="px-3.5 py-3 text-[13.5px] text-muted">Ingen dokumenter.</div>
            ) : !shown.length ? (
              <div className="px-3.5 py-3 text-[13.5px] text-muted">Ingen treff i listen.</div>
            ) : (
              shown.map((doc) => {
                const date = formatDate(doc.created_at);
                const where = place.kind === "property" ? doc.building_name : null;
                return (
                  <button
                    key={doc.id}
                    type="button"
                    data-doc={doc.id}
                    onClick={() => setActiveId(doc.id)}
                    className={`block w-full border-b border-line px-3.5 py-3 text-left ${doc.id === activeId ? "bg-panel-2" : "hover:bg-panel-2/70"}`}
                  >
                    <div className="text-[13.5px] font-semibold">{doc.title}</div>
                    <div className="mt-0.5 text-[12px] text-muted">{[where, date !== "–" ? date : null].filter(Boolean).join(" · ")}</div>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="relative min-h-0 flex-1 bg-panel-2" onMouseDown={() => { previewArmed.current = true; }}>
          {!active && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-[13.5px] text-muted">Velg et dokument.</div>}
          {active && active.kind === "ifc" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-[13.5px] text-muted">
              <span>IFC-modellen åpnes i viseren.</span>
              <ButtonLink to={pageUrl} variant="primary" size="sm">Åpne modellen</ButtonLink>
            </div>
          )}
          {active && active.kind !== "ifc" && (preview === "pdf" || preview === "text") && <HeldPreview key={preview} url={fileUrl} title={active.title} mode="frame" />}
          {active && active.kind !== "ifc" && preview === "image" && <HeldPreview key="image" url={fileUrl} title={active.title} mode="image" />}
          {active && active.kind !== "ifc" && !preview && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-[13.5px] text-muted">
              <span>Dokumentet kan ikke vises her.</span>
              <ButtonLink to={pageUrl} size="sm">Åpne dokumentet</ButtonLink>
            </div>
          )}
        </div>
      </div>
        <aside
          className={
            about
              ? "absolute inset-y-0 right-0 z-30 flex w-[min(100%,380px)] min-h-0 flex-col border-l border-line bg-panel shadow-pop xl:static xl:w-[340px] xl:shrink-0 xl:shadow-none"
              : "hidden min-h-0 w-[340px] shrink-0 flex-col border-l border-line bg-panel xl:flex"
          }
        >
          <DocumentRail
            orgId={orgId}
            doc={railDoc}
            loading={Boolean(activeId) && !railDoc && !railError && (detail.isLoading || detail.isFetching)}
            error={railError}
            onClose={() => setAbout(false)}
          />
        </aside>
      </div>
    </section>
  );
}

export function DocumentPage() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const doc = useOrgQuery<Document>(`/documents/${id}`, { refetchInterval: (q) => ((q.state.data as Document | undefined)?.status === "processing" ? 2500 : false) });
  const text = useOrgQuery<{ text: string; total_chars: number }>(doc.data && doc.data.status === "ready" ? `/documents/${id}/text` : null);
  useSetFocus("document", id, doc.data?.title);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [edit, setEdit] = useState(false);

  useEffect(() => {
    if (doc.data?.kind === "ifc") navigate(`/o/${orgId}/models/${id}`, { replace: true });
  }, [doc.data?.kind, id, orgId, navigate]);

  if (doc.isLoading) return <Loading />;
  if (doc.error) return <ErrorState error={doc.error} />;
  const d = doc.data!;
  const fileUrl = `/api/orgs/${orgId}/documents/${d.id}/file`;
  const preview = previewOf(d);
  const isPdf = preview === "pdf";
  const isImage = preview === "image";
  const hasPreview = isPdf || isImage;
  const activeTab = hasPreview ? tab : "text";

  const remove = async () => {
    if (!(await confirm({ title: "Slette dokumentet?", message: `«${d.title}» og den uttrukne teksten slettes permanent.`, confirm: "Slett", danger: true }))) return;
    await call(`/documents/${d.id}`, { method: "DELETE" });
    toast("Dokumentet er slettet");
    navigate(`/o/${orgId}/documents`);
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "Dokumenter", to: `/o/${orgId}/documents` }, ...(d.building_id ? [{ label: d.building_name ?? "Bygg", to: `/o/${orgId}/buildings/${d.building_id}` }] : [])]}
        icon={<FileText className="size-5" />}
        title={d.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <DocKindBadge kind={d.kind} />
            <DocStatus status={d.status} error={d.error} />
            <span>
              {d.filename} · {formatBytes(d.size)}
            </span>
          </span>
        }
        actions={
          <>
            <a href={`${fileUrl}?download=1`} className="inline-flex h-8.5 items-center gap-2 rounded-lg border border-line-strong bg-panel px-3 text-[13.5px] font-medium hover:bg-panel-2">
              <Download className="size-4" />
              Last ned
            </a>
            <Button variant="primary" icon={<Sparkles className="size-4" />} disabled={d.status !== "ready"} onClick={() => panel.ask(`Oppsummer dokumentet «${d.title}» (plank://document/${d.id}). Hva er det viktigste for drift og vedlikehold?`)}>
              Oppsummer
            </Button>
            <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
              {(close) => (
                <>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setEdit(true))}>
                    Rediger metadata
                  </MenuItem>
                  <MenuItem
                    icon={<RefreshCw className="size-4" />}
                    onClick={async () => {
                      close();
                      await call(`/documents/${d.id}/reprocess`, { method: "POST" });
                      toast("Dokumentet behandles på nytt");
                    }}
                  >
                    Behandle på nytt
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {hasPreview && (
            <Tabs
              value={activeTab}
              onChange={setTab}
              tabs={[
                { value: "preview", label: "Forhåndsvisning" },
                { value: "text", label: "Uttrukket tekst" },
              ]}
            />
          )}
          {activeTab === "preview" && isPdf && <iframe src={fileUrl} title={d.title} className="h-[75vh] w-full rounded-xl border border-line bg-panel" />}
          {activeTab === "preview" && isImage && <img src={fileUrl} alt={d.title} className="max-h-[75vh] rounded-xl border border-line" />}
          {activeTab === "text" && (
            <Card className="p-6">
              {d.status === "processing" ? (
                <Loading label="Henter ut tekst …" />
              ) : text.data?.text ? (
                <div className="max-w-3xl">
                  <Markdown text={text.data.text} orgId={orgId} />
                </div>
              ) : (
                <div className="text-[13.5px] text-muted">{d.status === "error" ? `Tekstuttrekk feilet: ${d.error}` : "Ingen tekst er hentet ut fra denne filen."}</div>
              )}
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {d.summary && (
            <Card>
              <div className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Sammendrag</div>
              <p className="text-[13.5px] leading-relaxed text-ink-2">{d.summary}</p>
            </Card>
          )}
          <ExtractCard orgId={orgId} doc={d} />
          <Card>
            <KeyValues
              items={[
                ["Type", DOCUMENT_KINDS[d.kind]],
                ["NS 3451", d.ns3451],
                ["Bygg", d.building_id ? <Link className="hover:underline" to={`/o/${orgId}/buildings/${d.building_id}`}>{d.building_name}</Link> : d.property_name],
                ["Komponent", d.component_id ? <Link className="hover:underline" to={`/o/${orgId}/components/${d.component_id}`}>{d.extracted?.component || "Åpne komponenten"}</Link> : d.extracted?.component],
                ["Tegn", d.text_chars ? new Intl.NumberFormat("nb-NO").format(d.text_chars) : null],
                ["Lastet opp", formatDateTime(d.created_at)],
              ]}
            />
          </Card>
          <DocumentChat orgId={orgId} docId={d.id} title={d.title} className="overflow-hidden rounded-xl border" />
        </div>
      </div>
      <DocumentEditModal open={edit} onClose={() => setEdit(false)} doc={d} />
      {dialog}
    </div>
  );
}

function ExtractCard({ orgId, doc }: { orgId: string; doc: Document }) {
  const x = doc.extracted;
  if (!x) return null;
  const items: [string, string][] = [];
  if (x.supplier) items.push(["Leverandør", x.supplier_org_nr ? `${x.supplier} · ${formatOrgNr(x.supplier_org_nr)}` : x.supplier]);
  if (x.manufacturer) items.push(["Produsent", x.model ? `${x.manufacturer} ${x.model}` : x.manufacturer]);
  else if (x.model) items.push(["Modell", x.model]);
  if (x.serial_number) items.push(["Serienr.", x.serial_number]);
  if (x.tfm) items.push(["TFM", x.tfm]);
  if (x.installed_at) items.push(["Installert", formatDate(x.installed_at)]);
  if (x.warranty_until) items.push(["Garanti til", formatDate(x.warranty_until)]);
  if (x.last_service_at) items.push(["Siste service", formatDate(x.last_service_at)]);
  if (x.service_interval_months) items.push(["Intervall", `Hver ${x.service_interval_months}. måned`]);
  const named = new Set([x.supplier, x.manufacturer].filter(Boolean));
  const others = x.parties.filter((p) => !named.has(p.name));
  if (others.length) items.push(["Andre", others.map((p) => `${p.name} (${p.role})`).join(", ")]);
  if (items.length === 0) return null;
  return (
    <Card>
      <div className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Lest ut av dokumentet</div>
      <KeyValues items={items} />
      {doc.component_id && (
        <Link to={`/o/${orgId}/components/${doc.component_id}`} className="mt-3 inline-block text-[13px] font-medium text-accent hover:underline">
          Åpne komponenten
        </Link>
      )}
    </Card>
  );
}

function DocumentEditModal({ open, onClose, doc }: { open: boolean; onClose: () => void; doc: Document }) {
  const call = useOrgApi();
  const [title, setTitle] = useState(doc.title);
  const [kind, setKind] = useState<string>(doc.kind);
  const [ns, setNs] = useState(doc.ns3451 ?? "");
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [componentId, setComponentId] = useState(doc.component_id ?? "");
  const [loc, setLoc] = useState<LocationValue>({ property_id: doc.property_id ?? "", building_id: doc.building_id ?? "", floor_id: doc.floor_id ?? "", room_id: doc.room_id ?? "" });
  const [busy, setBusy] = useState(false);
  const comps = useOrgQuery<Component[]>(loc.building_id ? `/components?building_id=${loc.building_id}` : null);
  useEffect(() => {
    if (open) {
      setTitle(doc.title);
      setKind(doc.kind);
      setNs(doc.ns3451 ?? "");
      setSummary(doc.summary ?? "");
      setComponentId(doc.component_id ?? "");
      setLoc({ property_id: doc.property_id ?? "", building_id: doc.building_id ?? "", floor_id: doc.floor_id ?? "", room_id: doc.room_id ?? "" });
    }
  }, [open, doc]);
  const save = async () => {
    setBusy(true);
    try {
      await call(`/documents/${doc.id}`, {
        method: "PATCH",
        body: {
          title,
          kind,
          ns3451: ns,
          summary,
          property_id: loc.property_id || null,
          building_id: loc.building_id || null,
          floor_id: loc.floor_id || null,
          room_id: loc.room_id || null,
          component_id: componentId || null,
        },
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Rediger dokument"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Lagre
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Tittel">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(DOCUMENT_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="NS 3451">
            <Input value={ns} onChange={(e) => setNs(e.target.value)} />
          </Field>
        </div>
        <Field label="Sammendrag">
          <Textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <LocationPicker value={loc} onChange={setLoc} />
        <Field label="Komponent">
          <Select value={componentId} disabled={!loc.building_id} onChange={(e) => setComponentId(e.target.value)}>
            <option value="">–</option>
            {comps.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
