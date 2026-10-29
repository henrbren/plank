import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Building2, CalendarClock, Check, ChevronRight, Eye, Globe2, MapPin, PencilLine, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import type { Member, MemberAccessInput, Role, TreeProperty } from "@shared/types";
import { useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { daysUntil, formatDate } from "@/lib/format";
import { Badge, Button, cn, EmptyState, Field, IconButton, Input, Loading, Modal, PageHeader, Textarea, useConfirm, useToast, type Tone } from "@/components/ui";

const ROLE_LABEL: Record<Role, string> = { owner: "Eier", admin: "Administrator", member: "Medlem" };

/** Dagens dato i Oslo som YYYY-MM-DD */
function osloToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function longDate(iso: string): string {
  return new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00`));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function scopeSummary(props: number, blds: number): string {
  return [props ? plural(props, "eiendom", "eiendommer") : "", blds ? plural(blds, "bygg", "bygg") : ""].filter(Boolean).join(" og ") || "ingenting";
}

// ─── Side ────────────────────────────────────────────────────────────────────

export function AccessPage() {
  const { me, isAdmin, org } = useOrg();
  useSetFocus("org");
  const members = useOrgQuery<Member[]>("/members");
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const [q, setQ] = useState("");

  const list = members.data ?? [];
  const filtered = q.trim()
    ? list.filter((m) => `${m.name ?? ""} ${m.email}`.toLowerCase().includes(q.trim().toLowerCase()))
    : list;
  const limitedCount = list.filter((m) => m.role === "member" && (m.scope === "limited" || !m.can_edit)).length;
  const expiringCount = list.filter((m) => {
    const d = daysUntil(m.expires_on);
    return !m.expired && d != null && d <= 30;
  }).length;

  const remove = async (m: Member) => {
    const self = m.user_id === me.user.id;
    const ok = await confirm({
      title: self ? "Forlate organisasjonen?" : "Fjerne tilgangen?",
      message: self ? (
        <>Du mister tilgangen til {org.name} med en gang.</>
      ) : (
        <>
          <b>{m.name ?? m.email}</b> mister tilgangen til {org.name} med en gang. Samtalene personen har hatt med agentene, blir liggende. Du kan invitere personen på nytt senere.
        </>
      ),
      confirm: self ? "Forlat" : "Fjern tilgangen",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(`/members/${m.user_id}`, { method: "DELETE" });
      toast(self ? "Du har forlatt organisasjonen" : `${m.name ?? m.email} har ikke lenger tilgang`, "ok");
      if (self) window.location.href = "/";
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke fjerne tilgangen", "bad");
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<Users className="size-5" />}
        title="Brukere og tilganger"
        subtitle="Gi kolleger og leverandører tilgang til hele porteføljen eller bare til eiendommene og byggene de jobber med."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing("new")}>
              Inviter
            </Button>
          )
        }
      />

      {members.isLoading ? (
        <Loading />
      ) : (
        <>
          {isAdmin && (
            <div className="mb-5 grid grid-cols-3 gap-3">
              <Summary label="Brukere" value={list.length} />
              <Summary label="Begrenset tilgang" value={limitedCount} hint="Lesetilgang eller utvalgte bygg" />
              <Summary label="Utløper innen 30 dager" value={expiringCount} tone={expiringCount ? "warn" : undefined} />
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            {list.length > 6 && (
              <div className="border-b border-line p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søk etter navn eller e-post" className="pl-9" />
                </div>
              </div>
            )}
            {filtered.length === 0 ? (
              <EmptyState icon={<Users className="size-5" />} title="Ingen treff" description="Prøv et annet navn eller en annen e-postadresse." />
            ) : (
              <ul className="divide-y divide-line">
                {filtered.map((m) => (
                  <MemberRow
                    key={m.user_id}
                    member={m}
                    self={m.user_id === me.user.id}
                    canManage={isAdmin && (m.role !== "owner" || org.role === "owner")}
                    onEdit={() => setEditing(m)}
                    onRemove={() => void remove(m)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="mt-6 grid gap-3 @2xl:grid-cols-3">
            <Explainer icon={<ShieldCheck className="size-4" />} title="Administrator">
              Ser og endrer alt, inviterer andre og styrer abonnementet.
            </Explainer>
            <Explainer icon={<PencilLine className="size-4" />} title="Kan redigere">
              Oppretter og endrer oppgaver, dokumenter, komponenter og bygg innenfor tilgangen.
            </Explainer>
            <Explainer icon={<Eye className="size-4" />} title="Kun lese">
              Ser alt innenfor tilgangen og kan spørre agentene, men kan ikke endre noe.
            </Explainer>
          </div>
        </>
      )}

      {editing && <AccessModal member={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {dialog}
    </div>
  );
}

function Summary({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cn("mt-0.5 text-[22px] leading-tight font-semibold tabular-nums", tone === "warn" && "text-warn")}>{value}</div>
      {hint && <div className="mt-0.5 hidden text-[11.5px] text-muted @xl:block">{hint}</div>}
    </div>
  );
}

function Explainer({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2/50 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-muted">{icon}</span>
        {title}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

const AVATAR_TONES = ["bg-accent-soft text-accent", "bg-info-soft text-info", "bg-ok-soft text-ok", "bg-warn-soft text-warn"];

function Avatar({ name }: { name: string }) {
  const tone = AVATAR_TONES[[...name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  return <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold uppercase", tone)}>{name.slice(0, 1)}</span>;
}

function MemberRow({ member: m, self, canManage, onEdit, onRemove }: { member: Member; self: boolean; canManage: boolean; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const days = daysUntil(m.expires_on);
  const expiry: { tone: Tone; text: string } | null = m.expired
    ? { tone: "bad", text: "Utløpt" }
    : m.expires_on
      ? { tone: days != null && days <= 14 ? "warn" : "neutral", text: days === 0 ? "Siste dag i dag" : `Til ${formatDate(m.expires_on)}` }
      : null;
  const shown = open ? m.places : m.places.slice(0, 3);

  return (
    <li className={cn("flex items-start gap-3 px-4 py-3.5", m.expired && "bg-bad-soft/30")}>
      <Avatar name={m.name ?? m.email} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[14px] font-medium">{m.name ?? m.email}</span>
          {self && <span className="text-[12px] text-muted">(deg)</span>}
        </div>
        <div className="truncate text-[12.5px] text-muted">
          {m.name ? `${m.email} · ` : ""}
          {m.invited_by ? `invitert av ${m.invited_by} ${formatDate(m.created_at)}` : `medlem siden ${formatDate(m.created_at)}`}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {m.role !== "member" ? (
            <Badge tone="accent">
              <ShieldCheck className="size-3" />
              {ROLE_LABEL[m.role]}
            </Badge>
          ) : (
            <>
              <Badge tone={m.can_edit ? "ok" : "info"}>
                {m.can_edit ? <PencilLine className="size-3" /> : <Eye className="size-3" />}
                {m.can_edit ? "Kan redigere" : "Kun lese"}
              </Badge>
              {m.scope === "all" ? (
                <Badge>
                  <Globe2 className="size-3" />
                  Hele porteføljen
                </Badge>
              ) : (
                <Badge>
                  <Building2 className="size-3" />
                  {m.places.length
                    ? scopeSummary(m.places.filter((p) => p.type === "property").length, m.places.filter((p) => p.type === "building").length)
                    : "Utvalgte bygg"}
                </Badge>
              )}
            </>
          )}
          {expiry && (
            <Badge tone={expiry.tone}>
              <CalendarClock className="size-3" />
              {expiry.text}
            </Badge>
          )}
        </div>
        {m.scope === "limited" && m.places.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {shown.map((p) => (
              <span key={`${p.type}:${p.id}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-panel-2/60 px-1.5 py-0.5 text-[12px] text-ink-2">
                {p.type === "property" ? <MapPin className="size-3 shrink-0 text-muted" /> : <Building2 className="size-3 shrink-0 text-muted" />}
                <span className="truncate">
                  {p.name}
                  {p.type === "property" ? <span className="text-muted"> · hele eiendommen</span> : p.property_name ? <span className="text-muted"> · {p.property_name}</span> : null}
                </span>
              </span>
            ))}
            {m.places.length > 3 && (
              <button onClick={() => setOpen((o) => !o)} className="text-[12px] font-medium text-accent hover:underline">
                {open ? "Vis færre" : `+${m.places.length - 3} til`}
              </button>
            )}
          </div>
        )}
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          {!self && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Endre
            </Button>
          )}
          {!(self && m.role === "owner") && (
            <IconButton label={self ? "Forlat organisasjonen" : "Fjern tilgangen"} onClick={onRemove}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Invitasjon og endring ───────────────────────────────────────────────────

function Choice({ active, onClick, icon, title, body, disabled }: { active: boolean; onClick: () => void; icon: ReactNode; title: string; body: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative flex flex-1 items-start gap-2.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "border-accent bg-accent-soft/50 ring-2 ring-accent/15" : "border-line bg-panel hover:border-line-strong hover:bg-panel-2/50",
      )}
    >
      <span className={cn("mt-0.5", active ? "text-accent" : "text-muted")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-2">{body}</span>
      </span>
      {active && <Check className="absolute top-3 right-3 size-4 text-accent" />}
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {hint && <p className="text-[12.5px] text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function TriCheck({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" aria-label={label} className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]" checked={checked} onChange={onChange} />;
}

function PlacePicker({
  tree,
  props,
  blds,
  onChange,
}: {
  tree: TreeProperty[];
  props: Set<string>;
  blds: Set<string>;
  onChange: (props: Set<string>, blds: Set<string>) => void;
}) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.filter((p) => p.buildings.some((b) => blds.has(b.id))).map((p) => p.id)));
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? tree
        .map((p) => (p.name.toLowerCase().includes(needle) || (p.city ?? "").toLowerCase().includes(needle) ? p : { ...p, buildings: p.buildings.filter((b) => b.name.toLowerCase().includes(needle)) }))
        .filter((p) => p.name.toLowerCase().includes(needle) || (p.city ?? "").toLowerCase().includes(needle) || p.buildings.length > 0)
    : tree;

  const toggleProperty = (p: TreeProperty) => {
    const nextProps = new Set(props);
    const nextBlds = new Set(blds);
    if (nextProps.has(p.id)) nextProps.delete(p.id);
    else nextProps.add(p.id);
    for (const b of p.buildings) nextBlds.delete(b.id);
    onChange(nextProps, nextBlds);
  };
  const toggleBuilding = (p: TreeProperty, id: string) => {
    const nextProps = new Set(props);
    const nextBlds = new Set(blds);
    if (nextProps.has(p.id)) {
      // Fra hele eiendommen til alle bygg unntatt dette
      nextProps.delete(p.id);
      for (const b of p.buildings) if (b.id !== id) nextBlds.add(b.id);
    } else if (nextBlds.has(id)) nextBlds.delete(id);
    else nextBlds.add(id);
    onChange(nextProps, nextBlds);
  };

  if (tree.length === 0) return <p className="rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">Organisasjonen har ingen eiendommer ennå.</p>;

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {tree.length > 5 && (
        <div className="border-b border-line bg-panel-2/40 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søk etter eiendom eller bygg" className="h-8 pl-8 text-[13px]" />
          </div>
        </div>
      )}
      <ul className="max-h-72 divide-y divide-line overflow-y-auto">
        {visible.map((p) => {
          const whole = props.has(p.id);
          const some = p.buildings.filter((b) => blds.has(b.id)).length;
          const isOpen = needle ? true : expanded.has(p.id);
          return (
            <li key={p.id}>
              <div className={cn("flex items-center gap-2.5 px-3 py-2", (whole || some > 0) && "bg-accent-soft/25")}>
                <TriCheck checked={whole} indeterminate={some > 0} onChange={() => toggleProperty(p)} label={`Hele ${p.name}`} />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() =>
                    p.buildings.length &&
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(p.id)) n.delete(p.id);
                      else n.add(p.id);
                      return n;
                    })
                  }
                >
                  <MapPin className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
                    <span className="block text-[11.5px] text-muted">
                      {[p.city, plural(p.buildings.length, "bygg", "bygg")].filter(Boolean).join(" · ")}
                      {whole ? " · hele eiendommen" : some ? ` · ${some} valgt` : ""}
                    </span>
                  </span>
                  {p.buildings.length > 0 && <ChevronRight className={cn("size-4 shrink-0 text-muted transition-transform", isOpen && "rotate-90")} />}
                </button>
              </div>
              {isOpen && p.buildings.length > 0 && (
                <ul className="bg-panel-2/30 pb-1">
                  {p.buildings.map((b) => (
                    <li key={b.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 py-1.5 pr-3 pl-9 hover:bg-panel-2/60">
                        <TriCheck checked={whole || blds.has(b.id)} onChange={() => toggleBuilding(p, b.id)} label={b.name} />
                        <Building2 className="size-3.5 shrink-0 text-muted" />
                        <span className="truncate text-[13px]">{b.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-3 py-4 text-[13px] text-muted">Ingen treff på «{q}».</li>}
      </ul>
    </div>
  );
}

function AccessModal({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const { org } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const today = osloToday();
  const editing = member != null;

  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [role, setRole] = useState<Role>(member?.role ?? "member");
  const [canEdit, setCanEdit] = useState(member?.can_edit ?? true);
  const [scope, setScope] = useState<"all" | "limited">(member?.scope ?? "all");
  const [props, setProps] = useState<Set<string>>(() => new Set(member?.places.filter((p) => p.type === "property").map((p) => p.id)));
  const [blds, setBlds] = useState<Set<string>>(() => new Set(member?.places.filter((p) => p.type === "building").map((p) => p.id)));
  const [limitedTime, setLimitedTime] = useState(Boolean(member?.expires_on && !member.expired));
  const [expiresOn, setExpiresOn] = useState(member?.expires_on && !member.expired ? member.expires_on : addMonths(today, 1));
  const [busy, setBusy] = useState(false);

  const isMember = role === "member";
  const presets = useMemo(
    () => [
      { label: "1 uke", value: addDays(today, 7) },
      { label: "1 måned", value: addMonths(today, 1) },
      { label: "3 måneder", value: addMonths(today, 3) },
      { label: "Ut året", value: `${today.slice(0, 4)}-12-31` },
    ],
    [today],
  );

  const selectedProps = props.size;
  const selectedBlds = blds.size;
  const validEmail = editing || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const validScope = !isMember || scope === "all" || selectedProps + selectedBlds > 0;
  const validDate = !isMember || !limitedTime || expiresOn >= today;
  const who = editing ? (member.name ?? member.email) : email.trim() || "Personen";

  const summary = isMember ? (
    <>
      <b>{who}</b> får {canEdit ? "redigeringstilgang" : "lesetilgang"} til{" "}
      <b>{scope === "all" ? "hele porteføljen" : scopeSummary(selectedProps, selectedBlds)}</b>
      {limitedTime && validDate ? (
        <>
          {" "}
          til og med <b>{longDate(expiresOn)}</b>
        </>
      ) : null}
      .{!editing && " En e-post med innloggingslenke sendes med en gang."}
    </>
  ) : (
    <>
      <b>{who}</b> blir {role === "owner" ? "eier" : "administrator"} med full tilgang til alt i {org.name}.{!editing && " En e-post med innloggingslenke sendes med en gang."}
    </>
  );

  const submit = async () => {
    const access: MemberAccessInput = {
      role,
      can_edit: canEdit,
      scope,
      property_ids: [...props],
      building_ids: [...blds],
      expires_on: limitedTime ? expiresOn : null,
    };
    setBusy(true);
    try {
      if (editing) {
        await call(`/members/${member.user_id}`, { method: "PATCH", body: access });
        toast("Tilgangen er oppdatert", "ok");
      } else {
        const res = await call<{ devLink?: string }>("/members", { body: { ...access, email: email.trim(), message: message.trim() || undefined } });
        toast(res.devLink ? "Invitert (utviklingsmodus – lenken ble logget i konsollen)" : `Invitasjon sendt til ${email.trim()}`, "ok");
        if (res.devLink) console.info("Invitasjonslenke:", res.devLink);
      }
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Noe gikk galt", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={editing ? `Tilgang for ${member.name ?? member.email}` : "Inviter til organisasjonen"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" loading={busy} disabled={!validEmail || !validScope || !validDate} icon={editing ? <Check className="size-4" /> : <UserPlus className="size-4" />} onClick={() => void submit()}>
            {editing ? "Lagre tilgangen" : "Send invitasjon"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {!editing && (
          <Field label="E-post">
            <Input type="email" autoFocus placeholder="navn@firma.no" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        )}

        <Section title="Rolle">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Choice active={role === "member"} onClick={() => setRole("member")} icon={<Users className="size-4" />} title="Medlem" body="Får tilgangen du velger under." />
            <Choice
              active={role === "admin"}
              onClick={() => setRole("admin")}
              icon={<ShieldCheck className="size-4" />}
              title="Administrator"
              body="Ser og endrer alt, inviterer andre og styrer abonnementet."
            />
            {editing && org.role === "owner" && (
              <Choice active={role === "owner"} onClick={() => setRole("owner")} icon={<ShieldCheck className="size-4" />} title="Eier" body="Som administrator, og kan endre eierskap." />
            )}
          </div>
        </Section>

        {isMember && (
          <>
            <Section title="Hva kan personen gjøre?">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Choice
                  active={canEdit}
                  onClick={() => setCanEdit(true)}
                  icon={<PencilLine className="size-4" />}
                  title="Kan redigere"
                  body="Opprette og endre oppgaver, dokumenter, komponenter og bygg."
                />
                <Choice active={!canEdit} onClick={() => setCanEdit(false)} icon={<Eye className="size-4" />} title="Kun lese" body="Se alt og spørre agentene, uten å endre noe." />
              </div>
            </Section>

            <Section title="Hvilke eiendommer og bygg?" hint={scope === "limited" ? "Velger du hele eiendommen, får personen også bygg som legges til senere." : undefined}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Choice active={scope === "all"} onClick={() => setScope("all")} icon={<Globe2 className="size-4" />} title="Hele porteføljen" body="Alle eiendommer og bygg, også nye." />
                <Choice active={scope === "limited"} onClick={() => setScope("limited")} icon={<Building2 className="size-4" />} title="Utvalgte" body="Bare eiendommene og byggene du krysser av." />
              </div>
              {scope === "limited" &&
                (tree.data ? (
                  <>
                    <PlacePicker
                      tree={tree.data}
                      props={props}
                      blds={blds}
                      onChange={(p, b) => {
                        setProps(p);
                        setBlds(b);
                      }}
                    />
                    <p className={cn("text-[12.5px]", validScope ? "text-muted" : "text-warn")}>
                      {validScope ? `Valgt: ${scopeSummary(selectedProps, selectedBlds)}` : "Velg minst én eiendom eller ett bygg."}
                    </p>
                  </>
                ) : (
                  <Loading />
                ))}
            </Section>

            <Section title="Varighet">
              <label className="flex cursor-pointer items-center gap-2.5">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={limitedTime} onChange={(e) => setLimitedTime(e.target.checked)} />
                <span className="text-[13.5px]">Tidsbegrenset – passer for leverandører og innleide</span>
              </label>
              {limitedTime && (
                <div className="flex flex-wrap items-center gap-2 pl-6.5">
                  <Input type="date" min={today} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="h-8 w-40 text-[13px]" />
                  {presets.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setExpiresOn(p.value)}
                      className={cn(
                        "h-7 rounded-full border px-2.5 text-[12.5px] transition-colors",
                        expiresOn === p.value ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:border-line-strong",
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                  {!validDate && <span className="text-[12.5px] text-bad">Datoen har allerede vært.</span>}
                </div>
              )}
              {limitedTime && <p className="pl-6.5 text-[12.5px] text-muted">Tilgangen stopper automatisk etter siste dag. Du kan forlenge den her når som helst.</p>}
            </Section>
          </>
        )}

        {!editing && (
          <Field label="Personlig melding (valgfritt)" hint="Kommer med i e-posten.">
            <Textarea value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} placeholder="Hei! Her får du tilgang til byggene vi snakket om." />
          </Field>
        )}

        <div className="rounded-xl border border-line bg-panel-2/60 px-4 py-3 text-[13.5px] leading-relaxed text-ink-2">{summary}</div>
      </div>
    </Modal>
  );
}
