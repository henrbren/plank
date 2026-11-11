import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Activity, Bot, FileText, LayoutDashboard, Map, Plus, Sparkles, SquareCheck, Upload, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ActivityItem, Agent, Artifact, OrgOverview, SinceLast } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { entityPath, timeAgo } from "@/lib/format";
import { AgentAvatar, DueDate, ENTITY_ICONS, ServiceBadge, TaskTypeBadge } from "@/components/domain";
import { Button, Card, CardHeader, cn, ErrorState, Loading, PageHeader, Stat, useToast } from "@/components/ui";
import { UploadModal } from "@/components/forms";
import { Journey, useNextAction } from "@/features/onboarding/NextStep";

const AI_PAGES: { title: string; text: string; prompt?: string; suppliers?: boolean }[] = [
  {
    title: "Leverandører",
    text: "Firma i dokumentene, med tabell og 3D",
    suppliers: true,
  },
  {
    title: "Service og oppgaver",
    text: "Forfall og åpne oppgaver per bygg",
    prompt:
      "Lag en side (artifact) som viser service som forfaller og åpne oppgaver, gruppert per bygg. Hent components.list og tasks.list. Ikke finn på frister. Følg stilen under «Sider». Legg siden i sidemenyen.",
  },
  {
    title: "Tilstand",
    text: "Komponenter fordelt på tilstandsgrad",
    prompt:
      "Lag en side (artifact) som viser komponentenes tilstandsgrad (condition: TG0, TG1, TG2, TG3, TGIU). Hent components.list og grupper per bygg. Ikke finn på grader. Følg stilen under «Sider». Legg siden i sidemenyen.",
  },
];

