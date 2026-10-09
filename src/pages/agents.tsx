import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Bot, CalendarClock, MessageSquare, Play, Plus, Trash2 } from "lucide-react";
import { MODELS, TOOL_GROUPS, type Agent, type AgentRun, type AgentTemplate, type Effort, type ToolGroup, type TreeProperty } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDateTime, timeAgo } from "@/lib/format";
import { AGENT_COLORS, AGENT_ICONS, AgentAvatar } from "@/components/domain";
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Textarea, cn, useConfirm, useToast } from "@/components/ui";

type AgentWithLabel = Agent & { schedule_label: string };

export function AgentsPage() {
  const { orgId } = useOrg();
  useSetFocus("org");
  const agents = useOrgQuery<AgentWithLabel[]>("/agents");
  const panel = useAgentPanel();
  const [picker, setPicker] = useState(false);

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<Bot className="size-5" />}
        title="Agenter"
        subtitle="Sett opp agenter med egne instrukser, verktøy og tidsplaner. De jobber med dokumentene, registrene og BIM-modellene dine."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPicker(true)}>
            Ny agent
          </Button>
        }
      />
      {agents.isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
          {agents.data?.map((a) => (
            <Card key={a.id} className="flex flex-col">
              <div className="flex items-start gap-3">
                <AgentAvatar icon={a.icon} color={a.color} size="lg" />
                <div className="min-w-0 flex-1">
                  <Link to={`/o/${orgId}/agents/${a.id}`} className="block truncate text-[15px] font-semibold hover:underline">
                    {a.name}
                  </Link>
                  <div className="text-[12px] text-muted">{MODELS.find((m) => m.id === a.model)?.label ?? a.model}</div>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 flex-1 text-[13px] text-ink-2">{a.description ?? "Ingen beskrivelse."}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{a.tools.length} verktøy</Badge>
                {a.schedule ? (
                  <Badge tone="accent">
                    <CalendarClock className="size-3" />
                    {a.schedule_label}
                  </Badge>
                ) : null}
                {a.scope_type !== "org" && <Badge tone="info">Avgrenset</Badge>}
              </div>
              <div className="mt-4 flex gap-2 border-t border-line pt-3">
                <Button size="sm" variant="primary" icon={<MessageSquare className="size-3.5" />} onClick={() => panel.ask("Hei! Hva kan du hjelpe meg med?", { agentId: a.id, newConversation: true })}>
                  Chat
                </Button>
                <Link to={`/o/${orgId}/agents/${a.id}`} className="inline-flex h-7 items-center rounded-md px-2.5 text-[13px] font-medium text-ink-2 hover:bg-panel-2">
                  Innstillinger
                </Link>
              </div>
            </Card>
          ))}
          <button onClick={() => setPicker(true)} className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:text-accent">
            <Plus className="mb-2 size-5" />
            <span className="text-[13.5px] font-medium">Ny agent</span>
          </button>
        </div>
      )}
      <TemplatePicker open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}

function TemplatePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const templates = useOrgQuery<AgentTemplate[]>(open ? "/agents/templates" : null);
  const go = (key?: string) => {
    onClose();
    navigate(`/o/${orgId}/agents/new${key ? `?template=${key}` : ""}`);
  };
  return (
    <Modal open={open} onClose={onClose} title="Ny agent" size="lg">
      <p className="mb-4 text-[13.5px] text-ink-2">Start fra en mal og tilpass den, eller bygg en agent fra bunnen av.</p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {templates.data?.map((t) => (
          <button key={t.key} onClick={() => go(t.key)} className="flex items-start gap-3 rounded-xl border border-line p-3 text-left transition-colors hover:border-line-strong hover:bg-panel-2">
            <AgentAvatar icon={t.icon} color={t.color} />
            <span className="min-w-0">
              <span className="block font-medium">{t.name}</span>
              <span className="block text-[12.5px] text-muted">{t.description}</span>
            </span>
          </button>
        ))}
        <button onClick={() => go()} className="flex items-start gap-3 rounded-xl border border-dashed border-line-strong p-3 text-left hover:bg-panel-2">
          <AgentAvatar icon="bot" color="ink" />
          <span>
            <span className="block font-medium">Tom agent</span>
            <span className="block text-[12.5px] text-muted">Skriv instruksene selv</span>
          </span>
        </button>
      </div>
    </Modal>
  );
}

