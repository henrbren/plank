import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Box, Check, ChevronRight, FileText, Landmark, LayoutDashboard, Mail, Sparkles, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/domain";
import { Button, Field, Input, Loading, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatOrgNr } from "@/lib/format";
import { useMe } from "@/lib/app";
import { useBrand, useBrandState } from "@/lib/brand";
import { startVippsLogin } from "@/lib/vipps";
import { BRANDS } from "@shared/brand";
import { LaftLoginForm } from "@/features/laft/LaftLogin";
import { AccessRequestForm, AccessRequestSent, type AccessRequestResult } from "@/features/onboarding/AccessRequest";

export function AuthFrame({ children }: { children: ReactNode }) {
  const brand = useBrand();
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-between px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto w-full max-w-sm py-12">{children}</div>
        <div className="text-[12px] text-muted">© {new Date().getFullYear()} {brand.copyright}</div>
      </div>
      <div className="relative hidden overflow-hidden border-l border-line bg-panel-2 lg:block">
        <Showcase />
      </div>
    </div>
  );
}

/** Illustrasjon av arbeidsflaten på innloggingssiden */
function Showcase() {
  const brand = useBrand();
  const rows = [
    { icon: <FileText className="size-4" />, title: "Søker i dokumenter etter «filterbytte»", meta: "3 treff" },
    { icon: <Sparkles className="size-4" />, title: "Leser Nordluft NL-4000 – drifts- og vedlikeholdsinstruks", meta: "" },
    { icon: <LayoutDashboard className="size-4" />, title: "Bygger siden «Servicestatus»", meta: "v1" },
    { icon: <Box className="size-4" />, title: "Spør BIM-modellen (IFCSPACE)", meta: "42 rom" },
  ];
  return (
    <div className="flex h-full flex-col justify-center px-14">
      <div className="max-w-lg">
        <div className="text-[13px] font-medium tracking-wide text-accent uppercase">{brand.showcaseKicker}</div>
        <h2 className="mt-3 text-[34px] leading-[1.1] font-semibold tracking-[-0.03em]">{brand.showcaseTitle}</h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{brand.showcaseLead}</p>
        <div className="mt-10 rounded-2xl border border-line bg-panel p-4 shadow-card">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
            <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Sparkles className="size-3.5" />
            </span>
            {brand.name}-assistent
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

function VippsButton({ next, label = "Fortsett med Vipps" }: { next?: string | null; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        type="button"
        className="w-full !bg-[#FF5B24] !text-white hover:!bg-[#e04e1c]"
        size="lg"
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          startVippsLogin(next).catch((err) => {
            setError(err instanceof Error ? err.message : "Vipps er ikke tilgjengelig");
            setBusy(false);
          });
        }}
      >
        {label}
      </Button>
      {error && <p className="mt-2 text-center text-[13px] text-bad">{error}</p>}
    </div>
  );
}

function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="mt-3 block w-full text-center text-[13.5px] text-muted hover:text-ink">
      {children}
    </button>
  );
}

type Intent = "naeringsmappa" | "sameie" | "kommune";

const INTENT_KEY = "plank-intent";

function readIntent(): Intent | null {
  try {
    const v = sessionStorage.getItem(INTENT_KEY);
    return v === "naeringsmappa" || v === "sameie" || v === "kommune" ? v : null;
  } catch {
    return null;
  }
}

function ChoiceCard({ icon, title, body, onClick }: { icon: ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3.5 rounded-2xl border border-line bg-panel p-4 text-left transition hover:border-line-strong hover:bg-panel-2"
    >
      <span className="flex size-11 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15.5px] font-semibold">{title}</span>
        <span className="block text-[13px] text-muted">{body}</span>
      </span>
      <ChevronRight className="size-4 text-muted" />
    </button>
  );
}

