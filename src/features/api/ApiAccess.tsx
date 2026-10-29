import { useState } from "react";
import { Check, Copy, KeyRound, Plug, Trash2 } from "lucide-react";
import type { ApiKeySummary } from "@shared/types";
import { useOrg, useOrgApi, useOrgQuery } from "@/lib/app";
import { formatDate, timeAgo } from "@/lib/format";
import { Badge, Button, Card, CardHeader, Checkbox, Field, IconButton, Input, Modal, useConfirm, useToast } from "@/components/ui";

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* utklippstavlen er ikke tilgjengelig – brukeren kan merke teksten selv */
    }
  };
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[12.5px] select-all">{value}</code>
      <IconButton label={copied ? "Kopiert" : label} onClick={copy}>
        {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  );
}

/** API-nøkler og MCP-tilkobling (Claude, ChatGPT, Cursor, n8n …) */
export function ApiAccess() {
  const { orgId, isAdmin, canEdit } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const keys = useOrgQuery<ApiKeySummary[]>("/api-keys");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  const create = async () => {
    setBusy(true);
    try {
      const res = await call<{ id: string; token: string }>("/api-keys", { method: "POST", body: { name: name.trim() || "API-nøkkel", can_write: write && canEdit } });
      setCreated(res.token);
      setCreating(false);
      setName("");
      setWrite(false);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKeySummary) => {
    const ok = await confirm({
      title: k.kind === "oauth" ? "Koble fra klienten?" : "Trekk tilbake nøkkelen?",
      message: `«${k.name}» mister tilgangen til Plank med en gang.`,
      confirm: k.kind === "oauth" ? "Koble fra" : "Trekk tilbake",
      danger: true,
    });
    if (!ok) return;
    await call(`/api-keys/${k.id}`, { method: "DELETE" });
    toast(k.kind === "oauth" ? "Klienten er koblet fra" : "Nøkkelen er trukket tilbake", "ok");
  };

  return (
    <Card className="p-5">
      <CardHeader
        title="Claude, MCP og API"
        icon={<Plug className="size-4" />}
        action={
          <Button size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => setCreating(true)}>
            Ny API-nøkkel
          </Button>
        }
      />
      <p className="mb-3 text-[13.5px] text-ink-2">
        Bruk Plank fra Claude, ChatGPT, Cursor og andre AI-verktøy via MCP, eller fra egne skript og integrasjoner. Klientene får de samme verktøyene som agentene – søk i dokumenter,
        FDV-analyse, oppgaver, sider og Boligmappa – og aldri mer tilgang enn du har selv.
      </p>
      <Field label="MCP-adresse" hint="Claude: Innstillinger → Connectors → Add custom connector. Du logger inn og velger organisasjon når du kobler til.">
        <CopyField value={mcpUrl} label="Kopier adressen" />
      </Field>
      <details className="mt-3 text-[13px] text-ink-2">
        <summary className="cursor-pointer font-medium text-ink">Andre klienter og REST-API</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p>Claude Code:</p>
          <CopyField value={`claude mcp add --transport http plank ${mcpUrl}`} label="Kopier kommandoen" />
          <p>
            Klienter uten innlogging bruker en API-nøkkel i headeren <code>Authorization: Bearer plk_…</code>. Den samme nøkkelen gir tilgang til REST-API-et:{" "}
            <code>GET /api/orgs/{orgId}/tools</code> lister verktøyene med JSON Schema, og <code>POST /api/orgs/{orgId}/tools/&lt;navn&gt;</code> kjører ett.
          </p>
        </div>
      </details>

      {keys.data && keys.data.length > 0 && (
        <div className="mt-4 divide-y divide-line rounded-xl border border-line">
          {keys.data.map((k) => (
            <div key={k.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                  {k.name}
                  <Badge tone={k.kind === "oauth" ? "accent" : "neutral"}>{k.kind === "oauth" ? "Tilkoblet klient" : "API-nøkkel"}</Badge>
                  <Badge tone={k.can_write ? "warn" : "info"}>{k.can_write ? "Lese og endre" : "Lese"}</Badge>
                </span>
                <span className="block text-[12.5px] text-muted">
                  {k.kind === "key" ? <code>{k.prefix}…</code> : null}
                  {k.kind === "key" ? " · " : ""}
                  {isAdmin ? `${k.user_email} · ` : ""}
                  {k.last_used_at ? `brukt ${timeAgo(k.last_used_at)}` : "ikke brukt ennå"}
                  {k.expires_at ? ` · utløper ${formatDate(k.expires_at)}` : ""}
                </span>
              </span>
              <IconButton label={k.kind === "oauth" ? "Koble fra" : "Trekk tilbake"} onClick={() => revoke(k)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Ny API-nøkkel"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Avbryt
            </Button>
            <Button loading={busy} onClick={create}>
              Lag nøkkel
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Navn" hint="Hva nøkkelen brukes til, f.eks. «n8n» eller «Cursor».">
            <Input value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
          </Field>
          <Checkbox
            checked={write && canEdit}
            disabled={!canEdit}
            onChange={setWrite}
            label="Kan endre data"
            description={canEdit ? "Opprette oppgaver og komponenter, laste opp dokumenter, lage sider og hente fra Boligmappa. Uten dette kan nøkkelen bare lese." : "Du har lesetilgang, så nøkkelen kan bare lese."}
          />
        </div>
      </Modal>

      <Modal
        open={created != null}
        onClose={() => setCreated(null)}
        title="Kopier nøkkelen nå"
        footer={<Button onClick={() => setCreated(null)}>Ferdig</Button>}
      >
        <p className="mb-3 text-[13.5px] text-ink-2">Nøkkelen vises bare denne ene gangen. Oppbevar den som et passord.</p>
        {created && <CopyField value={created} label="Kopier nøkkelen" />}
      </Modal>
      {confirmDialog}
    </Card>
  );
}
