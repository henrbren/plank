import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Activity, Bot, Building2, FileText, LayoutDashboard, Plus, Sparkles, SquareCheck, Upload, Wrench } from "lucide-react";
import type { Agent, Artifact, OrgOverview } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { timeAgo } from "@/lib/format";
import { AgentAvatar, DueDate, ServiceBadge, TaskTypeBadge } from "@/components/domain";
import { Button, Card, CardHeader, ErrorState, Loading, PageHeader, Stat, useToast } from "@/components/ui";
import { UploadModal } from "@/components/forms";
import { Journey } from "@/features/onboarding/NextStep";

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

  const empty = o.counts.properties === 0;
  const pinned = (artifacts.data ?? []).filter((a) => a.pinned).slice(0, 4);
  const overdue = o.service_due.filter((c) => c.next_service_at && c.next_service_at < o.today).length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ""}`}
        subtitle={`${org.name} · ${new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}`}
        actions={
          !empty && (
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

      {empty ? null : (
        <div className="mb-6 grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <Stat label="Bygg" value={o.counts.buildings} hint={`${o.counts.properties} eiendommer`} />
          <Stat label="Åpne oppgaver" value={o.counts.open_tasks} to={`${base}/tasks`} />
          <Stat label="Service på overtid" value={overdue} tone={overdue > 0 ? "bad" : undefined} hint={`${o.service_due.length} innen 60 dager`} to={`${base}/components`} />
          <Stat label="Dokumenter" value={o.counts.documents} hint={`${o.counts.components} komponenter`} to={`${base}/documents`} />
        </div>
      )}

      {!empty && <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <Card>
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
          </Card>

          <Card>
            <CardHeader
              title="Service som forfaller"
              icon={<Wrench className="size-4" />}
              action={
                <Link to={`${base}/components`} className="text-[12.5px] text-muted hover:text-ink">
                  FDV-register
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
          </Card>

          {o.recent_documents.length > 0 && (
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
        </div>

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

          <Card>
            <CardHeader title="Aktivitet" icon={<Activity className="size-4" />} />
            {o.activity.length === 0 ? (
              <div className="py-2 text-[13px] text-muted">Ingen aktivitet ennå.</div>
            ) : (
              <ul className="flex flex-col gap-3">
                {o.activity.map((a) => (
                  <li key={a.id} className="flex gap-2.5 text-[13px]">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-panel-2 text-muted">
                      {a.actor_type === "agent" ? <Bot className="size-3" /> : <Building2 className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{a.actor_name ?? "System"}</span> <span className="text-ink-2">{a.summary ?? a.action}</span>
                      <span className="block text-[11.5px] text-muted">{timeAgo(a.created_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>}
      <UploadModal open={upload} onClose={() => setUpload(false)} />
    </div>
  );
}