/** Første steg på LAFT-domenene: samme valg som i Næringsmappa-appen, pluss kommune. */
function BrandChooser({ onPick }: { onPick: (intent: Intent) => void }) {
  return (
    <div>
      <div className="text-[12.5px] font-semibold tracking-wide text-accent uppercase">Velg produkt</div>
      <h1 className="mt-2 text-[26px] font-semibold tracking-tight">Hva skal du logge inn på?</h1>
      <p className="mt-2 mb-7 text-[14px] text-ink-2">Samme innlogging og samme arkiv. Velg det som passer dere.</p>
      <div className="space-y-2.5">
        {(["naeringsmappa", "sameie"] as const).map((id) => (
          <ChoiceCard
            key={id}
            icon={<img src={BRANDS[id].logo ?? ""} alt="" className="size-10 object-contain" />}
            title={BRANDS[id].name}
            body={BRANDS[id].chooserBody}
            onClick={() => onPick(id)}
          />
        ))}
        <ChoiceCard
          icon={
            <span className="flex size-10 items-center justify-center rounded-xl bg-panel-3 text-ink-2">
              <Landmark className="size-5" />
            </span>
          }
          title="Kommune"
          body="Kommunale bygg. LAFT godkjenner før dere flyttes over."
          onClick={() => onPick("kommune")}
        />
      </div>
    </div>
  );
}