// ─── Redigering ──────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  icon: string;
  color: string;
  description: string;
  instructions: string;
  model: string;
  effort: Effort;
  tools: ToolGroup[];
  scope_type: "org" | "property" | "building";
  scope_id: string;
  scheduleOn: boolean;
  freq: "daily" | "weekdays" | "weekly" | "monthly";
  day: string;
  time: string;
  schedule_prompt: string;
  notify_emails: string;
  template: string | null;
}

function parseSchedule(s: string | null): Pick<FormState, "scheduleOn" | "freq" | "day" | "time"> {
  const m = s ? /^(daily|weekdays|weekly|monthly)(?::(\d{1,2}))?@(\d{1,2}):(\d{2})$/.exec(s) : null;
  if (!m) return { scheduleOn: false, freq: "weekly", day: "1", time: "07:00" };
  return { scheduleOn: true, freq: m[1] as FormState["freq"], day: m[2] ?? "1", time: `${m[3]!.padStart(2, "0")}:${m[4]}` };
}

function buildSchedule(f: FormState): string | null {
  if (!f.scheduleOn) return null;
  const [h, m] = f.time.split(":");
  const t = `${Number(h)}:${m ?? "00"}`;
  if (f.freq === "weekly" || f.freq === "monthly") return `${f.freq}:${f.day}@${t}`;
  return `${f.freq}@${t}`;
}

const DAYS = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];

