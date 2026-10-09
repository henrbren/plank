import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Code, Ellipsis, History, LayoutDashboard, Maximize2, Minimize2, Pin, PinOff, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import type { Agent, Artifact, ArtifactVersion } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, Field, IconButton, Input, Loading, Menu, MenuItem, Modal, PageHeader, Textarea, cn, useConfirm, useToast } from "@/components/ui";
import { ArtifactFrame } from "@/features/artifacts/ArtifactFrame";

export function ArtifactsPage() {
  const { orgId } = useOrg();
  useSetFocus("org");
  const list = useOrgQuery<Artifact[]>("/artifacts");
  const agents = useOrgQuery<Agent[]>("/agents");
  const panel = useAgentPanel();
  const [create, setCreate] = useState(false);
  const builder = agents.data?.find((a) => a.template === "sidebygger")?.id;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<LayoutDashboard className="size-5" />}
        title="Sider"
        subtitle="Dashboards, rapporter, sjekklister og verktøy som du og agentene bygger – med levende data fra Plank."
        actions={
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
              Tom side
            </Button>
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => panel.ask("Jeg vil lage en ny side. Foreslå tre nyttige dashboards basert på dataene våre, og spør hvilken jeg vil ha.", { agentId: builder, newConversation: true })}>
              Lag med agent
            </Button>
          </>
        }
      />
      {list.isLoading ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
          {list.data.map((a) => (
            <Link key={a.id} to={`/o/${orgId}/artifacts/${a.id}`} className="group flex flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-line-strong">
              <div className="relative flex h-32 items-center justify-center overflow-hidden border-b border-line bg-[linear-gradient(135deg,var(--panel-2),var(--accent-soft))]">
                <LayoutDashboard className="size-8 text-accent/70 transition-transform group-hover:scale-110" />
                {a.pinned ? <Pin className="absolute top-3 right-3 size-4 text-accent" /> : null}
              </div>
              <div className="flex flex-1 flex-col p-4">
                <div className="font-semibold">{a.title}</div>
                <div className="mt-0.5 line-clamp-2 flex-1 text-[12.5px] text-muted">{a.description ?? "–"}</div>
                <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
                  <Badge>v{a.current_version}</Badge>
                  {a.building_name && <span className="truncate">{a.building_name}</span>}
                  <span className="ml-auto shrink-0">{timeAgo(a.updated_at)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<LayoutDashboard className="size-5" />}
          title="Ingen sider ennå"
          description="Be en agent bygge et dashboard, f.eks. «Lag en oversikt over service som forfaller per bygg»."
          action={
            <Button variant="primary" onClick={() => panel.ask("Lag et dashboard som viser åpne oppgaver og service som forfaller, gruppert per bygg.", { agentId: builder, newConversation: true })}>
              Lag mitt første dashboard
            </Button>
          }
        />
      )}
      <NewArtifactModal open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function NewArtifactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const call = useOrgApi();
  const navigate = useNavigate();
  const { orgId } = useOrg();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle("");
  }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const a = await call<Artifact>("/artifacts", { body: { title: title || "Ny side" } });
      onClose();
      navigate(`/o/${orgId}/artifacts/${a.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Ny side"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Opprett
          </Button>
        </>
      }
    >
      <Field label="Tittel" hint="Du beskriver innholdet for agenten etterpå.">
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      </Field>
    </Modal>
  );
}

export function ArtifactPage() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const meta = useOrgQuery<Artifact & { versions: ArtifactVersion[] }>(`/artifacts/${id}`);
  const [version, setVersion] = useState<number | null>(null);
  const shownVersion = version ?? meta.data?.current_version ?? null;
  const html = useOrgQuery<{ html: string; version: number }>(meta.data && shownVersion ? `/artifacts/${id}/html?version=${shownVersion}` : null);
  useSetFocus("artifact", id, meta.data?.title);
  const [full, setFull] = useState(false);
  const [code, setCode] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const onRuntimeError = useCallback((m: string) => setRuntimeError(m), []);

  // Ny versjon fra agenten → vis den
  useEffect(() => {
    setVersion(null);
    setRuntimeError(null);
  }, [meta.data?.current_version]);

  if (meta.isLoading) return <Loading />;
  if (meta.error) return <ErrorState error={meta.error} />;
  const a = meta.data!;
  const isOld = shownVersion !== a.current_version;

  const remove = async () => {
    if (!(await confirm({ title: "Slette siden?", message: `«${a.title}» og alle versjoner slettes.`, confirm: "Slett", danger: true }))) return;
    await call(`/artifacts/${a.id}`, { method: "DELETE" });
    navigate(`/o/${orgId}/artifacts`);
  };

  return (
    <div className={cn("flex h-full flex-col", full && "fixed inset-0 z-50 bg-bg")}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] text-muted">
            <Link to={`/o/${orgId}/artifacts`} className="hover:text-ink">
              Sider
            </Link>
            {a.building_name && (
              <>
                <span>/</span>
                <Link to={`/o/${orgId}/buildings/${a.building_id}`} className="hover:text-ink">
                  {a.building_name}
                </Link>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-semibold">{a.title}</h1>
            <Menu
              align="start"
              trigger={() => (
                <button className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-muted hover:text-ink">
                  <History className="size-3" />v{shownVersion}
                </button>
              )}
            >
              {(close) => (
                <div className="max-h-72 overflow-y-auto">
                  {a.versions.map((v) => (
                    <MenuItem
                      key={v.version}
                      active={v.version === shownVersion}
                      onClick={() => {
                        close();
                        setVersion(v.version);
                      }}
                    >
                      <span className="flex flex-col">
                        <span>
                          Versjon {v.version}
                          {v.version === a.current_version && " (gjeldende)"}
                        </span>
                        <span className="text-[11.5px] text-muted">
                          {v.note ?? ""} · {formatDateTime(v.created_at)}
                        </span>
                      </span>
                    </MenuItem>
                  ))}
                </div>
              )}
            </Menu>
          </div>
        </div>
        {isOld && (
          <Button
            size="sm"
            onClick={async () => {
              await call(`/artifacts/${a.id}/restore`, { body: { version: shownVersion } });
              toast(`Versjon ${shownVersion} er gjenopprettet`, "ok");
            }}
          >
            Gjenopprett denne versjonen
          </Button>
        )}
        <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" />} onClick={() => panel.setOpen(true)}>
          Endre med agent
        </Button>
        <IconButton label={full ? "Avslutt fullskjerm" : "Fullskjerm"} onClick={() => setFull((f) => !f)}>
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </IconButton>
        <Menu trigger={() => <IconButton label="Mer"><Ellipsis className="size-4" /></IconButton>}>
          {(close) => (
            <>
              <MenuItem icon={<Code className="size-4" />} onClick={() => (close(), setCode(true))}>
                Rediger HTML
              </MenuItem>
              <MenuItem icon={a.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />} onClick={async () => (close(), await call(`/artifacts/${a.id}`, { method: "PATCH", body: { pinned: !a.pinned } }))}>
                {a.pinned ? "Løsne fra oversikten" : "Fest på oversikten"}
              </MenuItem>
              <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), remove())}>
                Slett side
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {runtimeError && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn-soft px-4 py-2 text-[12.5px] text-warn">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Feil i siden: {runtimeError}</span>
          <Button size="sm" variant="ghost" onClick={() => (panel.ask(`Siden «${a.title}» viser denne feilen: ${runtimeError}. Kan du rette den?`), setRuntimeError(null))}>
            Be agenten rette
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {html.data ? <ArtifactFrame key={`${a.id}-${html.data.version}`} html={html.data.html} artifactId={a.id} buildingId={a.building_id} propertyId={a.property_id} onRuntimeError={onRuntimeError} /> : <Loading />}
      </div>
      <CodeModal open={code} onClose={() => setCode(false)} artifactId={a.id} html={html.data?.html ?? ""} />
      {dialog}
    </div>
  );
}

function CodeModal({ open, onClose, artifactId, html }: { open: boolean; onClose: () => void; artifactId: string; html: string }) {
  const call = useOrgApi();
  const [value, setValue] = useState(html);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(html);
  }, [open, html]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Rediger HTML"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await call(`/artifacts/${artifactId}/versions`, { body: { html: value, note: "Manuell redigering" } });
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            Lagre som ny versjon
          </Button>
        </>
      }
    >
      <Textarea value={value} onChange={(e) => setValue(e.target.value)} className="h-[60vh] font-mono text-[12.5px] leading-relaxed" spellCheck={false} />
    </Modal>
  );
}
