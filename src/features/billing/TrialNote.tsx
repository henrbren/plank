import type { ReactNode } from "react";
import { Link } from "react-router";
import { PLANS, type BillingInfo } from "@shared/types";
import { cn } from "@/components/ui";
import { useOrg, useOrgQuery } from "@/lib/app";

/** Sant når kontoen verken betaler eller har et avtalt abonnement. Plattformadmin ser Pro og får false. */
export function useOnTrial(): boolean {
  const billing = useOrgQuery<BillingInfo>("/billing");
  const b = billing.data;
  if (!b) return false;
  return !b.managed && b.status !== "active" && b.status !== "past_due";
}

export function PlanLink({ children }: { children: ReactNode }) {
  const { orgId } = useOrg();
  return (
    <Link to={`/o/${orgId}/abonnement`} className="text-ink underline decoration-line underline-offset-2">
      {children}
    </Link>
  );
}

/** Én rolig setning. Vises bare uten abonnement, og tar ikke over siden. */
export function TrialNote({ children, className }: { children: ReactNode; className?: string }) {
  const trial = useOnTrial();
  if (!trial) return null;
  return <p className={cn("mb-4 max-w-2xl text-[13px] leading-relaxed text-muted", className)}>{children}</p>;
}

const kr = (n: number) => `${n.toLocaleString("nb-NO")} kr`;

export function HomeTrialNote() {
  return (
    <TrialNote>
      Det som er lagt inn, blir liggende. Basis er {kr(PLANS.basis.priceNok)}/mnd med {kr(PLANS.basis.includedAiNok)} AI-bruk og {PLANS.basis.buildings} bygg. Standard er {kr(PLANS.standard.priceNok)}/mnd med {kr(PLANS.standard.includedAiNok)} og {PLANS.standard.buildings} bygg. Pro er {kr(PLANS.pro.priceNok)}/mnd med {kr(PLANS.pro.includedAiNok)} og {PLANS.pro.buildings} bygg, inkl. mva. <PlanLink>Se planene</PlanLink>
    </TrialNote>
  );
}
