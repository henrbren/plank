import { useState } from "react";
import { Link, Navigate, Outlet, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Shield } from "lucide-react";
import { PLAN_IDS, PLANS, type BillingStatus, type PlanId } from "@shared/types";
import { Logo } from "@/components/domain";
import { Badge, Button, Card, EmptyState, Field, Input, Loading, PageHeader, Select, Stat, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/app";
import { formatDate, formatOre } from "@/lib/format";

const STATUS: Record<BillingStatus, { label: string; tone: Tone }> = {
  active: { label: "Betaler", tone: "ok" },
  past_due: { label: "Forfalt", tone: "bad" },
  canceled: { label: "Avsluttet", tone: "warn" },
  demo: { label: "Demo", tone: "info" },
  none: { label: "Ikke startet", tone: "neutral" },
};

interface OrgRow {
  id: string;
  name: string;
  created_at: number;
  billing_status: BillingStatus;
  plan: PlanId;
  building_limit: number;
  effective_limit: number;
  billing_note: string | null;
  stripe_subscription_id: string | null;
  spend_limit_ore: number | null;
  included_ore: number;
  members: number;
  properties: number;
  buildings: number;
  owner_email: string | null;
  owner_name: string | null;
  month_cost_ore: number;
  month_billed_ore: number;
  month_trial_ore: number;
  credit_ore: number;
  credit_drawn_ore: number;
}

interface Totals {
  orgs: number;
  users: number;
  buildings: number;
  properties: number;
  paying: number;
  cost_ore: number;
  billed_ore: number;
}

/** Omtrent det som legges på fakturaen denne måneden, før Stripe har fått det */
function toInvoice(o: OrgRow): number {
  const extra = Math.max(0, o.month_billed_ore - o.included_ore - o.credit_drawn_ore - o.credit_ore);
  return o.spend_limit_ore === null ? extra : Math.min(extra, o.spend_limit_ore);
}

function StatusBadge({ status }: { status: BillingStatus }) {
  const s = STATUS[status] ?? STATUS.none;
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function AdminLayout() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to={`/login?next=${encodeURIComponent("/admin")}`} replace />;
  if (!me.data.platformAdmin) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="text-[20px] font-semibold">Ingen tilgang</h1>
        <p className="mt-2 text-[14px] text-muted">Dette området er bare for plattformadministrator.</p>
        <Link to="/" className="mt-6 inline-block text-[13.5px] text-accent hover:underline">
          Tilbake
        </Link>
      </div>
    );
  }
  return (
    <div className="min-h-full bg-bg">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-panel px-4 sm:px-6">
        <Link to="/admin" className="flex items-center gap-2">
          <Logo />
        </Link>
        <Badge tone="accent">Kunder</Badge>
        <span className="hidden text-[12.5px] text-muted sm:inline">Kommuner godkjennes i boligmappa-ms</span>
        <div className="flex-1" />
        <span className="hidden text-[12.5px] text-muted sm:inline">{me.data.user.email}</span>
      </header>
      <Outlet />
    </div>
  );
}

