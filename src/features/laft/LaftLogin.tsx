import { useState, type FormEvent } from "react";
import type { LaftInstanceOption } from "@shared/types";
import { api } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { Button, Field, Input } from "@/components/ui";

export interface LaftLoginResult {
  redirect?: string | null;
  needsOnboarding?: boolean;
  confirmEmail?: boolean;
  email?: string;
  devLink?: string;
  agentsGranted?: number;
}

export function LaftLoginForm({
  mode,
  orgId,
  redirect,
  onDone,
}: {
  mode: "session" | "connect";
  orgId?: string;
  redirect?: string;
  onDone: (result: LaftLoginResult) => void;
}) {
  const brand = useBrand();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [instances, setInstances] = useState<LaftInstanceOption[] | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"lookup" | "login" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = instances?.find((i) => i.url === url) ?? instances?.[0] ?? null;

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("lookup");
    setError(null);
    try {
      const res = await api<{ instances: LaftInstanceOption[] }>("/auth/laft/lookup", { body: { email } });
      if (res.instances.length === 0) {
        setError(`Ingen ${brand.accountLabel.toLowerCase()} på denne e-posten. Sjekk adressen, eller be om tilgang.`);
        setInstances(null);
        return;
      }
      setInstances(res.instances);
      setUrl(res.instances[0]!.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke slå opp i LAFT");
    } finally {
      setBusy(null);
    }
  };

  const login = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy("login");
    setError(null);
    try {
      const body = { email, password, otp: otp || undefined, url: chosen.url, name: chosen.name, redirect };
      const result =
        mode === "connect" && orgId
          ? await api<LaftLoginResult>(`/orgs/${orgId}/laft/connect`, { body })
          : await api<LaftLoginResult>("/auth/laft/login", { body });
      onDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kunne ikke logge inn i LAFT");
    } finally {
      setBusy(null);
    }
  };

  if (!instances) {
    return (
      <form onSubmit={(e) => void lookup(e)} className="space-y-4">
        <Field label={`E-post i ${brand.accountLabel}`} error={error} hint="Samme adresse som du bruker fra før">
          <Input type="email" required autoFocus autoComplete="email" placeholder="navn@kommune.no" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy === "lookup"}>
          Finn kontoen
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={(e) => void login(e)} className="space-y-4">
      <p className="text-[13.5px] text-ink-2">
        Innlogging som <b>{email}</b>
        <button
          type="button"
          className="ml-2 text-accent hover:underline"
          onClick={() => {
            setInstances(null);
            setPassword("");
            setOtp("");
            setError(null);
          }}
        >
          Bytt e-post
        </button>
      </p>
      {instances.length > 1 && (
        <Field label="LAFT-instans">
          <select className="h-9 w-full rounded-lg border border-line-strong bg-panel px-3 text-[13.5px]" value={url} onChange={(e) => setUrl(e.target.value)}>
            {instances.map((i) => (
              <option key={i.url} value={i.url}>
                {i.name}
                {i.test ? " (test)" : ""}
                {i.mfa ? " · 2-faktor" : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      {instances.length === 1 && chosen && (
        <p className="text-[13px] text-muted">
          {chosen.name}
          {chosen.mfa ? " · krever 2-faktor" : ""}
        </p>
      )}
      <Field label="Passord" error={error}>
        <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {(chosen?.mfa || otp) && (
        <Field label="2-faktor-kode" hint="Fra autentiseringsappen">
          <Input inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={otp} onChange={(e) => setOtp(e.target.value)} />
        </Field>
      )}
      <Button type="submit" variant="primary" className="w-full" loading={busy === "login"}>
        {mode === "connect" ? `Koble til ${brand.accountLabel}` : `Logg inn med ${brand.accountLabel}`}
      </Button>
    </form>
  );
}
