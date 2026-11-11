import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useOrg } from "@/lib/app";
import { Button, Modal } from "@/components/ui";
import { useNextAction, useRunStep } from "./NextStep";

const GuideCtx = createContext<(() => void) | null>(null);

export function useOpenGuide(): () => void {
  return useContext(GuideCtx) ?? (() => undefined);
}

export function StartGuideProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openGuide = useCallback(() => setOpen(true), []);
  return (
    <GuideCtx.Provider value={openGuide}>
      {children}
      <StartGuideDialog open={open} onClose={() => setOpen(false)} />
    </GuideCtx.Provider>
  );
}

/** Ett neste steg, bare når noen åpner «Kom i gang». Ingen omvisning ved innlogging. */
function StartGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const { step } = useNextAction();
  const { run, busy, modal } = useRunStep();
  const [params, setParams] = useSearchParams();
  const stripped = useRef(false);

  useEffect(() => {
    if (stripped.current || params.get("welcome") !== "1") return;
    stripped.current = true;
    params.delete("welcome");
    setParams(params, { replace: true });
  }, [params, setParams]);

  const finish = () => {
    try {
      localStorage.setItem(`plank-guide-${orgId}`, "1");
    } catch {
      /* ignorer */
    }
    onClose();
  };

  const actionable = step && step.kind !== "pay";

  return (
    <>
      <Modal
        open={open}
        onClose={finish}
        title="Kom i gang"
        size="md"
        footer={
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              finish();
              if (actionable) void run(step);
            }}
          >
            {actionable ? step.action : "Skjønner"}
          </Button>
        }
      >
        <h3 className="text-[22px] font-semibold tracking-tight">{actionable ? step.title : "Du er i gang"}</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          {actionable ? step.detail : "Byggene ligger til venstre. Spør agenten når du lurer på noe."}
        </p>
      </Modal>
      {modal}
    </>
  );
}