export function AgentEditPage() {
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const call = useOrgApi();
  const toast = useToast();
  const panel = useAgentPanel();
  const { confirm, dialog } = useConfirm();
  const agent = useOrgQuery<AgentWithLabel & { runs: AgentRun[] }>(id ? `/agents/${id}` : null);
  const templates = useOrgQuery<AgentTemplate[]>(isNew ? "/agents/templates" : null);
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useSetFocus("org");

  useEffect(() => {
    if (form) return;
    if (isNew) {
      if (!templates.data) return;
      const tpl = templates.data.find((t) => t.key === params.get("template"));
      setForm({
        name: tpl?.name ?? "",
        icon: tpl?.icon ?? "bot",
        color: tpl?.color ?? "wood",
        description: tpl?.description ?? "",
        instructions: tpl?.instructions ?? "",
        model: MODELS[0].id,
        effort: tpl?.effort ?? "medium",
        tools: tpl?.tools ?? ["documents", "portfolio", "components", "tasks"],
        scope_type: "org",
        scope_id: "",
        ...parseSchedule(null),
        ...(tpl?.schedule ? { ...parseSchedule(tpl.schedule), scheduleOn: false } : {}),
        schedule_prompt: tpl?.schedule_prompt ?? "",
        notify_emails: "",
        template: tpl?.key ?? null,
      });
    } else if (agent.data) {
      const a = agent.data;
      setForm({
        name: a.name,
        icon: a.icon,
        color: a.color,
        description: a.description ?? "",
        instructions: a.instructions,
        model: a.model,
        effort: a.effort,
        tools: a.tools,
        scope_type: a.scope_type,
        scope_id: a.scope_id ?? "",
        ...parseSchedule(a.schedule),
        schedule_prompt: a.schedule_prompt ?? "",
        notify_emails: a.notify_emails.join(", "),
        template: a.template,
      });
    }
  }, [isNew, templates.data, agent.data, params, form]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const scopeOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const p of tree.data ?? []) {
      if (form?.scope_type === "property") out.push({ value: p.id, label: p.name });
      if (form?.scope_type === "building") for (const b of p.buildings) out.push({ value: b.id, label: `${p.name} › ${b.name}` });
    }
    return out;
  }, [tree.data, form?.scope_type]);

  if (agent.error) return <ErrorState error={agent.error} />;
  if (!form) return <Loading />;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        icon: form.icon,
        color: form.color,
        description: form.description,
        instructions: form.instructions,
        model: form.model,
        effort: form.effort,
        tools: form.tools,
        scope_type: form.scope_type,
        scope_id: form.scope_type === "org" ? null : form.scope_id || null,
        schedule: buildSchedule(form),
        schedule_prompt: form.schedule_prompt,
        notify_emails: form.notify_emails
          .split(/[,\s;]+/)
          .map((e) => e.trim())
          .filter(Boolean),
        template: form.template,
      };
      if (isNew) {
        const created = await call<Agent>("/agents", { body });
        toast("Agenten er opprettet", "ok");
        navigate(`/o/${orgId}/agents/${created.id}`, { replace: true });
      } else {
        await call(`/agents/${id}`, { method: "PATCH", body });
        toast("Endringene er lagret – de gjelder fra neste samtale", "ok");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke lagre");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: "Slette agenten?", message: "Agenten arkiveres og slutter å kjøre. Samtaler beholdes ikke i listen.", confirm: "Slett", danger: true }))) return;
    await call(`/agents/${id}`, { method: "DELETE" });
    navigate(`/o/${orgId}/agents`);
  };

  const section = "rounded-xl border border-line bg-panel p-5";
  const h = "mb-1 text-[15px] font-semibold";
  const sub = "mb-4 text-[13px] text-muted";

  return (
    <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "Agenter", to: `/o/${orgId}/agents` }]}
        icon={<AgentAvatar icon={form.icon} color={form.color} />}
        title={isNew ? "Ny agent" : form.name || "Agent"}
        actions={
          <>
            {!isNew && (
              <Button icon={<Play className="size-4" />} disabled={!form.schedule_prompt.trim()} title="Kjør oppdraget i tidsplanen nå, i en ny samtale" onClick={() => panel.ask(form.schedule_prompt, { agentId: id, newConversation: true })}>
                Test oppdrag
              </Button>
            )}
            <Button variant="primary" loading={busy} onClick={save}>
              {isNew ? "Opprett agent" : "Lagre"}
            </Button>
          </>
        }
      />
      {error && <div className="mb-4 rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</div>}
      <div className="flex flex-col gap-5">
        <section className={section}>
          <h2 className={h}>Identitet</h2>
          <p className={sub}>Navn og utseende som vises i chatten.</p>
          <div className="flex flex-col gap-4">
            <Field label="Navn">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="F.eks. Energirådgiver" />
            </Field>
            <Field label="Beskrivelse">
              <Input value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Én setning om hva agenten gjør" />
            </Field>
            <div className="flex flex-wrap gap-6">
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink-2">Ikon</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(AGENT_ICONS).map(([key, Icon]) => (
                    <button key={key} onClick={() => set("icon", key)} className={cn("flex size-8 items-center justify-center rounded-lg border", form.icon === key ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-ink")}>
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink-2">Farge</div>
                <div className="flex gap-1.5">
                  {Object.entries(AGENT_COLORS).map(([key, c]) => (
                    <button key={key} title={c.label} onClick={() => set("color", key)} className={cn("size-8 rounded-lg border-2", form.color === key ? "border-ink" : "border-transparent")} style={{ background: c.bg }}>
                      <span className="mx-auto block size-3 rounded-full" style={{ background: c.fg }} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={section}>
          <h2 className={h}>Instrukser</h2>
          <p className={sub}>Beskriv rollen, arbeidsmåten og hva agenten skal prioritere. Plank legger selv til kunnskap om FDV, NS 3451 og verktøyene.</p>
          <Textarea rows={12} className="font-mono text-[13px] leading-relaxed" value={form.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="Du er …" />
        </section>

        <section className={section}>
          <h2 className={h}>Modell</h2>
          <p className={sub}>Kraftigere modeller gir bedre analyser, men koster mer per kjøring.</p>
          <div className="grid gap-4 @xl:grid-cols-2">
            <Field label="Claude-modell">
              <Select value={form.model} onChange={(e) => set("model", e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} – {m.hint}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Innsats (effort)" hint="Hvor grundig modellen tenker før den svarer">
              <Select value={form.effort} onChange={(e) => set("effort", e.target.value as Effort)}>
                <option value="low">Lav – raske svar</option>
                <option value="medium">Middels</option>
                <option value="high">Høy – grundige analyser</option>
              </Select>
            </Field>
          </div>
        </section>

        <section className={section}>
          <h2 className={h}>Verktøy</h2>
          <p className={sub}>Hva agenten har lov til å lese og endre i Plank.</p>
          <div className="grid gap-1 @xl:grid-cols-2">
            {(Object.entries(TOOL_GROUPS) as [ToolGroup, (typeof TOOL_GROUPS)[ToolGroup]][]).map(([key, g]) => (
              <Checkbox
                key={key}
                checked={form.tools.includes(key)}
                onChange={(v) => set("tools", v ? [...form.tools, key] : form.tools.filter((t) => t !== key))}
                label={
                  <span className="flex items-center gap-2">
                    {g.label}
                    {g.write && <Badge tone="warn">Skriver</Badge>}
                  </span>
                }
                description={g.description}
              />
            ))}
          </div>
        </section>

        <section className={section}>
          <h2 className={h}>Avgrensning</h2>
          <p className={sub}>Avgrens agenten til én eiendom eller ett bygg, eller la den jobbe med hele porteføljen.</p>
          <div className="grid gap-4 @xl:grid-cols-2">
            <Field label="Omfang">
              <Select value={form.scope_type} onChange={(e) => setForm({ ...form, scope_type: e.target.value as FormState["scope_type"], scope_id: "" })}>
                <option value="org">Hele organisasjonen</option>
                <option value="property">Én eiendom</option>
                <option value="building">Ett bygg</option>
              </Select>
            </Field>
            {form.scope_type !== "org" && (
              <Field label={form.scope_type === "property" ? "Eiendom" : "Bygg"}>
                <Select value={form.scope_id} onChange={(e) => set("scope_id", e.target.value)}>
                  <option value="">Velg …</option>
                  {scopeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </section>

        <section className={section}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className={h}>Tidsplan</h2>
              <p className={sub}>La agenten jobbe på egen hånd – f.eks. ukentlig dokumentkontroll eller månedlig servicerapport på e-post.</p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={form.scheduleOn} onChange={(e) => set("scheduleOn", e.target.checked)} />
              Aktiv
            </label>
          </div>
          <div className={cn("flex flex-col gap-4", !form.scheduleOn && "opacity-60")}>
            <div className="grid gap-4 @xl:grid-cols-3">
              <Field label="Hvor ofte">
                <Select value={form.freq} disabled={!form.scheduleOn} onChange={(e) => setForm({ ...form, freq: e.target.value as FormState["freq"], day: "1" })}>
                  <option value="daily">Hver dag</option>
                  <option value="weekdays">Hverdager</option>
                  <option value="weekly">Hver uke</option>
                  <option value="monthly">Hver måned</option>
                </Select>
              </Field>
              {form.freq === "weekly" && (
                <Field label="Dag">
                  <Select value={form.day} disabled={!form.scheduleOn} onChange={(e) => set("day", e.target.value)}>
                    {DAYS.map((d, i) => (
                      <option key={d} value={String(i + 1)}>
                        {d[0]!.toUpperCase() + d.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {form.freq === "monthly" && (
                <Field label="Dag i måneden">
                  <Select value={form.day} disabled={!form.scheduleOn} onChange={(e) => set("day", e.target.value)}>
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i} value={String(i + 1)}>
                        {i + 1}.
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Klokkeslett">
                <Input type="time" value={form.time} disabled={!form.scheduleOn} onChange={(e) => set("time", e.target.value)} />
              </Field>
            </div>
            <Field label="Oppdrag" hint="Hva agenten skal gjøre ved hver kjøring.">
              <Textarea rows={4} value={form.schedule_prompt} onChange={(e) => set("schedule_prompt", e.target.value)} placeholder="F.eks. Finn komponenter med service som forfaller de neste 30 dagene og lag oppgaver for dem." />
            </Field>
            <Field label="Send rapport til" hint="E-postadresser, kommaseparert. Krever at e-post (Resend) er konfigurert.">
              <Input value={form.notify_emails} onChange={(e) => set("notify_emails", e.target.value)} placeholder="drift@firma.no" />
            </Field>
            {agent.data?.next_run_at && form.scheduleOn && <div className="text-[12.5px] text-muted">Neste kjøring: {formatDateTime(agent.data.next_run_at)}</div>}
          </div>
        </section>

        {!isNew && agent.data && (
          <section className={section}>
            <h2 className={h}>Kjøringer</h2>
            {agent.data.runs.length === 0 ? (
              <p className="text-[13px] text-muted">Ingen planlagte kjøringer ennå.</p>
            ) : (
              <ul className="-mx-2">
                {agent.data.runs.map((r) => (
                  <li key={r.id}>
                    <Link to={r.conversation_id ? `/o/${orgId}/conversations/${r.conversation_id}` : "#"} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
                      <Badge tone={r.status === "done" ? "ok" : r.status === "error" ? "bad" : "info"} dot>
                        {r.status === "done" ? "Fullført" : r.status === "error" ? "Feilet" : "Kjører"}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{r.error ?? r.summary?.slice(0, 140) ?? ""}</span>
                      <span className="shrink-0 text-[12px] text-muted">{timeAgo(r.started_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {!isNew && (
          <div className="flex justify-between">
            <Button variant="ghost" className="text-bad" icon={<Trash2 className="size-4" />} onClick={remove}>
              Slett agent
            </Button>
            <Button variant="primary" loading={busy} onClick={save}>
              Lagre
            </Button>
          </div>
        )}
      </div>
      {dialog}
    </div>
  );
}
