import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Download, Ellipsis, FileText, Pencil, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { DOCUMENT_KINDS, type Component, type Document, type SearchHit, type TreeProperty } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DocKindBadge, DocStatus } from "@/components/domain";
import { Button, Card, EmptyState, ErrorState, Field, IconButton, Input, KeyValues, Loading, Menu, MenuItem, Modal, PageHeader, Select, Tabs, Textarea, useConfirm, useToast } from "@/components/ui";
import { DocumentTable } from "@/components/lists";
import { LocationPicker, UploadModal, type LocationValue } from "@/components/forms";
import { Markdown } from "@/features/chat/transcript";

export function DocumentsPage() {
  const { orgId, canEdit } = useOrg();
  useSetFocus("org");
  const [params, setParams] = useSearchParams();
  const propertyId = params.get("eiendom") ?? "";
  const [kind, setKind] = useState("");
  const [building, setBuilding] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [upload, setUpload] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const query = new URLSearchParams();
  if (kind) query.set("kind", kind);
  if (building) query.set("building_id", building);
  if (propertyId) query.set("property_id", propertyId);
  const docs = useOrgQuery<Document[]>(`/documents?${query}`, {
    refetchInterval: (state) => ((state.state.data as Document[] | undefined)?.some((d) => d.status === "processing") ? 3000 : false),
  });
  const hits = useOrgQuery<SearchHit[]>(debounced.length >= 2 ? `/documents/search?q=${encodeURIComponent(debounced)}${building ? `&building_id=${building}` : ""}${propertyId ? `&property_id=${propertyId}` : ""}` : null);
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
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
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Søk i innholdet i dokumentene …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="w-auto min-w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Alle typer</option>
          {Object.entries(DOCUMENT_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
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
      </div>
      {propertyId && (
        <p className="mb-4 rounded-xl bg-panel-2 px-4 py-3 text-[13.5px] text-ink-2">
          Viser dokumenter på eiendommen {tree.data?.find((p) => p.id === propertyId)?.name ?? ""}.{" "}
          <button type="button" className="font-medium text-ink underline" onClick={() => setParams({}, { replace: true })}>
            Vis alle
          </button>
        </p>
      )}

      {debounced.length >= 2 ? (
        hits.isLoading ? (
          <Loading label="Søker …" />
        ) : hits.data?.length ? (
          <div className="flex flex-col gap-2">
            {hits.data.map((h) => (
              <Link key={h.document_id} to={`/o/${orgId}/documents/${h.document_id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-line-strong">
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
            ))}
          </div>
        ) : (
          <EmptyState icon={<Search className="size-5" />} title="Ingen treff" description="Prøv færre eller andre ord." />
        )
      ) : docs.isLoading ? (
        <Loading />
      ) : docs.data?.length ? (
        <DocumentTable documents={docs.data} />
      ) : (
        <EmptyState icon={<FileText className="size-5" />} title="Ingen dokumenter" description="Last opp dokumentasjon for byggene dine." action={canEdit ? <Button onClick={() => setUpload(true)}>Last opp</Button> : undefined} />
      )}
      <UploadModal open={upload} onClose={() => setUpload(false)} defaults={building ? { building_id: building } : undefined} />
    </div>
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
  const isPdf = d.mime === "application/pdf";
  const isImage = d.mime.startsWith("image/") && d.mime !== "image/svg+xml";
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
          <Card>
            <KeyValues
              items={[
                ["Type", DOCUMENT_KINDS[d.kind]],
                ["NS 3451", d.ns3451],
                ["Bygg", d.building_id ? <Link className="hover:underline" to={`/o/${orgId}/buildings/${d.building_id}`}>{d.building_name}</Link> : d.property_name],
                ["Komponent", d.component_id ? <Link className="hover:underline" to={`/o/${orgId}/components/${d.component_id}`}>Åpne komponent</Link> : null],
                ["Tegn", d.text_chars ? new Intl.NumberFormat("nb-NO").format(d.text_chars) : null],
                ["Lastet opp", formatDateTime(d.created_at)],
              ]}
            />
          </Card>
        </div>
      </div>
      <DocumentEditModal open={edit} onClose={() => setEdit(false)} doc={d} />
      {dialog}
    </div>
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
