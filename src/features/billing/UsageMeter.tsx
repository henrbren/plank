import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PLANS, type BillingInfo } from "@shared/types";
import { useOrg, useOrgQuery } from "@/lib/app";
import { formatDate, formatOre } from "@/lib/format";
import { cn } from "@/components/ui";

/** Liten indikator nederst i sidebaren. Prosentbaren vises ved hover eller klikk. */
export function UsageMeter() {
  const { orgId } = useOrg();
  const billing = useOrgQuery<BillingInfo>("/billing");
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const usage = billing.data?.usage;

  useEffect(() => {
    if (!pinned) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  if (!usage) return null;

  const b = billing.data!;
  const paying = !b.managed && (b.status === "active" || b.status === "past_due");
  const used = paying || b.managed ? usage.billedOre : usage.trialOre;
  const pct = usage.includedOre > 0 ? Math.round((used / usage.includedOre) * 100) : 0;
  const over = Math.max(0, used - usage.includedOre);
  const bar = Math.min(100, pct);
  const tone = usage.paused ? "bad" : pct > 100 ? "warn" : "ok";

  return (
    <div
      ref={root}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-panel-2"
      >
        <span className="text-[12px] font-medium text-ink-2">AI-bruk</span>
        {usage.paused ? (
          <span className="ml-auto rounded-full bg-bad-soft px-1.5 text-[11.5px] font-medium text-bad">På pause</span>
        ) : (
          <span className={cn("ml-auto text-[12px] tabular-nums", tone === "warn" ? "text-warn" : "text-muted")}>{pct} %</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full left-0 z-20 mb-1 rounded-xl border border-line bg-panel p-3 shadow-pop">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12.5px] font-medium">Denne måneden</span>
            {paying && <span className="text-[11.5px] text-muted">{PLANS[b.plan].name}</span>}
          </div>
          <div className="mt-1 text-[20px] font-semibold tabular-nums tracking-tight">{pct} %</div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-panel-2">
            <div className={cn("h-full rounded-full", tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : "bg-accent")} style={{ width: `${bar}%` }} />
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
            {formatOre(used)} av {formatOre(usage.includedOre)} inkludert.
          </p>
          {usage.paused && <p className="mt-1 text-[12.5px] text-bad">Grensen for ekstra bruk er nådd. Agentene er satt på pause.</p>}
          {paying && !usage.paused && over > 0 && usage.extraOre > 0 && (
            <p className="mt-1 text-[12.5px] text-ink-2">
              {formatOre(usage.extraOre)} ekstra{usage.limitOre !== null ? ` av grensen på ${formatOre(usage.limitOre)}` : ""}.
            </p>
          )}
          {paying && over > 0 && usage.extraOre === 0 && <p className="mt-1 text-[12.5px] text-ink-2">Det som går over, trekkes fra kredittene.</p>}
          {usage.creditOre > 0 && (
            <p className="mt-1 text-[12.5px] text-ink-2">
              Kreditter: {formatOre(usage.creditOre)} igjen
              {usage.creditExpiresAt ? `, til ${formatDate(usage.creditExpiresAt)}` : ""}.
            </p>
          )}
          {!paying && !b.managed && <p className="mt-1 text-[12.5px] text-muted">Prøvebruk faktureres ikke.</p>}
          {b.managed && <p className="mt-1 text-[12.5px] text-muted">AI-bruk på denne kontoen faktureres ikke.</p>}
          <Link to={`/o/${orgId}/abonnement`} className="mt-2 inline-block text-[12.5px] text-ink underline">
            {usage.paused ? "Hev grensen" : "Abonnement og bruk"}
          </Link>
        </div>
      )}
    </div>
  );
}
