import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { PLANS, type Activation } from "@shared/types";
import { useAgentPanel, useOrg, useOrgQuery } from "@/lib/app";
import { Button, Modal } from "@/components/ui";

const GuideCtx = createContext<(() => void) | null>(null);

export function useOpenGuide(): () => void {
  return useContext(GuideCtx) ?? (() => undefined);
}

const ASK = "Når er neste service, og hva bør jeg gjøre først?";

interface Slide {
  title: string;
  body: string;
  example?: string;
  primary: string;
  kind: "next" | "close" | "boligmappa" | "ask" | "invite" | "pay";
  offerPay?: boolean;
}

function slides(a: Activation | undefined, isAdmin: boolean): Slide[] {
  const out: Slide[] = [
    {
      title: "Du er inne",
      body: "Plank holder orden på byggene. Du skriver med vanlige ord. Agenten finner dokumentet, servicen og det som må gjøres. Du trenger ikke vite hvor noe ligger.",
      primary: "Vis meg første steg",
      kind: "next",
    },
  ];
  if (isAdmin && (a == null || a.buildings === 0)) {
    out.push({
      title: "Hent byggene",
      body: "Hent fra Boligmappa med organisasjonsnummeret, eller logg inn med LAFT. Når lista kommer, huker du av byggene og tar dem med. Agentene kan lese det samme.",
      primary: "Gå til henting",
      kind: "boligmappa",
    });
  }
  out.push({
    title: "Spør med egne ord",
    body: "Skriv slik du ville spurt en kollega. Agenten leser dokumentene og svarer. Du kan starte med dette:",
    example: ASK,
    primary: "Spør dette nå",
    kind: "ask",
  });
  out.push({
    title: "Finn igjen det som er gjort",
    body: "Byggene ligger i menyen til venstre. Oppgaver er det som skal gjøres. Dokumenter er FDV-papirene. Agenten kan åpnes med knappen nede til høyre.",
    primary: isAdmin ? "Neste" : "Skjønner",
    kind: isAdmin ? "next" : "close",
  });
  if (isAdmin) {
    out.push({
      title: "Ta med en kollega",
      body: "Under Brukere og tilganger skriver du e-posten deres og velger hva de skal se – hele porteføljen eller bare noen bygg. De får en lenke på e-post og trenger ikke lage passord.",
      primary: "Gå til invitasjon",
      kind: "invite",
    });
  }
  if (isAdmin && a && a.billing !== "active") {
    out.push({
      title: "Betaling kan vente",
      body: `Bruk Plank først. Når du vil fortsette, velger du Standard til ${PLANS.standard.priceNok.toLocaleString("nb-NO")} kr/mnd med ${PLANS.standard.includedAiNok} kr AI-bruk inkludert, eller Pro til ${PLANS.pro.priceNok.toLocaleString("nb-NO")} kr/mnd med ${PLANS.pro.includedAiNok.toLocaleString("nb-NO")} kr. Prisene er inkl. mva.`,
      primary: "Fortsett å bruke Plank",
      kind: "close",
      offerPay: true,
    });
  }
  return out;
}

export function StartGuideProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openGuide = useCallback(() => setOpen(true), []);
  return (
    <GuideCtx.Provider value={openGuide}>
      {children}
      <StartGuideDialog open={open} onOpen={openGuide} onClose={() => setOpen(false)} />
    </GuideCtx.Provider>
  );
}

function StartGuideDialog({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const { orgId, isAdmin } = useOrg();
  const activation = useOrgQuery<Activation>("/activation");
  const [params, setParams] = useSearchParams();
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const panel = useAgentPanel();
  const decided = useRef(false);
  const key = `plank-guide-${orgId}`;

  const list = slides(activation.data, isAdmin);
  const slide = list[Math.min(index, list.length - 1)]!;

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  useEffect(() => {
    if (decided.current) return;
    if (params.get("welcome") === "1") {
      decided.current = true;
      params.delete("welcome");
      setParams(params, { replace: true });
      onOpen();
      return;
    }
    if (params.get("billing")) {
      decided.current = true;
      return;
    }
    if (!activation.isSuccess && !activation.isError) return;
    decided.current = true;
    let seen = false;
    try {
      seen = localStorage.getItem(key) === "1";
    } catch {
      /* ignorer */
    }
    if (!seen) onOpen();
  }, [activation.isSuccess, activation.isError, key, onOpen, params, setParams]);

  const finish = () => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* ignorer */
    }
    onClose();
  };

  const pay = () => {
    finish();
    navigate(`/o/${orgId}/abonnement#planer`);
  };

  const go = async () => {
    if (slide.kind === "next") {
      setIndex((i) => Math.min(i + 1, list.length - 1));
      return;
    }
    if (slide.kind === "boligmappa") {
      finish();
      navigate(`/o/${orgId}/boligmappa`);
      return;
    }
    if (slide.kind === "ask") {
      finish();
      panel.ask(ASK, { newConversation: true });
      return;
    }
    if (slide.kind === "invite") {
      finish();
      navigate(`/o/${orgId}/tilganger`);
      return;
    }
    if (slide.kind === "pay") {
      pay();
      return;
    }
    finish();
  };

  return (
    <Modal
      open={open}
      onClose={finish}
      title="Kom i gang"
      size="md"
      footer={
        <>
          {index > 0 && (
            <Button variant="ghost" onClick={() => setIndex((i) => i - 1)}>
              Tilbake
            </Button>
          )}
          <div className="flex-1" />
          {slide.offerPay && (
            <Button variant="ghost" onClick={pay}>
              Velg plan
            </Button>
          )}
          <Button variant="primary" onClick={() => void go()}>
            {slide.primary}
          </Button>
        </>
      }
    >
      <p className="text-[12px] text-muted">
        Steg {Math.min(index, list.length - 1) + 1} av {list.length}
      </p>
      <h3 className="mt-2 text-[22px] font-semibold tracking-tight">{slide.title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{slide.body}</p>
      {slide.example && <p className="mt-4 rounded-xl bg-panel-2 px-4 py-3 text-[15px]">«{slide.example}»</p>}
    </Modal>
  );
}