export function HomePage() {
  const { orgId, org, me, isAdmin, canEdit, limited } = useOrg();
  useSetFocus("org", undefined, org.name);
  const overview = useOrgQuery<OrgOverview & { today: string }>("/overview");
  const agents = useOrgQuery<Agent[]>("/agents");
  const artifacts = useOrgQuery<Artifact[]>("/artifacts");
  const panel = useAgentPanel();
  const call = useOrgApi();
  const toast = useToast();
  const navigate = useNavigate();
  const [seeding, setSeeding] = useState(false);
  const [upload, setUpload] = useState(false);
  const [makingSuppliers, setMakingSuppliers] = useState(false);
  const { step } = useNextAction();

  if (overview.isLoading) return <Loading />;
  if (overview.error) return <ErrorState error={overview.error} />;
  const o = overview.data!;
  const base = `/o/${orgId}`;
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 10 ? "God morgen" : h < 17 ? "Hei" : "God kveld";
  })();
  const firstName = me.user.name?.split(" ")[0];

  const seed = async () => {
    setSeeding(true);
    try {
      await call("/demo", { method: "POST" });
      toast("Demodata er lastet inn", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Feil", "bad");
    } finally {
      setSeeding(false);
    }
  };

  const makeSuppliers = async () => {
    if (makingSuppliers) return;
    setMakingSuppliers(true);
    try {
      const a = await call<Artifact>("/artifacts/suppliers", { method: "POST" });
      navigate(`/o/${orgId}/artifacts/${a.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke lage siden", "bad");
    } finally {
      setMakingSuppliers(false);
    }
  };

  const empty = o.counts.properties === 0;
  const showTasks = o.counts.tasks > 0;
  const showComponents = o.counts.components > 0;
  const statCount = 2 + (showTasks ? 1 : 0) + (showComponents ? 1 : 0);
  const showRecent = o.recent_documents.length > 0;
  const showLeft = showTasks || showComponents || showRecent;
  const pinned = (artifacts.data ?? []).filter((a) => a.pinned).slice(0, 4);
  const builder = agents.data?.find((a) => a.template === "sidebygger")?.id ?? agents.data?.find((a) => a.template === "fdv-assistent")?.id;
  const overdue = o.service_due.filter((c) => c.next_service_at && c.next_service_at < o.today).length;
  const starting = Boolean(step && step.funnel != null && step.kind !== "pay");

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ""}`}
        subtitle={`${org.name} · ${new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}`}
        actions={
          !empty &&
          !starting && (
            <>
              {canEdit && (
                <Button icon={<Upload className="size-4" />} onClick={() => setUpload(true)}>
                  Last opp
                </Button>
              )}
              <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => panel.ask("Hva bør jeg prioritere denne uken? Se på oppgaver, service som forfaller og avvik.")}>
                Hva bør jeg prioritere?
              </Button>
            </>
          )
        }
      />

      <Journey onDemo={isAdmin ? seed : undefined} seeding={seeding} />

      {starting && !empty && (
        <p className="text-[14px] text-muted">
          {o.counts.buildings === 1 ? "1 bygg" : `${o.counts.buildings} bygg`} og {o.counts.documents === 1 ? "1 dokument" : `${o.counts.documents} dokumenter`} er inne.
        </p>
      )}

      {!starting && !empty && <SinceCard since={o.since} orgId={orgId} />}

      {empty || starting ? null : (
        <div className={cn("mb-6 grid grid-cols-2 gap-3", statCount === 3 && "@2xl:grid-cols-3", statCount >= 4 && "@2xl:grid-cols-4")}>
          <Stat label="Bygg" value={o.counts.buildings} hint={`${o.counts.properties} eiendommer`} />
          {showTasks && <Stat label="Åpne oppgaver" value={o.counts.open_tasks} to={`${base}/tasks`} />}
          {showComponents && <Stat label="Service på overtid" value={overdue} tone={overdue > 0 ? "bad" : undefined} hint={`${o.service_due.length} innen 60 dager`} to={`${base}/components`} />}
          <Stat label="Dokumenter" value={o.counts.documents} hint={showComponents ? `${o.counts.components} komponenter` : undefined} to={`${base}/documents`} />
        </div>
      )}

      {!empty && !starting && (
        <Card className="mb-6">
          <CardHeader
            title="Lag med AI"
            icon={<Sparkles className="size-4" />}
            action={
              <Link to={`${base}/kart`} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink">
                <Map className="size-3.5" />
                Kart over eiendommene
              </Link>
            }
          />
          <div className="grid gap-2 @xl:grid-cols-3">
            {AI_PAGES.map((page) => (
              <button
                key={page.title}
                type="button"
                disabled={page.suppliers && makingSuppliers}
                onClick={() => (page.suppliers ? void makeSuppliers() : page.prompt && panel.ask(page.prompt, { agentId: builder, newConversation: true }))}
                className="rounded-lg border border-line bg-bg px-3 py-2.5 text-left hover:bg-panel-2 disabled:opacity-60"
              >
                <span className="block text-[13.5px] font-medium">{page.title}</span>
                <span className="mt-0.5 block text-[12px] text-muted">{page.suppliers && makingSuppliers ? "Lager siden …" : page.text}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {!empty && !starting && <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-5", showLeft && "@4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]")}>
        {showLeft && <div className="flex flex-col gap-5">
          {showTasks && <Card>
            <CardHeader
              title="Neste oppgaver"
              icon={<SquareCheck className="size-4" />}
              action={
                <Link to={`${base}/tasks`} className="text-[12.5px] text-muted hover:text-ink">
                  Alle oppgaver
                </Link>
              }
            />
            {o.upcoming_tasks.length === 0 ? (
              <div className="py-4 text-[13px] text-muted">Ingen åpne oppgaver.</div>
            ) : (
              <ul className="-mx-2">
                {o.upcoming_tasks.map((t) => (
                  <li key={t.id}>
                    <Link to={`${base}/tasks/${t.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{t.title}</div>
                        <div className="truncate text-[12px] text-muted">{[t.building_name, t.component_name].filter(Boolean).join(" · ") || "–"}</div>
                      </div>
                      <span className="hidden @lg:block">
                        <TaskTypeBadge type={t.type} />
                      </span>
                      <span className="shrink-0 text-right text-[12.5px] @lg:w-44">
                        <DueDate date={t.due_date} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>}

          {showComponents && <Card>
            <CardHeader
              title="Service som forfaller"
              icon={<Wrench className="size-4" />}
              action={
                <Link to={`${base}/components`} className="text-[12.5px] text-muted hover:text-ink">
                  Komponenter
                </Link>
              }
            />
            {o.service_due.length === 0 ? (
              <div className="py-4 text-[13px] text-muted">Ingen service forfaller de neste 60 dagene.</div>
            ) : (
              <ul className="-mx-2">
                {o.service_due.map((c) => (
                  <li key={c.id}>
                    <Link to={`${base}/components/${c.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{c.name}</div>
                        <div className="truncate text-[12px] text-muted">
                          {c.building_name} {c.service_interval_months ? `· hver ${c.service_interval_months}. mnd` : ""}
                        </div>
                      </div>
                      <ServiceBadge next={c.next_service_at} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>}

          {showRecent && (
            <Card>
              <CardHeader
                title="Nylige dokumenter"
                icon={<FileText className="size-4" />}
                action={
                  <Link to={`${base}/documents`} className="text-[12.5px] text-muted hover:text-ink">
                    Alle dokumenter
                  </Link>
                }
              />
              <ul className="-mx-2">
                {o.recent_documents.map((d) => (
                  <li key={d.id}>
                    <Link to={d.kind === "ifc" ? `${base}/models/${d.id}` : `${base}/documents/${d.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                      <FileText className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">{d.title}</span>
                      <span className="shrink-0 text-[12px] text-muted">{timeAgo(d.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>}

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Agenter"
              icon={<Bot className="size-4" />}
              action={
                <Link to={`${base}/agents`} className="text-[12.5px] text-muted hover:text-ink">
                  Administrer
                </Link>
              }
            />
            <div className="-mx-2 flex flex-col">
              {agents.data?.map((a) => (
                <button key={a.id} onClick={() => panel.ask("Hei! Hva kan du hjelpe meg med her?", { agentId: a.id, newConversation: true })} className="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2">
                  <AgentAvatar icon={a.icon} color={a.color} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{a.name}</span>
                    <span className="block truncate text-[12px] text-muted">{a.description}</span>
                  </span>
                </button>
              ))}
            </div>
            {canEdit && !limited && (
              <Button size="sm" variant="ghost" className="mt-2 -ml-1" icon={<Plus className="size-3.5" />} onClick={() => navigate(`${base}/agents/new`)}>
                Ny agent
              </Button>
            )}
          </Card>

          {pinned.length > 0 && (
            <Card>
              <CardHeader title="Festede sider" icon={<LayoutDashboard className="size-4" />} />
              <div className="-mx-2 flex flex-col">
                {pinned.map((a) => (
                  <Link key={a.id} to={`${base}/artifacts/${a.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <LayoutDashboard className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{a.title}</span>
                      <span className="block truncate text-[12px] text-muted">{a.building_name ?? a.description}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

        </div>
      </div>}
      <UploadModal open={upload} onClose={() => setUpload(false)} />
    </div>
  );
}

const LINKABLE = new Set(["property", "building", "floor", "room", "document", "component", "task", "artifact", "conversation"]);

function sinceWhen(at: number): string {
  const d = new Date(at);
  const time = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" }).format(d);
  const now = new Date();
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days <= 0) return `i dag kl. ${time}`;
  if (days === 1) return `i går kl. ${time}`;
  if (days < 7) return `${new Intl.DateTimeFormat("nb-NO", { weekday: "long" }).format(d)} kl. ${time}`;
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
}

function dayHeading(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days <= 0) return "I dag";
  if (days === 1) return "I går";
  if (days < 7) return new Intl.DateTimeFormat("nb-NO", { weekday: "long" }).format(d);
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long" }).format(d);
}

function tally(s: SinceLast): string | null {
  const bits: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) bits.push(`${n} ${n === 1 ? one : many}`);
  };
  add(s.documents, "dokument", "dokumenter");
  add(s.tasks, "oppgave", "oppgaver");
  add(s.components, "komponent", "komponenter");
  add(s.pages, "side", "sider");
  add(s.imports, "henting", "hentinger");
  add(s.runs, "agentkjøring", "agentkjøringer");
  if (bits.length === 0) return null;
  if (bits.length === 1) return bits[0]!;
  return `${bits.slice(0, -1).join(", ")} og ${bits[bits.length - 1]}`;
}

function activityIcon(item: ActivityItem): LucideIcon {
  if (item.entity_type && ENTITY_ICONS[item.entity_type]) return ENTITY_ICONS[item.entity_type];
  if (item.action.startsWith("agent.")) return Bot;
  if (item.action.includes("document") || item.action.startsWith("laft.") || item.action.startsWith("boligmappa.")) return FileText;
  return Activity;
}

function activityHref(orgId: string, item: ActivityItem): string | null {
  if (item.action === "boligmappa.documents_arrived") return `/o/${orgId}/documents`;
  if (!item.entity_type || !item.entity_id) return null;
  if (item.action.endsWith(".deleted") || item.action.endsWith("_removed")) return null;
  if (item.entity_type === "agent") return `/o/${orgId}/agents/${item.entity_id}`;
  if (!LINKABLE.has(item.entity_type)) return null;
  return entityPath(orgId, item.entity_type, item.entity_id);
}

function SinceCard({ since, orgId }: { since: SinceLast; orgId: string }) {
  const [expanded, setExpanded] = useState(false);
  if (since.mode === "visit" && since.total === 0 && since.at != null) {
    return <p className="mb-6 rounded-xl border border-line bg-panel px-4 py-3 text-[13.5px] text-ink-2">Ingenting nytt siden {sinceWhen(since.at)}.</p>;
  }
  if (since.items.length === 0) return null;

  const title = since.mode === "visit" ? "Siden sist" : since.mode === "week" ? "Den siste uken" : "Siste som har skjedd";
  const line = tally(since);
  const lead =
    line && since.mode === "visit" && since.at != null
      ? `${line} siden ${sinceWhen(since.at)}.`
      : line
        ? `${line}.`
        : since.mode === "visit" && since.at != null
          ? `Siden ${sinceWhen(since.at)}.`
          : since.mode === "week"
            ? "Det som har beveget seg de siste sju dagene."
            : null;
  const days = new Set(since.items.map((item) => new Date(item.created_at).toDateString()));
  const showDays = days.size > 1;
  const visible = expanded ? since.items : since.items.slice(0, 6);
  let lastDay = "";

  return (
    <Card className="mb-6">
      <CardHeader title={title} icon={<Activity className="size-4" />} />
      {lead && <p className="mb-2 text-[13.5px] text-ink-2">{lead}</p>}
      <ul className="-mx-2">
        {visible.map((item) => {
          const day = new Date(item.created_at).toDateString();
          const heading = showDays && day !== lastDay ? dayHeading(item.created_at) : null;
          lastDay = day;
          const href = activityHref(orgId, item);
          const Icon = activityIcon(item);
          const actor = item.actor_name ?? (item.actor_type === "agent" ? "Agent" : item.actor_type === "system" ? "Plank" : "Noen");
          const body = (
            <>
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px]">{item.summary ?? item.action}</span>
                <span className="block truncate text-[12px] text-muted">
                  {actor} · {timeAgo(item.created_at)}
                </span>
              </span>
            </>
          );
          return (
            <li key={item.id}>
              {heading && <div className="px-2 pt-2 pb-0.5 text-[12px] font-medium text-muted">{heading}</div>}
              {href ? (
                <Link to={href} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                  {body}
                </Link>
              ) : (
                <div className="flex items-start gap-3 px-2 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {(since.items.length > 6 || since.total > since.items.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {since.items.length > 6 && (
            <button type="button" onClick={() => setExpanded((open) => !open)} className="text-[12.5px] text-muted hover:text-ink">
              {expanded ? "Vis færre" : `Vis alle ${since.items.length}`}
            </button>
          )}
          {since.total > since.items.length && <span className="text-[12px] text-muted">{since.total - since.items.length} til er ikke listet her.</span>}
        </div>
      )}
    </Card>
  );
}