export function LoginPage() {
  const { brand, laftHost, choose } = useBrandState();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [intent, setIntent] = useState<Intent | null>(() => (laftHost ? readIntent() : null));
  const [mode, setMode] = useState<"choose" | "home" | "email" | "laft" | "request">(laftHost ? (readIntent() ? "home" : "choose") : "email");
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [laftConfirm, setLaftConfirm] = useState<{ email: string; devLink?: string } | null>(null);
  const [requested, setRequested] = useState<AccessRequestResult | null>(null);
  const me = useMe();
  const next = params.get("next");

  if (me.data) return <Navigate to="/" replace />;

  const pick = (next: Intent) => {
    try {
      sessionStorage.setItem(INTENT_KEY, next);
    } catch {
      /* ignorer */
    }
    if (next !== "kommune") choose(next);
    setIntent(next);
    setMode("home");
  };

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

  if (laftConfirm) {
    return (
      <AuthFrame>
        <div>
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Mail className="size-5" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Bekreft innloggingen</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            Vi har sendt en lenke til <b>{laftConfirm.email}</b>. Åpne den for å knytte kontoen til {brand.name}.
          </p>
          {laftConfirm.devLink && (
            <div className="mt-6 rounded-xl border border-dashed border-line-strong p-3 text-[13px]">
              <div className="mb-1 font-medium">Utviklingsmodus</div>
              <a className="break-all text-accent underline" href={laftConfirm.devLink}>
                Åpne bekreftelsen
              </a>
            </div>
          )}
          <Button variant="ghost" className="mt-6 -ml-3" onClick={() => setLaftConfirm(null)}>
            Tilbake
          </Button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      {state === "sent" ? (
        <div>
          <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Mail className="size-5" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Sjekk e-posten din</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            Vi har sendt en innloggingslenke til <b>{email}</b>. Den virker i 15 minutter. Åpne e-posten nå, så lander du rett i neste steg.
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
      ) : mode === "laft" ? (
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Logg inn med {brand.accountLabel}</h1>
          <p className="mt-2 mb-7 text-[14px] text-ink-2">Samme bruker som fra før. Byggene og dokumentene kommer med.</p>
          <LaftLoginForm
            mode="session"
            redirect={next ?? undefined}
            onDone={async (r) => {
              if (r.confirmEmail) {
                setLaftConfirm({ email: r.email ?? "", devLink: r.devLink });
                return;
              }
              await qc.invalidateQueries({ queryKey: ["me"] });
              if (r.needsOnboarding) navigate("/onboarding", { replace: true });
              else navigate(r.redirect || "/", { replace: true });
            }}
          />
          <Button variant="ghost" className="mt-4 -ml-3" onClick={() => setMode(laftHost ? "home" : "email")}>
            Tilbake
          </Button>
        </div>
      ) : mode === "choose" ? (
        <BrandChooser onPick={pick} />
      ) : mode === "request" && requested ? (
        <AccessRequestSent
          result={requested}
          onBack={() => {
            setRequested(null);
            setMode("home");
          }}
        />
      ) : mode === "request" ? (
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">{intent === "kommune" ? "Be om tilgang for kommunen" : "Be om tilgang"}</h1>
          <p className="mt-2 mb-7 text-[14px] leading-relaxed text-ink-2">
            Uten Vipps. Fyll inn virksomheten, navnet ditt og e-postadressen. LAFT godkjenner forespørselen, og så får du en e-post med lenke inn.
          </p>
          <AccessRequestForm onDone={setRequested} />
          <Button variant="ghost" className="mt-4 -ml-3" onClick={() => setMode("home")}>
            Tilbake
          </Button>
        </div>
      ) : mode === "home" && intent === "kommune" ? (
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Kommune</h1>
          <p className="mt-2 mb-7 text-[14px] leading-relaxed text-ink-2">
            Har kommunen LAFT fra før, logger dere inn der. Nye kommuner ber om tilgang med Vipps eller e-post. LAFT godkjenner, og så flyttes dere over til
            kommuneløsningen.
          </p>
          <a
            href="https://kommune.laft.io"
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-panel text-[14.5px] font-medium hover:bg-panel-2"
          >
            Gå til kommune.laft.io
            <ArrowRight className="size-4" />
          </a>
          <div className="my-6 flex items-center gap-3 text-[12px] text-muted">
            <span className="h-px flex-1 bg-line" />
            ny kommune
            <span className="h-px flex-1 bg-line" />
          </div>
          <VippsButton next={next} label="Be om tilgang med Vipps" />
          <TextLink onClick={() => setMode("request")}>Uten Vipps? Be om tilgang med e-post</TextLink>
          <Button variant="ghost" className="mt-4 -ml-3" onClick={() => setMode("choose")}>
            Tilbake
          </Button>
        </div>
      ) : mode === "home" ? (
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">{brand.loginTitle}</h1>
          <p className="mt-2 mb-7 text-[14px] text-ink-2">{brand.loginLead}</p>
          <VippsButton next={next} />
          <div className="my-6 flex items-center gap-3 text-[12px] text-muted">
            <span className="h-px flex-1 bg-line" />
            eller
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button type="button" className="w-full" onClick={() => setMode("laft")}>
            Logg inn med {brand.accountLabel}
          </Button>
          <TextLink onClick={() => setMode("request")}>Uten Vipps? Be om tilgang med e-post</TextLink>
          <TextLink onClick={() => setMode("email")}>Fått tilgang på e-post? Logg inn med e-postlenke</TextLink>
          <Button variant="ghost" className="mt-4 -ml-3" onClick={() => setMode("choose")}>
            Tilbake
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <h1 className="text-[24px] font-semibold tracking-tight">{brand.loginTitle}</h1>
          <p className="mt-2 mb-7 text-[14px] text-ink-2">{brand.loginLead}</p>
          <Field label="E-post" error={error}>
            <Input type="email" required autoFocus autoComplete="email" placeholder="navn@firma.no" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={state === "sending"}>
            Send innloggingslenke
            <ArrowRight className="size-4" />
          </Button>
          <div className="my-6 flex items-center gap-3 text-[12px] text-muted">
            <span className="h-px flex-1 bg-line" />
            eller
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button type="button" className="w-full" onClick={() => setMode("laft")}>
            Logg inn med {brand.accountLabel}
          </Button>
          {laftHost ? (
            <Button type="button" variant="ghost" className="mt-4 -ml-3" onClick={() => setMode("home")}>
              Tilbake
            </Button>
          ) : (
            <Link to="/demo" className="mt-8 flex items-center justify-center gap-1.5 text-[13.5px] text-muted hover:text-ink">
              Send demo til noen
              <ArrowRight className="size-3.5" />
            </Link>
          )}
        </form>
      )}
    </AuthFrame>
  );
}

export function SendDemoPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setState("sending");
    try {
      const res = await api<{ ok: boolean; devLink?: string }>("/auth/demo", { body: { email } });
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
          <h1 className="text-[22px] font-semibold tracking-tight">Demoen er sendt</h1>
          <p className="mt-2 text-[14px] text-ink-2">
            <b>{email}</b> får en e-post med en innloggingslenke som varer i 48 timer. Første gang de åpner den, kommer de inn i en ferdig demoportefølje.
          </p>
          {devLink && (
            <div className="mt-6 rounded-xl border border-dashed border-line-strong p-3 text-[13px]">
              <div className="mb-1 font-medium">Utviklingsmodus</div>
              <a className="break-all text-accent underline" href={devLink}>
                Åpne demolenken
              </a>
            </div>
          )}
          <Button variant="ghost" className="mt-6 -ml-3" onClick={() => setState("idle")}>
            Send til en annen
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <h1 className="text-[24px] font-semibold tracking-tight">Send demo til noen</h1>
          <p className="mt-2 mb-7 text-[14px] leading-relaxed text-ink-2">
            Skriv inn e-postadressen, så sender vi en lenke som varer i 48 timer. E-posten forteller hvorfor Plank er verdt å prøve, og nye brukere kommer rett inn i en demoportefølje.
          </p>
          <Field label="E-post til mottakeren" error={error}>
            <Input type="email" required autoFocus autoComplete="off" placeholder="navn@firma.no" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={state === "sending"}>
            Send demo
            <ArrowRight className="size-4" />
          </Button>
          <Link to="/login" className="mt-6 flex items-center justify-center gap-1.5 text-[13.5px] text-muted hover:text-ink">
            Tilbake til innlogging
          </Link>
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

interface OrgLookup {
  orgNr: string;
  name: string;
  orgForm: string | null;
  municipal: boolean;
  access: "kommune" | "vipps" | "none" | "role" | "granted";
  role?: string;
  granted?: number;
  vippsName?: string | null;
}

interface SignupRow {
  id: string;
  org_nr: string;
  org_name: string | null;
  status: string;
  kind: "kommune" | "access";
  created_at: number;
}

export function OnboardingPage() {
  const { laftHost } = useBrandState();
  return laftHost ? <LaftOnboarding /> : <PlankOnboarding />;
}

function PlankOnboarding() {
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

const ORGNR_KEY = "plank-orgnr";

function AccessNote({ company }: { company: OrgLookup }) {
  const tone =
    company.access === "role" || company.access === "granted"
      ? "border-line bg-panel-2"
      : company.access === "none"
        ? "border-bad bg-bad-soft"
        : "border-warn bg-warn-soft";
  return (
    <div className={`mt-3 rounded-xl border px-3.5 py-3 text-[13.5px] ${tone}`}>
      <div className="font-medium">{company.name}</div>
      <div className="text-muted">
        {company.orgForm || "Organisasjon"} · {formatOrgNr(company.orgNr)}
      </div>
      {company.access === "role" && (
        <p className="mt-2 flex items-start gap-1.5 text-[13px]">
          <Check className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span>
            {company.vippsName ? (
              <>
                <b>{company.vippsName}</b> er registrert som {company.role?.toLowerCase()}.
              </>
            ) : (
              <>Du har tilgang som {company.role?.toLowerCase()}.</>
            )}
          </span>
        </p>
      )}
      {company.access === "granted" && (
        <p className="mt-2 flex items-start gap-1.5 text-[13px]">
          <Check className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span>
            {company.vippsName} står ikke som personlig rolle i Brønnøysundregistrene. Boligmappa har likevel gitt virksomheten tilgang til{" "}
            {company.granted === 1 ? "ett bygg" : `${company.granted} bygg`}.
          </span>
        </p>
      )}
      {company.access === "kommune" && (
        <p className="mt-2 text-[13px] leading-relaxed">
          Dette er en kommune. LAFT godkjenner forespørselen i Boligmappa-admin, og så flyttes dere over til kommuneløsningen.
        </p>
      )}
      {company.access === "vipps" && (
        <p className="mt-2 text-[13px] leading-relaxed">
          Bekreft deg med Vipps, så sjekker vi at du har en rolle i {company.name} hos Brønnøysundregistrene. Uten Vipps kan du be LAFT om tilgang.
        </p>
      )}
      {company.access === "none" && (
        <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-relaxed">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-bad" />
          <span>
            Vi fant ingen rolle for <b>{company.vippsName}</b> i {company.name}. Har du likevel lov til å hente dokumentene, kan du be LAFT om tilgang.
          </span>
        </p>
      )}
    </div>
  );
}

/** Steg to på LAFT-domenene: organisasjonsnummer, rollesjekk og videre til henting fra Boligmappa */
function LaftOnboarding() {
  const brand = useBrand();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const kommune = readIntent() === "kommune";
  const [orgNr, setOrgNr] = useState(() => {
    try {
      return sessionStorage.getItem(ORGNR_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [company, setCompany] = useState<OrgLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const looked = useRef<string | null>(null);

  const lookup = async (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 9) return;
    looked.current = digits;
    setLooking(true);
    setError(null);
    setCompany(null);
    try {
      sessionStorage.setItem(ORGNR_KEY, digits);
    } catch {
      /* ignorer */
    }
    try {
      const res = await api<OrgLookup>("/me/org-lookup", { body: { orgNr: digits } });
      if (looked.current === digits) setCompany(res);
    } catch (err) {
      if (looked.current === digits) setError(err instanceof Error ? err.message : "Kunne ikke slå opp organisasjonen");
    } finally {
      if (looked.current === digits) setLooking(false);
    }
  };

  useEffect(() => {
    if (me.data && orgNr.replace(/\D/g, "").length === 9 && looked.current === null) void lookup(orgNr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);

  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;

  if (requesting && company) {
    return (
      <AuthFrame>
        <h1 className="text-[24px] font-semibold tracking-tight">Be om tilgang</h1>
        <p className="mt-2 mb-7 text-[14px] leading-relaxed text-ink-2">
          LAFT går gjennom forespørselen. Når den er godkjent, får du en e-post, og byggene og dokumentene hentes fra Boligmappa inn i {brand.name}.
        </p>
        <AccessRequestForm
          user={me.data.user}
          initialOrgNr={company.orgNr}
          onDone={async () => {
            try {
              sessionStorage.removeItem(ORGNR_KEY);
            } catch {
              /* ignorer */
            }
            await qc.invalidateQueries({ queryKey: ["signup"] });
            navigate("/venter", { replace: true });
          }}
        />
        <Button variant="ghost" className="mt-4 -ml-3" onClick={() => setRequesting(false)}>
          Tilbake
        </Button>
      </AuthFrame>
    );
  }

  const canSubmit = company && (company.access === "role" || company.access === "granted" || company.access === "kommune");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!company || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const org = await api<{ id?: string; queued?: boolean; autoImport?: boolean }>("/me/orgs", { body: { orgNr: company.orgNr } });
      try {
        sessionStorage.removeItem(ORGNR_KEY);
      } catch {
        /* ignorer */
      }
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["signup"] });
      if (org.queued) navigate("/venter", { replace: true });
      else if (org.id) navigate(org.autoImport ? `/velkommen/${org.id}` : `/o/${org.id}?welcome=1`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt");
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1 className="text-[24px] font-semibold tracking-tight">{kommune ? "Hvilken kommune?" : "Hvilken virksomhet?"}</h1>
        <p className="mt-2 mb-7 text-[14px] leading-relaxed text-ink-2">
          {kommune
            ? "Skriv organisasjonsnummeret til kommunen. LAFT godkjenner før dere flyttes over til kommuneløsningen."
            : `Skriv organisasjonsnummeret. Vi sjekker rollen din i Brønnøysund, og henter så byggene og dokumentene fra Boligmappa inn i ${brand.name}.`}
        </p>
        <Field label="Organisasjonsnummer" hint="9 siffer" error={error}>
          <div className="relative">
            <Input
              inputMode="numeric"
              autoFocus
              placeholder="123 456 789"
              value={orgNr}
              onChange={(e) => {
                setOrgNr(e.target.value);
                setCompany(null);
                looked.current = null;
                if (e.target.value.replace(/\D/g, "").length === 9) void lookup(e.target.value);
              }}
            />
            {looking && <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />}
          </div>
        </Field>
        {company && <AccessNote company={company} />}
        {company?.access === "vipps" ? (
          <div className="mt-4">
            <VippsButton next="/onboarding" label="Bekreft med Vipps" />
            <TextLink onClick={() => setRequesting(true)}>Uten Vipps? Be om tilgang med e-post</TextLink>
          </div>
        ) : company?.access === "none" ? (
          <Button type="button" variant="primary" size="lg" className="mt-4 w-full" onClick={() => setRequesting(true)}>
            Be LAFT om tilgang
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy} disabled={!canSubmit}>
            {company?.access === "kommune" ? "Send til godkjenning" : "Hent dokumentene"}
            <ArrowRight className="size-4" />
          </Button>
        )}
        {me.data && me.data.orgs.length > 0 && (
          <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => navigate(`/o/${me.data!.orgs[0]!.id}`)}>
            Avbryt
          </Button>
        )}
      </form>
    </AuthFrame>
  );
}

export function WaitingPage() {
  const brand = useBrand();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signup = useQuery({
    queryKey: ["signup"],
    queryFn: async () => {
      const row = await api<SignupRow | null>("/me/signup");
      // Godkjent: organisasjonen finnes nå, så «me» må hentes på nytt før siden bytter.
      if (!row || row.status !== "queued") await qc.invalidateQueries({ queryKey: ["me"] });
      return row;
    },
    refetchInterval: 30_000,
  });

  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  if (me.data.orgs.length > 0) return <Navigate to={`/velkommen/${me.data.orgs[0]!.id}`} replace />;
  if (signup.isLoading) return <Loading />;
  if (!signup.data || signup.data.status !== "queued") return <Navigate to="/onboarding" replace />;
  const name = signup.data.org_name || signup.data.org_nr;

  return (
    <AuthFrame>
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Venter på godkjenning</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          {signup.data.kind === "access" ? (
            <>
              Forespørselen om tilgang til <b>{name}</b> ligger hos LAFT. Når den er godkjent, får du en e-post, og byggene og dokumentene hentes fra
              Boligmappa inn i {brand.name}. Du kan la denne siden stå åpen.
            </>
          ) : (
            <>
              <b>{name}</b> er en kommune. Forespørselen ligger hos LAFT i Boligmappa-admin. Når den er godkjent, overføres dere til kommune-løsningen.{" "}
              {brand.name} er ikke neste steg for kommuner.
            </>
          )}
        </p>
        <p className="mt-4 text-[13.5px] text-muted">Org.nr {formatOrgNr(signup.data.org_nr)}</p>
        <Button variant="ghost" className="mt-6 -ml-3" onClick={() => navigate("/login")}>
          Tilbake
        </Button>
      </div>
    </AuthFrame>
  );
}

export function RootRedirect() {
  const me = useMe();
  const signup = useQuery({
    queryKey: ["signup"],
    queryFn: () => api<SignupRow | null>("/me/signup"),
    enabled: Boolean(me.data && me.data.orgs.length === 0),
  });
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  if (me.data.orgs.length === 0) {
    if (signup.isLoading) return <Loading />;
    if (signup.data?.status === "queued") return <Navigate to="/venter" replace />;
    return <Navigate to="/onboarding" replace />;
  }
  let last: string | null = null;
  try {
    last = localStorage.getItem("plank-last-org");
  } catch {
    /* ignorer */
  }
  const org = me.data.orgs.find((o) => o.id === last) ?? me.data.orgs[0]!;
  return <Navigate to={`/o/${org.id}`} replace />;
}
