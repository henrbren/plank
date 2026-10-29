import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Loading } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useBrand } from "@/lib/brand";
import { AuthFrame } from "@/pages/auth";

const WEB_STATE_RE = /wv1\.([a-f0-9]+)\.([a-f0-9]+)/;

export function VippsCallbackPage() {
  const brand = useBrand();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    if (oauthError) {
      setError(params.get("error_description") || "Vipps-innloggingen ble avbrutt.");
      return;
    }
    const match = state?.match(WEB_STATE_RE);
    if (!code || !match) {
      setError("Vipps-svaret manglet. Prøv å logge inn på nytt.");
      return;
    }
    api<{ needsOnboarding?: boolean; redirect?: string | null }>("/auth/vipps", {
      body: { code, codeVerifier: match[2], redirect: sessionStorage.getItem("plank-next") || undefined },
    })
      .then(async (res) => {
        await qc.invalidateQueries({ queryKey: ["me"] });
        if (res.needsOnboarding) navigate("/onboarding", { replace: true });
        else navigate(res.redirect || "/", { replace: true });
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Kunne ikke logge inn med Vipps"));
  }, [params, navigate, qc]);

  return (
    <AuthFrame>
      {error ? (
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Vipps-innloggingen feilet</h1>
          <p className="mt-2 text-[14px] text-ink-2">{error}</p>
          <Button variant="primary" className="mt-6" onClick={() => navigate("/login")}>
            Tilbake til {brand.name}
          </Button>
        </div>
      ) : (
        <Loading label="Logger inn med Vipps …" />
      )}
    </AuthFrame>
  );
}