export function AdminHome() {
  const data = useQuery({ queryKey: ["admin"], queryFn: () => api<{ orgs: OrgRow[]; totals: Totals | null }>("/admin") });
  const signups = useQuery({
    queryKey: ["admin-signups"],
    queryFn: () =>
      api<{
        signups: { id: string; org_nr: string; org_name: string | null; org_form: string | null; brand: string; status: string; email: string; name: string | null; created_at: number }[];
      }>("/admin/signups"),
  });
  if (data.isLoading) return <Loading />;
  if (data.error) return <div className="p-8 text-[14px] text-bad">{data.error instanceof Error ? data.error.message : "Kunne ikke hente kunder"}</div>;
  const totals = data.data?.totals;
  const orgs = data.data?.orgs ?? [];
  const over = orgs.filter((o) => o.buildings > o.effective_limit).length;
  const queued = (signups.data?.signups ?? []).filter((s) => s.status === "queued");
  return (
    <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6">
      <PageHeader icon={<Shield className="size-5" />} title="Kunder" subtitle={`Organisasjoner, bygg og abonnement. ${PLAN_IDS.map((id) => `${PLANS[id].name} ${PLANS[id].priceNok.toLocaleString("nb-NO")} kr/mnd dekker ${PLANS[id].buildings} bygg`).join(", ")}. Over det setter du kvoten her.`} />
      {queued.length > 0 && (
        <Card className="mb-6 p-5">
          <h2 className="text-[14px] font-semibold">Kommuner hos LAFT</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">Disse venter i boligmappa-ms-admin. Godkjenning og overføring til kommune.laft.io skjer der, ikke her.</p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {queued.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13.5px]">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.org_name || s.org_nr}</div>
                  <div className="truncate text-[12px] text-muted">
                    {s.org_nr}
                    {s.org_form ? ` · ${s.org_form}` : ""} · {s.email}
                  </div>
                </div>
                <span className="shrink-0 text-[12px] text-muted">{formatDate(s.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 @xl:grid-cols-4">
        <Stat label="Kunder" value={totals?.orgs ?? 0} hint={`${totals?.paying ?? 0} betaler`} />
        <Stat label="Bygg" value={totals?.buildings ?? 0} hint={over ? `${over} over kvoten` : "Alle innenfor kvoten"} tone={over ? "warn" : undefined} />
        <Stat label="API-kostnad" value={formatOre(totals?.cost_ore ?? 0)} hint="Denne måneden" />
        <Stat label="Å fakturere" value={formatOre(totals?.billed_ore ?? 0)} hint="Inkl. mva, betalende kunder" />
      </div>
      {orgs.length === 0 ? (
        <EmptyState title="Ingen kunder ennå" description="Organisasjoner dukker opp her når noen oppretter en konto." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
            <thead className="border-b border-line bg-panel-2/40">
              <tr>
                {["Kunde", "Eier", "Bygg", "AI denne mnd", "Abonnement", "Opprettet"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orgs.map((o) => (
                <tr key={o.id} className="hover:bg-panel-2/50">
                  <td className="px-3 py-2.5">
                    <Link to={`/admin/${o.id}`} className="font-medium hover:underline">
                      {o.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">
                    <div>{o.owner_name ?? "–"}</div>
                    <div className="text-[12px] text-muted">{o.owner_email}</div>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">
                    <span className={o.buildings > o.effective_limit ? "text-bad" : o.buildings >= o.effective_limit ? "text-warn" : ""}>
                      {o.buildings}
                    </span>
                    <span className="text-muted"> / {o.effective_limit}</span>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">
                    <div>{formatOre(o.billing_status === "active" ? o.month_billed_ore : o.month_trial_ore)}</div>
                    <div className="text-[12px] text-muted">{o.billing_status === "active" ? `kost ${formatOre(o.month_cost_ore)}` : "ikke fakturert"}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={o.billing_status} />
                      {o.billing_status === "active" && <span className="text-[12.5px] text-ink-2">{PLANS[o.plan]?.name ?? o.plan}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{formatDate(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AdminOrg() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ["admin", orgId],
    queryFn: () =>
      api<{
        org: OrgRow;
        members: { email: string; name: string | null; role: string; created_at: number }[];
        properties: { id: string; name: string; city: string | null; address: string | null; buildings: number }[];
        buildings: { id: string; name: string; building_type: string | null; gross_area: number | null; year_built: number | null; property_name: string; city: string | null }[];
      }>(`/admin/${orgId}`),
    enabled: Boolean(orgId),
  });
  const org = data.data?.org;
  const [limit, setLimit] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limitValue = limit ?? org?.building_limit ?? 10;
  const noteValue = note ?? org?.billing_note ?? "";
  const planValue = plan ?? org?.plan ?? "standard";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/${orgId}`, {
        method: "PATCH",
        body: { building_limit: limitValue, billing_note: noteValue.trim() || null, ...(org?.stripe_subscription_id ? {} : { plan: planValue }) },
      });
      await qc.invalidateQueries({ queryKey: ["admin"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke lagre");
    } finally {
      setBusy(false);
    }
  };

  if (data.isLoading) return <Loading />;
  if (!org) return <div className="p-8 text-[14px] text-bad">Fant ikke kunden.</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-7 sm:px-6">
      <button onClick={() => navigate("/admin")} className="mb-4 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" />
        Alle kunder
      </button>
      <PageHeader
        icon={<Building2 className="size-5" />}
        title={org.name}
        subtitle={org.owner_email ?? "Ingen eier"}
        actions={
          <>
            <StatusBadge status={org.billing_status} />
            <Link to={`/o/${org.id}`} className="rounded-lg border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
              Åpne arbeidsflaten
            </Link>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Eiendommer" value={org.properties} />
        <Stat label="Bygg" value={org.buildings} hint={`Kvote ${org.effective_limit}`} tone={org.buildings > org.effective_limit ? "bad" : org.buildings >= org.effective_limit ? "warn" : undefined} />
        <Stat label="API-kostnad" value={formatOre(org.month_cost_ore)} hint="Denne måneden" />
        <Stat
          label="Å fakturere"
          value={formatOre(org.billing_status === "active" && org.stripe_subscription_id ? toInvoice(org) : 0)}
          hint={
            org.billing_status !== "active"
              ? `Prøvebruk ${formatOre(org.month_trial_ore)}`
              : !org.stripe_subscription_id
                ? "Inkludert konto, faktureres ikke"
                : `Utover ${formatOre(org.included_ore)} og kreditter${org.spend_limit_ore !== null ? `, grense ${formatOre(org.spend_limit_ore)}` : ""}`
          }
        />
      </div>

      <Card className="mb-5 p-5">
        <h2 className="mb-1 text-[14px] font-semibold">Plan, kvote og avtale</h2>
        <p className="mb-4 text-[13px] text-muted">
          {org.stripe_subscription_id
            ? `Planen styres av abonnementet i Stripe. ${PLANS[org.plan]?.name ?? org.plan} gir ${PLANS[org.plan]?.buildings ?? "–"} bygg. En høyere kvote her gjelder i tillegg.`
            : "Kontoen har ikke Stripe-abonnement, så planen settes her. Den bestemmer inkludert AI-bruk. En høyere kvote enn planen gir, gjelder i tillegg."}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {!org.stripe_subscription_id && (
            <Field label="Plan" className="sm:w-40">
              <Select value={planValue} onChange={(e) => setPlan(e.target.value as PlanId)}>
                {PLAN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {PLANS[id].name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Maks bygg" className="sm:w-36">
            <Input type="number" min={0} value={limitValue} onChange={(e) => setLimit(Number(e.target.value))} />
          </Field>
          <Field label="Notat" className="flex-1">
            <Input value={noteValue} placeholder="F.eks. 1 490 kr/mnd for 25 bygg" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button loading={busy} onClick={save}>
            Lagre
          </Button>
        </div>
        {error && <p className="mt-2 text-[13px] text-bad">{error}</p>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card padded={false} className="overflow-hidden">
          <div className="border-b border-line px-4 py-3 text-[13.5px] font-semibold">Eiendommer</div>
          {data.data?.properties.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted">Ingen eiendommer.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.data?.properties.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium">{p.name}</div>
                    <div className="truncate text-[12px] text-muted">{[p.address, p.city].filter(Boolean).join(", ") || "–"}</div>
                  </div>
                  <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{p.buildings} bygg</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card padded={false} className="overflow-hidden">
          <div className="border-b border-line px-4 py-3 text-[13.5px] font-semibold">Medlemmer</div>
          <ul className="divide-y divide-line">
            {data.data?.members.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">{m.name ?? m.email}</div>
                  <div className="truncate text-[12px] text-muted">{m.email}</div>
                </div>
                <Badge>{m.role === "owner" ? "Eier" : m.role === "admin" ? "Admin" : "Medlem"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card padded={false} className="mt-5 overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-[13.5px] font-semibold">Bygg</div>
        {data.data?.buildings.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted">Ingen bygg.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.data?.buildings.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">{b.name}</div>
                  <div className="truncate text-[12px] text-muted">
                    {b.property_name}
                    {b.city ? ` · ${b.city}` : ""}
                    {b.building_type ? ` · ${b.building_type}` : ""}
                  </div>
                </div>
                <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{b.gross_area ? `${b.gross_area} m²` : b.year_built ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
