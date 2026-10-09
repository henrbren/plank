import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleAlert, Settings, Trash2, UserPlus } from "lucide-react";
import type { Member, Role } from "@shared/types";
import { api } from "@/lib/api";
import { useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDate } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Field, IconButton, Input, PageHeader, Select, useConfirm, useToast } from "@/components/ui";

const ROLES: Record<Role, string> = { owner: "Eier", admin: "Administrator", member: "Medlem" };

export function SettingsPage() {
  const { org, me, isAdmin } = useOrg();
  useSetFocus("org");
  const qc = useQueryClient();
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const members = useOrgQuery<Member[]>("/members");
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<{ claude: boolean; email: boolean; ai: boolean; dev: boolean }>("/health") });
  const [orgName, setOrgName] = useState(org.name);
  const [name, setName] = useState(me.user.name ?? "");
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
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
  const sendInvite = async () => {
    setBusy("invite");
    try {
      const res = await call<{ devLink?: string }>("/members", { body: { email: invite, role: inviteRole } });
      setInvite("");
      toast(res.devLink ? "Invitert (utviklingsmodus – lenken ble logget)" : "Invitasjon sendt", "ok");
      if (res.devLink) console.info("Invitasjonslenke:", res.devLink);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Feil", "bad");
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

        <Card className="p-5">
          <CardHeader title="Medlemmer" />
          {isAdmin && (
            <div className="mb-4 flex flex-col gap-2 @xl:flex-row">
              <Input type="email" placeholder="kollega@firma.no" value={invite} onChange={(e) => setInvite(e.target.value)} className="flex-1" />
              <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")} className="@xl:w-40">
                <option value="member">Medlem</option>
                <option value="admin">Administrator</option>
              </Select>
              <Button variant="primary" icon={<UserPlus className="size-4" />} disabled={!invite.includes("@")} loading={busy === "invite"} onClick={sendInvite}>
                Inviter
              </Button>
            </div>
          )}
          <ul className="divide-y divide-line">
            {members.data?.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 py-2.5">
                <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent uppercase">{(m.name ?? m.email).slice(0, 1)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium">{m.name ?? m.email}</div>
                  <div className="truncate text-[12px] text-muted">
                    {m.email} · medlem siden {formatDate(m.created_at)}
                  </div>
                </div>
                {isAdmin && m.user_id !== me.user.id ? (
                  <>
                    <Select className="h-8 w-36" value={m.role} onChange={(e) => call(`/members/${m.user_id}`, { method: "PATCH", body: { role: e.target.value } }).catch((err) => toast(err.message, "bad"))}>
                      {Object.entries(ROLES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                    <IconButton
                      label="Fjern"
                      onClick={async () => {
                        if (await confirm({ title: "Fjerne medlem?", message: `${m.email} mister tilgangen til organisasjonen.`, confirm: "Fjern", danger: true }))
                          await call(`/members/${m.user_id}`, { method: "DELETE" }).catch((err) => toast(err.message, "bad"));
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </>
                ) : (
                  <Badge>{ROLES[m.role]}</Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <CardHeader title="Systemstatus" />
          <Status ok={health.data?.claude} label="Claude API" hint={health.data?.claude ? "Agentene er klare." : "ANTHROPIC_API_KEY er ikke satt – agentene kan ikke svare."} />
          <Status ok={health.data?.email} label="E-post (Resend)" hint={health.data?.email ? "Innloggingslenker, invitasjoner og rapporter sendes på e-post." : "RESEND_API_KEY er ikke satt."} />
          <Status ok={health.data?.ai} label="Workers AI" hint="Brukes til å hente ut tekst fra PDF, Office-filer og bilder." />
        </Card>
      </div>
      {dialog}
    </div>
  );
}
