import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ArrowLeftRight, Building2, CalendarClock, Check, CircleAlert, CircleCheck, CirclePause, CreditCard, Gauge, Receipt, RotateCcw, Sparkles, Wallet } from "lucide-react";
import { CREDIT_PACKS, PLAN_IDS, PLANS, type BillingInfo, type Plan, type PlanId, type UsageDay } from "@shared/types";
import { useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDate, formatOre } from "@/lib/format";
import { Badge, Button, Card, cn, ErrorState, Input, Loading, PageHeader, useConfirm, useToast, type Tone } from "@/components/ui";

const kr = (n: number) => `${n.toLocaleString("nb-NO")} kr`;
const dayMonth = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", timeZone: "Europe/Oslo" });
const monthName = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "Europe/Oslo" });
const weekdayDate = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const osloToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());

function statusOf(b: BillingInfo): { label: string; tone: Tone } {
  if (b.managed) return { label: "Inkludert", tone: "info" };
  switch (b.status) {
    case "active":
      return { label: "Aktiv", tone: "ok" };
    case "past_due":
      return { label: "Betaling feilet", tone: "bad" };
    case "canceled":
      return { label: "Avsluttet", tone: "neutral" };
    case "demo":
      return { label: "Demo", tone: "info" };
    default:
      return { label: "Ikke startet", tone: "accent" };
  }
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SubscriptionPage() {
  const { isAdmin, org } = useOrg();
  useSetFocus("org");
  const billing = useOrgQuery<BillingInfo>("/billing");
  const daily = useOrgQuery<UsageDay[]>("/billing/daily");
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const returned = params.get("abonnement") === "ok";

  // Stripe sender webhooken litt etter at kunden er tilbake. Spør igjen noen ganger til abonnementet vises.
  const { refetch } = billing;
  const started = billing.data?.status === "active";
  useEffect(() => {
    if (!returned || started) return;
    const timers = [1500, 4000, 8000, 15000].map((ms) => setTimeout(() => void refetch(), ms));
    return () => timers.forEach(clearTimeout);
  }, [returned, started, refetch]);

  if (billing.isLoading) return <Loading />;
  if (billing.error || !billing.data) return <ErrorState error={billing.error} />;

  const b = billing.data;
  const u = b.usage;
  const plan = PLANS[b.plan];
  const subscribed = !b.managed && (b.status === "active" || b.status === "past_due");
  const trial = !subscribed && !b.managed;
  const status = statusOf(b);
  const daysLeft = Math.max(1, Math.ceil((b.resets_at - Date.now()) / 86_400_000));
  const month = monthName.format(new Date(b.resets_at - 86_400_000));
  const nextMonth = dayMonth.format(new Date(b.resets_at));

  const redirect = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    try {
      const res = await call<{ url: string }>(path, { method: "POST", body }, false);
      window.location.href = res.url;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke åpne betaling", "bad");
      setBusy(null);
    }
  };

  const changePlan = async (to: PlanId) => {
    const next = PLANS[to];
    const upgrade = PLAN_IDS.indexOf(to) > PLAN_IDS.indexOf(b.plan);
    const ok = await confirm({
      title: upgrade ? `Oppgrader til ${next.name}?` : `Bytt til ${next.name}?`,
      confirm: upgrade ? "Oppgrader" : `Bytt til ${next.name}`,
      message: upgrade ? (
        <>
          <p>
            {next.name} koster {kr(next.priceNok)}/mnd inkl. mva. Mellomlegget for resten av betalingsperioden trekkes nå, fra kortet som er registrert.
          </p>
          <p className="mt-2">
            {kr(next.includedAiNok)} AI-bruk og inntil {next.buildings} bygg gjelder med en gang, også for {month}.
          </p>
        </>
      ) : (
        <>
          <p>
            {next.name} koster {kr(next.priceNok)}/mnd inkl. mva. Det dere har betalt for resten av perioden, kommer til gode på neste faktura.
          </p>
          <p className="mt-2">
            AI-bruken som er inkludert i {plan.name}, gjelder ut {month}. Fra {nextMonth} følger {kr(next.includedAiNok)} med hver måned.
          </p>
          {b.building_count > next.buildings && (
            <p className="mt-2 text-warn">
              Dere har {b.building_count} bygg. Med {next.name} kan dere ikke legge til flere før dere er under {next.buildings}.
            </p>
          )}
        </>
      ),
    });
    if (!ok) return;
    setBusy(`plan:${to}`);
    try {
      const res = await call<{ ok: boolean; payUrl: string | null }>("/billing/plan", { method: "POST", body: { plan: to } });
      if (res.ok) {
        toast(`Dere er nå på ${next.name}`, "ok");
      } else if (res.payUrl) {
        window.location.href = res.payUrl;
        return;
      } else {
        toast("Betalingen gikk ikke gjennom, så planen er ikke byttet. Sjekk kortet under Kort og fakturaer.", "bad");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke bytte plan", "bad");
    }
    setBusy(null);
  };

  const planAction = (p: Plan): ReactNode => {
    if (b.managed) return null;
    if (subscribed && p.id === b.plan) {
      return (
        <Button disabled className="w-full" icon={<Check className="size-4" />}>
          Nåværende plan
        </Button>
      );
    }
    if (!isAdmin) return null;
    if (!b.stripe_ready || !b.plans_available.includes(p.id)) {
      return (
        <Button disabled className="w-full">
          Ikke tilgjengelig ennå
        </Button>
      );
    }
    if (subscribed) {
      const upgrade = PLAN_IDS.indexOf(p.id) > PLAN_IDS.indexOf(b.plan);
      return (
        <Button
          className="w-full"
          variant={upgrade ? "accent" : "secondary"}
          disabled={b.status === "past_due"}
          loading={busy === `plan:${p.id}`}
          onClick={() => void changePlan(p.id)}
        >
          {upgrade ? `Oppgrader til ${p.name}` : `Bytt til ${p.name}`}
        </Button>
      );
    }
    return (
      <Button className="w-full" variant={p.id === "pro" ? "accent" : "primary"} loading={busy === `start:${p.id}`} onClick={() => void redirect(`start:${p.id}`, "/billing/checkout", { plan: p.id })}>
        Start med {p.name}
      </Button>
    );
  };

  const includedUsed = Math.min(u.billedOre, u.includedOre);
  const heroUsed = trial ? u.trialOre : u.billedOre;

  return (
    <div className="mx-auto max-w-4xl px-5 py-7 sm:px-8">
      <PageHeader icon={<CreditCard className="size-5" />} title="Abonnement og bruk" subtitle={`Plan, AI-bruk og grense for ${org.name}. Alle beløp er inkl. mva.`} />

      <div className="flex flex-col gap-5">
        {returned && (
          <Banner tone="ok" icon={<CircleCheck className="size-4.5" />} title={started ? "Abonnementet er i gang" : "Takk! Betalingen er mottatt"}>
            {started ? `Dere er på ${plan.name}. Kvitteringen kommer på e-post fra Stripe.` : "Det kan ta noen sekunder før abonnementet vises her."}
          </Banner>
        )}
        {params.get("kreditter") === "ok" && (
          <Banner tone="ok" icon={<CircleCheck className="size-4.5" />} title="Kredittene er kjøpt">
            De vises her så snart betalingen er bekreftet.
          </Banner>
        )}
        {u.paused && (
          <Banner
            tone="bad"
            icon={<CirclePause className="size-4.5" />}
            title="Agentene er satt på pause"
            action={
              isAdmin && (
                <Button size="sm" onClick={() => scrollTo("grense")}>
                  Endre grensen
                </Button>
              )
            }
          >
            {u.limitOre ? `Grensen på ${formatOre(u.limitOre)} for ekstra bruk er nådd.` : "Den inkluderte bruken er brukt opp, og grensen for ekstra bruk er 0 kr."} De starter igjen {nextMonth}, eller
            med en gang grensen heves.
          </Banner>
        )}
        {b.status === "past_due" && (
          <Banner
            tone="warn"
            icon={<CircleAlert className="size-4.5" />}
            title="Siste betaling gikk ikke gjennom"
            action={
              isAdmin &&
              b.portal && (
                <Button size="sm" loading={busy === "portal"} onClick={() => void redirect("portal", "/billing/portal")}>
                  Oppdater kort
                </Button>
              )
            }
          >
            Oppdater betalingskortet for å beholde abonnementet. Planen kan byttes når betalingen er i orden.
          </Banner>
        )}

        <Card padded={false} className="overflow-hidden">
          <div className="flex flex-col gap-5 p-6 @3xl:flex-row @3xl:items-start @3xl:justify-between">
            <div className="min-w-0">
              <div className="text-[12px] font-medium tracking-[0.06em] text-muted uppercase">Nåværende plan</div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                <h2 className="text-[30px] leading-none font-semibold tracking-[-0.025em]">{trial ? "Prøveperiode" : plan.name}</h2>
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </div>
              <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-ink-2">
                {subscribed ? (
                  <>
                    <span className="font-medium text-ink">{kr(plan.priceNok)}/mnd</span> med {kr(plan.includedAiNok)} AI-bruk inkludert hver måned og plass til {plan.buildings} bygg.
                  </>
                ) : b.managed ? (
                  "Abonnementet på denne kontoen er inkludert, og AI-bruken faktureres ikke."
                ) : (
                  "Dere bruker Plank gratis. Det agentene gjør nå, faktureres ikke. Velg en plan når dere vil fortsette."
                )}
              </p>
              {b.note && <p className="mt-2 text-[13px] text-muted">{b.note}</p>}
            </div>
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                {trial && (
                  <Button variant="accent" onClick={() => scrollTo("planer")}>
                    Velg plan
                  </Button>
                )}
                {subscribed && (
                  <Button icon={<ArrowLeftRight className="size-4" />} onClick={() => scrollTo("planer")}>
                    Bytt plan
                  </Button>
                )}
                {b.portal && (
                  <Button icon={<Receipt className="size-4" />} loading={busy === "portal"} onClick={() => void redirect("portal", "/billing/portal")}>
                    Kort og fakturaer
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="grid divide-y divide-line border-t border-line bg-panel-2/50 @2xl:grid-cols-3 @2xl:divide-x @2xl:divide-y-0">
            <HeroStat icon={<Sparkles className="size-4" />} label={`AI-bruk i ${month}`} value={formatOre(heroUsed)}>
              {subscribed ? `av ${formatOre(u.includedOre)} inkludert` : "Faktureres ikke"}
            </HeroStat>
            <HeroStat icon={<Building2 className="size-4" />} label="Bygg" value={`${b.building_count} av ${b.building_limit}`}>
              <MiniBar pct={(b.building_count / Math.max(1, b.building_limit)) * 100} />
            </HeroStat>
            <HeroStat icon={<CalendarClock className="size-4" />} label="Ny måned" value={nextMonth}>
              {daysLeft === 1 ? "I morgen" : `Om ${daysLeft} dager`}
            </HeroStat>
          </div>
        </Card>

        <Card padded={false} className="p-6">
          <SectionTitle title={`Bruk i ${month}`} subtitle={subscribed ? `Inkludert bruk fornyes ${nextMonth}.` : undefined} />
          <div className="mt-5 divide-y divide-line">
            {subscribed && (
              <Meter
                label={`Inkludert i ${plan.name}`}
                value={<Amount used={includedUsed} total={u.includedOre} />}
                pct={u.includedOre > 0 ? (includedUsed / u.includedOre) * 100 : 0}
                fill="bg-accent"
                hint={
                  u.billedOre >= u.includedOre && u.includedOre > 0
                    ? "Brukt opp. Videre bruk trekkes fra kredittene eller kommer på fakturaen."
                    : `${formatOre(u.includedOre - includedUsed)} igjen i ${month}.`
                }
              />
            )}
            {(u.creditUsedOre > 0 || u.creditOre > 0) && (
              <Meter
                label="Kreditter"
                value={<Amount used={u.creditUsedOre} total={u.creditUsedOre + u.creditOre} />}
                pct={(u.creditUsedOre / Math.max(1, u.creditUsedOre + u.creditOre)) * 100}
                fill="bg-info"
                hint={`${formatOre(u.creditOre)} igjen${u.creditExpiresAt ? `, gyldig til ${formatDate(u.creditExpiresAt)}` : ""}. Brukes etter den inkluderte bruken.`}
              />
            )}
            {subscribed && <ExtraMeter extra={u.extraOre} limit={u.limitOre} paused={u.paused} />}
            {b.managed && <Meter label="AI-bruk" value={<span className="font-medium text-ink">{formatOre(u.billedOre)}</span>} hint="Faktureres ikke på denne kontoen." />}
            {trial && (
              <Meter
                label="Prøvebruk"
                value={<span className="font-medium text-ink">{formatOre(u.trialOre)}</span>}
                hint={`Faktureres ikke. Når abonnementet er startet, følger ${kr(PLANS.standard.includedAiNok)} med hver måned på Standard og ${kr(PLANS.pro.includedAiNok)} på Pro.`}
              />
            )}
          </div>
          {subscribed && (
            <div className="mt-5 flex items-center justify-between gap-4 rounded-xl bg-panel-2 px-4 py-3">
              <span className="text-[13.5px] text-ink-2">Ekstra bruk på neste faktura</span>
              <span className="text-[15px] font-semibold tabular-nums">{formatOre(u.invoiceOre)}</span>
            </div>
          )}
        </Card>

        {subscribed && <LimitCard key={u.limitOre ?? "none"} limitOre={u.limitOre} extraOre={u.extraOre} suggestNok={plan.includedAiNok} canEdit={isAdmin} />}

        <Card padded={false} className="p-6">
          <DailyChart days={daily.data} />
        </Card>

        {!b.managed && (
          <section id="planer" className="scroll-mt-6">
            <SectionTitle title="Planer" subtitle="Bytt når som helst. Oppgraderinger gjelder med en gang." />
            <div className="mt-4 grid gap-4 @2xl:grid-cols-2">
              {PLAN_IDS.map((id) => (
                <PlanCard key={id} plan={PLANS[id]} current={subscribed && id === b.plan} highlight={id === "pro"} action={planAction(PLANS[id])} />
              ))}
            </div>
            <p className="mt-3 text-[13px] text-muted">
              {isAdmin ? `Trenger dere mer enn ${PLANS.pro.buildings} bygg? Ta kontakt, så setter vi opp en avtale.` : "En administrator kan starte eller bytte plan."}
            </p>
          </section>
        )}

        {subscribed && b.portal && (
          <section id="kreditter" className="scroll-mt-6">
            <SectionTitle title="Forhåndskjøp kreditter" subtitle="Rabatt for større pakker. Brukes etter den inkluderte bruken, de eldste først, og varer i ett år." />
            <div className="mt-4 grid gap-3 @xl:grid-cols-3">
              {CREDIT_PACKS.map((pack) => {
                const off = Math.round((1 - pack.priceNok / pack.creditNok) * 100);
                return (
                  <div key={pack.id} className="flex flex-col rounded-xl border border-line bg-panel p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-[19px] font-semibold tracking-tight tabular-nums">{kr(pack.creditNok)}</div>
                      {off > 0 && <Badge tone="ok">−{off} %</Badge>}
                    </div>
                    <div className="mt-0.5 text-[13px] text-muted">for {kr(pack.priceNok)}</div>
                    {isAdmin && (
                      <Button className="mt-4" size="sm" loading={busy === pack.id} onClick={() => void redirect(pack.id, "/billing/credits", { packId: pack.id })}>
                        Kjøp
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {!b.managed && (
          <Card padded={false} className="p-6">
            <SectionTitle title="Slik fungerer det" />
            <div className="mt-5 grid gap-x-8 gap-y-5 @2xl:grid-cols-2">
              <HowItem icon={<RotateCcw className="size-4" />} title="Inkludert bruk fornyes hver måned">
                Hver plan har AI-bruk inkludert. Det som ikke brukes, overføres ikke, og ny måned starter den 1.
              </HowItem>
              <HowItem icon={<Wallet className="size-4" />} title="Kreditter tas deretter">
                Kjøpte kreditter brukes når den inkluderte bruken er tom, de eldste først. Først etter det blir det ekstra bruk.
              </HowItem>
              <HowItem icon={<Gauge className="size-4" />} title="Dere bestemmer grensen">
                Ekstra bruk faktureres etterskuddsvis. Med fast grense settes agentene på pause når den er nådd, og administratorer får e-post ved 80 % og 100 %.
              </HowItem>
              <HowItem icon={<ArrowLeftRight className="size-4" />} title="Bytt plan når dere vil">
                Ved oppgradering trekkes mellomlegget med en gang. Ved nedgradering kommer resten til gode, og inkludert bruk gjelder ut måneden.
              </HowItem>
            </div>
          </Card>
        )}
      </div>
      {dialog}
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div>
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
      {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
    </div>
  );
}

const bannerTones = {
  ok: "border-ok/25 bg-ok-soft text-ok",
  warn: "border-warn/25 bg-warn-soft text-warn",
  bad: "border-bad/25 bg-bad-soft text-bad",
};

function Banner({ tone, icon, title, action, children }: { tone: keyof typeof bannerTones; icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border px-4 py-3.5 @xl:flex-row @xl:items-center", bannerTones[tone])}>
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{title}</div>
          <div className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0 pl-7.5 @xl:pl-0">{action}</div>}
    </div>
  );
}

function HeroStat({ icon, label, value, children }: { icon: ReactNode; label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-6 py-4">
      <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-[18px] font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-[12.5px] text-muted">{children}</div>
    </div>
  );
}

function MiniBar({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-3">
      <div className={cn("h-full rounded-full", pct >= 100 ? "bg-warn" : "bg-ink-2/60")} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function Amount({ used, total }: { used: number; total: number | null }) {
  return (
    <>
      <span className="font-medium text-ink">{formatOre(used)}</span>
      <span className="text-muted"> / {total === null ? "ingen grense" : formatOre(total)}</span>
    </>
  );
}

function Meter({ label, value, pct, fill = "bg-accent", hint }: { label: ReactNode; value: ReactNode; pct?: number; fill?: string; hint?: ReactNode }) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-[14px] font-medium">{label}</div>
        <div className="text-right text-[13.5px] tabular-nums">{value}</div>
      </div>
      {pct !== undefined && (
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-panel-3">
          <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fill)} style={{ width: `${pct > 0 ? Math.min(100, Math.max(1.5, pct)) : 0}%` }} />
        </div>
      )}
      {hint && <div className="mt-2 text-[12.5px] leading-relaxed text-muted">{hint}</div>}
    </div>
  );
}

function ExtraMeter({ extra, limit, paused }: { extra: number; limit: number | null; paused: boolean }) {
  if (limit === null) {
    return <Meter label="Ekstra bruk" value={<Amount used={extra} total={null} />} hint="Kommer på neste faktura. Sett en grense under, så stopper agentene der." />;
  }
  if (limit === 0) {
    return (
      <Meter
        label="Ekstra bruk"
        value={<Amount used={extra} total={0} />}
        hint={paused ? "Grensen er 0 kr, så agentene står på pause til neste måned." : "Grensen er 0 kr. Agentene stopper når inkludert bruk og kreditter er brukt opp."}
      />
    );
  }
  const pct = (extra / limit) * 100;
  return (
    <Meter
      label="Ekstra bruk"
      value={<Amount used={Math.min(extra, limit)} total={limit} />}
      pct={pct}
      fill={paused ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ink-2/70"}
      hint={paused ? "Grensen er nådd. Agentene står på pause." : `${formatOre(limit - extra)} igjen før agentene settes på pause.`}
    />
  );
}

function LimitCard({ limitOre, extraOre, suggestNok, canEdit }: { limitOre: number | null; extraOre: number; suggestNok: number; canEdit: boolean }) {
  const call = useOrgApi();
  const toast = useToast();
  const current = limitOre === null ? null : Math.round(limitOre / 100);
  const [mode, setMode] = useState<"unlimited" | "fixed">(current === null ? "unlimited" : "fixed");
  const [amount, setAmount] = useState(current === null ? "" : String(current));
  const [saving, setSaving] = useState(false);

  const cleaned = amount.replace(/[\s\u00a0]/g, "");
  const parsed = mode === "unlimited" ? null : cleaned === "" || !/^\d+$/.test(cleaned) ? Number.NaN : Number(cleaned);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed <= 1_000_000);
  const dirty = parsed !== current;
  const pausesNow = parsed !== null && valid && extraOre > 0 && extraOre >= parsed * 100;

  const save = async () => {
    setSaving(true);
    try {
      await call("/billing/limit", { method: "PATCH", body: { limitNok: parsed } });
      toast(parsed === null ? "Grensen er fjernet" : `Grensen er satt til ${kr(parsed)} per måned`, "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke lagre grensen", "bad");
    }
    setSaving(false);
  };

  return (
    <Card id="grense" padded={false} className="scroll-mt-6 p-6">
      <SectionTitle title="Månedsgrense for ekstra bruk" subtitle="Gjelder det som går utover inkludert bruk og kreditter. Nullstilles hver måned." />
      {canEdit ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Grense" className="inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
              {(["unlimited", "fixed"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => {
                    setMode(m);
                    if (m === "fixed" && amount === "") setAmount(String(suggestNok));
                  }}
                  className={cn(
                    "h-8 rounded-md px-3.5 text-[13.5px] font-medium transition-all",
                    mode === m ? "bg-panel text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--line)]" : "text-muted hover:text-ink",
                  )}
                >
                  {m === "unlimited" ? "Ubegrenset" : "Fast beløp"}
                </button>
              ))}
            </div>
            {mode === "fixed" && (
              <div className="flex items-center gap-2">
                <div className="relative w-36">
                  <Input
                    inputMode="numeric"
                    aria-label="Grense i kroner"
                    value={amount}
                    autoFocus={current === null}
                    onChange={(e) => setAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && valid && dirty) void save();
                    }}
                    className={cn("pr-9 text-right tabular-nums", !valid && "border-bad focus:border-bad focus:ring-bad/20")}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[13px] text-muted">kr</span>
                </div>
                <span className="text-[13.5px] text-muted">per måned</span>
              </div>
            )}
            <Button variant="primary" className="@xl:ml-auto" disabled={!dirty || !valid} loading={saving} onClick={() => void save()}>
              Lagre
            </Button>
          </div>
          {!valid && <p className="mt-2 text-[12.5px] text-bad">Skriv et helt antall kroner, opptil 1 000 000.</p>}
          {valid && pausesNow && dirty && (
            <p className="mt-3 text-[13px] text-warn">Det er allerede brukt {formatOre(extraOre)} ekstra i måneden, så agentene settes på pause med en gang.</p>
          )}
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            {mode === "unlimited"
              ? "Agentene jobber uten stopp, og alt utover det inkluderte kommer på neste faktura."
              : "Når grensen er nådd, settes agentene på pause til neste måned eller til grensen heves. Administratorer får e-post ved 80 % og når grensen er nådd."}
          </p>
        </>
      ) : (
        <p className="mt-4 text-[14px] text-ink-2">
          {current === null ? "Ingen grense er satt." : `Grensen er ${kr(current)} per måned.`} En administrator kan endre den.
        </p>
      )}
    </Card>
  );
}

const SOURCES = [
  { key: "chat", label: "Samtaler", color: "bg-accent" },
  { key: "schedule", label: "Planlagte agenter", color: "bg-info" },
  { key: "document", label: "Dokumenter", color: "bg-ok" },
] as const;

/** Runder opp til et pent tall (1, 2, 2,5 eller 5 ganger en tierpotens) i kroner */
function niceMaxOre(ore: number): number {
  if (ore <= 0) return 1000;
  const nok = ore / 100;
  const pow = 10 ** Math.floor(Math.log10(nok));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= nok) ?? 10;
  return Math.round(step * pow * 100);
}

function DailyChart({ days }: { days: UsageDay[] | undefined }) {
  const [hover, setHover] = useState<number | null>(null);
  const today = osloToday();
  const list = days ?? [];
  const totals = list.map((d) => d.chat + d.schedule + d.document);
  const sum = totals.reduce((a, b) => a + b, 0);
  const scale = niceMaxOre(Math.max(0, ...totals));
  const todayIndex = list.findIndex((d) => d.day === today);
  const bySource = SOURCES.map((s) => ({ ...s, total: list.reduce((a, d) => a + d[s.key], 0) }));
  const hovered = hover !== null ? list[hover] : undefined;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <SectionTitle title="Bruk per dag" subtitle={days ? `${formatOre(sum)} så langt i måneden` : "Laster …"} />
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {bySource.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <span className={cn("size-2.5 rounded-[3px]", s.color)} />
              {s.label}
              <span className="text-muted tabular-nums">{formatOre(s.total)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="relative mt-6 pl-14">
        <div className="relative h-44">
          {[1, 0.5, 0].map((f) => (
            <div key={f} className={cn("absolute inset-x-0 border-t", f === 0 ? "border-line-strong" : "border-dashed border-line")} style={{ bottom: `${f * 100}%` }}>
              <span className="absolute top-0 -left-14 w-12 -translate-y-1/2 pr-1 text-right text-[11px] text-muted tabular-nums">{formatOre(scale * f)}</span>
            </div>
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
            {list.map((d, i) => {
              const total = totals[i] ?? 0;
              const future = d.day > today;
              return (
                <div key={d.day} className="relative flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(future ? null : i)}>
                  {hover === i && <div className="absolute -inset-x-px inset-y-0 rounded-md bg-ink/[0.04]" />}
                  {total > 0 ? (
                    <div
                      className="relative flex flex-col-reverse overflow-hidden rounded-t-[3px] transition-[height] duration-500"
                      style={{ height: `max(3px, ${(total / scale) * 100}%)` }}
                    >
                      {SOURCES.map((s) => (d[s.key] > 0 ? <div key={s.key} className={cn("w-full", s.color)} style={{ height: `${(d[s.key] / total) * 100}%` }} /> : null))}
                    </div>
                  ) : (
                    <div className={cn("relative mx-auto h-[3px] w-full rounded-full", future ? "bg-line/60" : "bg-line-strong/70")} />
                  )}
                </div>
              );
            })}
          </div>
          {hovered && hover !== null && (
            <div
              className="pointer-events-none absolute bottom-full z-10 mb-2 w-52 rounded-xl border border-line bg-panel p-3 shadow-pop"
              style={{
                left: `${((hover + 0.5) / list.length) * 100}%`,
                transform: hover < 4 ? "translateX(-12%)" : hover > list.length - 5 ? "translateX(-88%)" : "translateX(-50%)",
              }}
            >
              <div className="text-[12.5px] font-medium first-letter:uppercase">{weekdayDate.format(new Date(`${hovered.day}T12:00:00Z`))}</div>
              <div className="mt-2 space-y-1">
                {SOURCES.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 text-[12.5px]">
                    <span className={cn("size-2 rounded-[2px]", s.color)} />
                    <span className="text-ink-2">{s.label}</span>
                    <span className="ml-auto tabular-nums">{formatOre(hovered[s.key])}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[12.5px] font-medium">
                <span>Totalt</span>
                <span className="tabular-nums">{formatOre(totals[hover] ?? 0)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="mt-2 flex gap-[3px]">
          {list.map((d, i) => {
            const n = Number(d.day.slice(8));
            const show = i === todayIndex || ((n === 1 || n % 5 === 0) && (todayIndex < 0 || Math.abs(i - todayIndex) > 1));
            return (
              <div key={d.day} className={cn("min-w-0 flex-1 text-center text-[11px] tabular-nums", i === todayIndex ? "font-semibold text-ink" : "text-muted")}>
                {show ? n : ""}
              </div>
            );
          })}
        </div>
        {days && sum === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex h-44 items-center justify-center pl-14 text-[13px] text-muted">Ingen AI-bruk ennå denne måneden.</div>
        )}
      </div>
    </>
  );
}

function PlanCard({ plan, current, highlight, action }: { plan: Plan; current: boolean; highlight: boolean; action: ReactNode }) {
  const ratio = Math.round(plan.includedAiNok / PLANS.standard.includedAiNok);
  const features = [
    <>
      <b className="font-semibold text-ink">{kr(plan.includedAiNok)}</b> AI-bruk inkludert hver måned
    </>,
    <>Inntil {plan.buildings} bygg</>,
    ...(ratio > 1 ? [<>{ratio} ganger så mye AI-bruk som Standard</>] : []),
    <>Agenter, dokumenter, oppgaver og etasjer</>,
    <>Så mange kollegaer dere vil</>,
  ];
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border p-6",
        highlight ? "border-accent/45 bg-linear-to-b from-accent-soft/80 to-panel to-55% shadow-[0_10px_30px_-18px_var(--accent)]" : "border-line bg-panel",
        current && !highlight && "border-line-strong",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{plan.name}</h3>
        {current ? (
          <Badge tone="ok" dot>
            Deres plan
          </Badge>
        ) : highlight ? (
          <Badge tone="accent">For porteføljer</Badge>
        ) : null}
      </div>
      <p className="mt-1 text-[13.5px] text-muted">{plan.blurb}</p>
      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-[36px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{kr(plan.priceNok)}</span>
        <span className="text-[13.5px] text-muted">/mnd</span>
      </div>
      <div className="mt-1 text-[12.5px] text-muted">inkl. mva</div>
      <ul className="mt-5 space-y-2.5 text-[13.5px] text-ink-2">
        {features.map((f, i) => (
          <li key={i} className="flex gap-2.5">
            <Check className={cn("mt-0.5 size-4 shrink-0", highlight ? "text-accent" : "text-ok")} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {action && <div className="mt-auto pt-6">{action}</div>}
    </div>
  );
}

function HowItem({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-ink-2">{icon}</span>
      <div>
        <div className="text-[13.5px] font-semibold">{title}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}
