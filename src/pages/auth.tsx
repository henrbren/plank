import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Box, FileText, LayoutDashboard, Mail, Sparkles } from "lucide-react";
import { Logo } from "@/components/domain";
import { Button, Field, Input, Loading } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/app";

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-between px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto w-full max-w-sm py-12">{children}</div>
        <div className="text-[12px] text-muted">© {new Date().getFullYear()} Plank</div>
      </div>
      <div className="relative hidden overflow-hidden border-l border-line bg-panel-2 lg:block">
        <Showcase />
      </div>
    </div>
  );
}

/** Illustrasjon av arbeidsflaten på innloggingssiden */
function Showcase() {
  const rows = [
    { icon: <FileText className="size-4" />, title: "Søker i dokumenter etter «filterbytte»", meta: "3 treff" },
    { icon: <Sparkles className="size-4" />, title: "Leser Nordluft NL-4000 – drifts- og vedlikeholdsinstruks", meta: "" },
    { icon: <LayoutDashboard className="size-4" />, title: "Bygger siden «Servicestatus»", meta: "v1" },
    { icon: <Box className="size-4" />, title: "Spør BIM-modellen (IFCSPACE)", meta: "42 rom" },
  ];
  return (
    <div className="flex h-full flex-col justify-center px-14">
      <div className="max-w-lg">
        <div className="text-[13px] font-medium tracking-wide text-accent uppercase">FDV med AI-agenter</div>
        <h2 className="mt-3 text-[34px] leading-[1.1] font-semibold tracking-[-0.03em]">
          Arbeidsflaten der agentene kjenner byggene dine.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          Last opp FDV-dokumentasjon og IFC-modeller, sett opp agenter som jobber for deg, og lag egne sider med levende data – for hver eiendom, hvert bygg og hver etasje.
        </p>
        <div className="mt-10 rounded-2xl border border-line bg-panel p-4 shadow-card">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
            <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Sparkles className="size-3.5" />
            </span>
            FDV-assistent
          </div>
          <div className="mb-3 rounded-lg bg-panel-2 px-3 py-2 text-[13.5px]">Når må vi bytte filter på ventilasjonsaggregatet i Hovedbygg?</div>
          <div className="space-y-1.5">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[12.5px] text-ink-2">
                <span className="text-muted">{r.icon}</span>
                <span className="flex-1 truncate">{r.title}</span>
                {r.meta && <span className="text-muted">{r.meta}</span>}
              </div>
            ))}
          </div>
          <div className="mt-3 text-[13.5px] leading-relaxed">
            Filteret skal byttes <b>hver 6. måned</b>, eller ved trykkfall over 150 Pa. Siste service var for 200 dager siden – den er altså <span className="text-bad">på overtid</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const me = useMe();

  if (me.data) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setState("sending");
    try {
      const res = await api<{ ok: boolean; devLink?: string }>("/auth/request", { body: { email, redirect: params.get("next") ?? undefined } });
      setDevLink(res.devLink ?? null);
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
      setState("idle");
    }
  };

  return (
    <AuthFrame>
      {state === "sent" ? (
        <div>
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Mail className="size-5" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Sjekk e-posten din</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            Vi har sendt en innloggingslenke til <b>{email}</b>. Lenken er gyldig i 15 minutter.
          </p>
          {devLink && (
            <div className="mt-6 rounded-xl border border-dashed border-line-strong p-3 text-[13px]">
              <div className="mb-1 font-medium">Utviklingsmodus</div>
              <a className="break-all text-accent underline" href={devLink}>
                Åpne innloggingslenken
              </a>
            </div>
          )}
          <Button variant="ghost" className="mt-6 -ml-3" onClick={() => setState("idle")}>
            Bruk en annen e-post
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <h1 className="text-[24px] font-semibold tracking-tight">Logg inn i Plank</h1>
          <p className="mt-2 mb-7 text-[14px] text-ink-2">Vi sender deg en innloggingslenke på e-post – ingen passord.</p>
          <Field label="E-post" error={error}>
            <Input type="email" required autoFocus autoComplete="email" placeholder="navn@firma.no" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={state === "sending"}>
            Send innloggingslenke
            <ArrowRight className="size-4" />
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token");
    if (!token) {
      setError("Lenken mangler token.");
      return;
    }
    api<{ redirect: string | null; needsOnboarding: boolean }>("/auth/verify", { body: { token } })
      .then(async (res) => {
        await qc.invalidateQueries({ queryKey: ["me"] });
        if (res.needsOnboarding) navigate("/onboarding", { replace: true });
        else navigate(res.redirect || "/", { replace: true });
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Kunne ikke logge inn"));
  }, [params, navigate, qc]);

  return (
    <AuthFrame>
      {error ? (
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Innloggingen feilet</h1>
          <p className="mt-2 text-[14px] text-ink-2">{error}</p>
          <Button variant="primary" className="mt-6" onClick={() => navigate("/login")}>
            Be om ny lenke
          </Button>
        </div>
      ) : (
        <Loading label="Logger inn …" />
      )}
    </AuthFrame>
  );
}

export function OnboardingPage() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me.isLoading) return <Loading />;
  if (me.error) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const org = await api<{ id: string }>("/me/orgs", { body: { name } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate(`/o/${org.id}?welcome=1`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1 className="text-[24px] font-semibold tracking-tight">Velkommen til Plank</h1>
        <p className="mt-2 mb-7 text-[14px] text-ink-2">Opprett en organisasjon for porteføljen din. Du kan invitere kollegaer etterpå.</p>
        <Field label="Navn på organisasjonen" error={error}>
          <Input required autoFocus placeholder="F.eks. Eiendomsselskapet AS" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy}>
          Opprett organisasjon
        </Button>
        {me.data && me.data.orgs.length > 0 && (
          <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => navigate(`/o/${me.data!.orgs[0]!.id}`)}>
            Avbryt
          </Button>
        )}
      </form>
    </AuthFrame>
  );
}

export function RootRedirect() {
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  if (me.data.orgs.length === 0) return <Navigate to="/onboarding" replace />;
  let last: string | null = null;
  try {
    last = localStorage.getItem("plank-last-org");
  } catch {
    /* ignorer */
  }
  const org = me.data.orgs.find((o) => o.id === last) ?? me.data.orgs[0]!;
  return <Navigate to={`/o/${org.id}`} replace />;
}
