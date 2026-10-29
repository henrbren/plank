import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, CircleAlert, CreditCard, FolderTree, KeyRound, Settings, UserPlus, Users } from "lucide-react";
import { PLANS, type BillingInfo, type Member } from "@shared/types";
import { api } from "@/lib/api";
import { useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDate, formatOre } from "@/lib/format";
import { Badge, Button, ButtonLink, Card, CardHeader, Field, Input, PageHeader, useToast } from "@/components/ui";
import { ApiAccess } from "@/features/api/ApiAccess";

export function SettingsPage() {
  const { org, orgId, me, isAdmin, canEdit, limited } = useOrg();
  useSetFocus("org");
  const qc = useQueryClient();
  const call = useOrgApi();
  const toast = useToast();
  const members = useOrgQuery<Member[]>("/members");
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<{ claude: boolean; email: boolean; ai: boolean; billing: boolean; dev: boolean }>("/health") });
  const billing = useOrgQuery<BillingInfo>("/billing");
  const [orgName, setOrgName] = useState(org.name);
  const [name, setName] = useState(me.user.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setOrgName(org.name), [org.name]);

  const saveProfile = async () => {
    setBusy("profile");
    try {
      await api("/me", { method: "PATCH", body: { name } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast("Profilen er lagret", "ok");
    } finally {
      setBusy(null);
    }
  };
  const saveOrg = async () => {
    setBusy("org");
    try {
      await call("", { method: "PATCH", body: { name: orgName } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast("Organisasjonen er oppdatert", "ok");
    } finally {
      setBusy(null);
    }
  };
  const Status = ({ ok, label, hint }: { ok?: boolean; label: string; hint: string }) => (
    <div className="flex items-start gap-2.5 py-1.5">
      {ok ? <CircleCheck className="mt-0.5 size-4 text-ok" /> : <CircleAlert className="mt-0.5 size-4 text-warn" />}
      <div>
        <div className="text-[13.5px] font-medium">{label}</div>
        <div className="text-[12.5px] text-muted">{hint}</div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
      <PageHeader icon={<Settings className="size-5" />} title="Innstillinger" />
      <div className="flex flex-col gap-5">
        <Card className="p-5">
          <CardHeader title="Din profil" />
          <div className="flex flex-col gap-3 @xl:flex-row @xl:items-end">
            <Field label="Navn" className="flex-1">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="E-post" className="flex-1">
              <Input value={me.user.email} disabled />
            </Field>
            <Button loading={busy === "profile"} onClick={saveProfile}>
              Lagre
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <CardHeader title="Organisasjon" />
          <div className="flex flex-col gap-3 @xl:flex-row @xl:items-end">
            <Field label="Navn" className="flex-1">
              <Input value={orgName} disabled={!isAdmin} onChange={(e) => setOrgName(e.target.value)} />
            </Field>
            {isAdmin && (
              <Button loading={busy === "org"} onClick={saveOrg}>
                Lagre
              </Button>
            )}
          </div>
        </Card>

        {billing.data && (
          <Card className="p-5">
            <CardHeader
              title="Abonnement"
              icon={<CreditCard className="size-4" />}
              action={
                <ButtonLink to={`/o/${orgId}/abonnement`} size="sm" icon={<ArrowRight className="size-3.5" />}>
                  Abonnement og bruk
                </ButtonLink>
              }
            />
            <p className="text-[13.5px] text-ink-2">
              {billing.data.managed ? (
                <>
                  Abonnementet er inkludert, med kvote på <b>{billing.data.building_limit} bygg</b>. {billing.data.building_count} er i bruk. AI-bruk på denne kontoen faktureres ikke.
                </>
              ) : billing.data.status === "active" || billing.data.status === "past_due" ? (
                <>
                  <b>{PLANS[billing.data.plan].name}</b>, {PLANS[billing.data.plan].priceNok.toLocaleString("nb-NO")} kr/mnd inkl. mva. {billing.data.building_count} av {billing.data.building_limit} bygg er i bruk, og{" "}
                  {formatOre(billing.data.usage.billedOre)} av {formatOre(billing.data.usage.includedOre)} inkludert AI-bruk er brukt denne måneden.
                </>
              ) : (
                <>
                  Standard koster {PLANS.standard.priceNok.toLocaleString("nb-NO")} kr/mnd og Pro {PLANS.pro.priceNok.toLocaleString("nb-NO")} kr/mnd, inkl. mva. Begge har AI-bruk inkludert hver måned.
                </>
              )}
            </p>
            <div className="mt-3">
              <Status
                ok={billing.data.status === "active"}
                label={
                  billing.data.status === "active"
                    ? "Abonnementet er aktivt"
                    : billing.data.status === "past_due"
                      ? "Betalingen er forfalt"
                      : billing.data.status === "demo"
                        ? "Demoportefølje"
                        : billing.data.status === "canceled"
                          ? "Abonnementet er avsluttet"
                          : "Abonnementet er ikke startet"
                }
                hint={
                  billing.data.usage.paused
                    ? "Grensen for ekstra AI-bruk er nådd, og agentene er satt på pause."
                    : billing.data.note || (billing.data.stripe_ready ? "Betaling skjer via Stripe." : "Stripe er ikke koblet til ennå.")
                }
              />
            </div>
          </Card>
        )}

        {!limited && (
        <Card className="p-5">
          <CardHeader title="Datakilder" />
          <p className="mb-3 text-[13.5px] text-ink-2">Her henter du bygg og dokumenter inn i Plank. Agentene bruker det samme.</p>
          <div className="divide-y divide-line rounded-xl border border-line">
            <Link to={`/o/${orgId}/laft`} className="flex items-center gap-3 px-3 py-3 hover:bg-panel-2">
              <KeyRound className="size-4 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">LAFT</span>
                <span className="block text-[12.5px] text-muted">Bygg, arbeidsordrer og dokumentarkiv</span>
              </span>
            </Link>
            <Link to={`/o/${orgId}/boligmappa`} className="flex items-center gap-3 px-3 py-3 hover:bg-panel-2">
              <FolderTree className="size-4 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">Boligmappa</span>
                <span className="block text-[12.5px] text-muted">Bygg og dokumenter på organisasjonsnummer</span>
              </span>
            </Link>
          </div>
        </Card>
        )}

        <Card className="p-5">
          <CardHeader
            title="Brukere og tilganger"
            icon={<Users className="size-4" />}
            action={
              <ButtonLink to={`/o/${orgId}/tilganger`} size="sm" variant={isAdmin ? "primary" : "secondary"} icon={isAdmin ? <UserPlus className="size-3.5" /> : <ArrowRight className="size-3.5" />}>
                {isAdmin ? "Inviter og styr tilganger" : "Se brukerne"}
              </ButtonLink>
            }
          />
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {members.data?.slice(0, 6).map((m) => (
                <span
                  key={m.user_id}
                  title={m.name ?? m.email}
                  className="flex size-8 items-center justify-center rounded-full border-2 border-panel bg-accent-soft text-[12px] font-semibold text-accent uppercase"
                >
                  {(m.name ?? m.email).slice(0, 1)}
                </span>
              ))}
            </div>
            <p className="text-[13.5px] text-ink-2">
              {members.data ? `${members.data.length} ${members.data.length === 1 ? "bruker" : "brukere"}. ` : ""}
              Gi tilgang til hele porteføljen eller bare til utvalgte eiendommer og bygg, med lese- eller redigeringstilgang og sluttdato.
            </p>
          </div>
          {!canEdit || limited ? (
            <div className="mt-3">
              <Badge tone="info">
                {!canEdit ? "Du har lesetilgang" : "Du har tilgang til utvalgte eiendommer og bygg"}
                {org.expires_on ? ` til og med ${formatDate(org.expires_on)}` : ""}
              </Badge>
            </div>
          ) : null}
        </Card>

        <ApiAccess />

        <Card className="p-5">
          <CardHeader title="Systemstatus" />
          <Status ok={health.data?.claude} label="Claude API" hint={health.data?.claude ? "Agentene er klare." : "ANTHROPIC_API_KEY er ikke satt – agentene kan ikke svare."} />
          <Status ok={health.data?.email} label="E-post (Resend)" hint={health.data?.email ? "Innloggingslenker, invitasjoner og rapporter sendes på e-post." : "RESEND_API_KEY er ikke satt."} />
          <Status ok={health.data?.ai} label="Workers AI" hint="Brukes til å hente ut tekst fra PDF, Office-filer og bilder." />
        </Card>
      </div>
    </div>
  );
}
