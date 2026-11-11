import type { ReactNode } from "react";
import type { OrgModule, OrgOverview } from "@shared/types";
import { ORG_MODULE_LABEL } from "@shared/modules";
import { useAgentPanel, useOrg, useOrgQuery } from "@/lib/app";
import { useBrand } from "@/lib/brand";
import { Button, EmptyState, Loading } from "@/components/ui";

export function useLeaseModules() {
  const brand = useBrand();
  const overview = useOrgQuery<OrgOverview>("/overview");
  const lease = brand.id === "leie";
  const list = overview.data?.modules ?? [];
  const has = (module: OrgModule) => list.includes(module);
  return {
    lease,
    /** Leie har pulten alltid. Plank får den når utleie er satt opp. */
    utleie: lease || has("utleie"),
    utleiePending: !lease && overview.isLoading,
    /** På Leie venter vi på oversikten, så FDV ikke blinker fram før vi vet hva som er satt opp. */
    ready: !lease || overview.isSuccess,
    drift: !lease || has("drift"),
    kart: !lease || has("kart"),
    dokumenter: !lease || has("dokumenter"),
    komponenter: !lease || has("komponenter"),
    sider: !lease || has("sider"),
  };
}

/** Menypunkter. På Leie kommer de når modulen er på. På Plank når det finnes noe å vise. */
export function useNavFlags() {
  const mods = useLeaseModules();
  const overview = useOrgQuery<OrgOverview>("/overview");
  const counts = overview.data?.counts;
  const count = (n?: number) => (n ?? 0) > 0;
  const item = (on: boolean, n?: number) => (mods.lease ? mods.ready && on : on && count(n));
  return {
    lease: mods.lease,
    utleie: mods.utleie,
    tasks: count(counts?.tasks),
    drift: mods.lease ? mods.ready && mods.drift : true,
    kart: item(mods.kart, counts?.properties),
    dokumenter: item(mods.dokumenter, counts?.documents),
    komponenter: item(mods.komponenter, counts?.components),
    sider: item(mods.sider, counts?.artifacts),
    pinned: mods.lease ? mods.ready && mods.sider : true,
    sources: mods.lease ? mods.ready && mods.drift : true,
    mods,
  };
}

const ASK: Record<OrgModule, string> = {
  drift: "Sett opp drift.",
  kart: "Sett opp kart.",
  dokumenter: "Sett opp dokumenter.",
  komponenter: "Sett opp komponenter.",
  sider: "Sett opp sider.",
  utleie: "Sett opp utleie.",
};

/** På Leie vises FDV først når modulen er satt opp. På Plank vises utleie først da. */
export function ModuleGate({ module, children }: { module: OrgModule; children: ReactNode }) {
  const mods = useLeaseModules();
  const { canEdit } = useOrg();
  const panel = useAgentPanel();
  if (module === "utleie") {
    if (mods.utleie) return children;
    if (mods.utleiePending) return <Loading />;
  } else if (!mods.lease) {
    return children;
  } else if (!mods.ready) {
    return <Loading />;
  } else if (module === "drift" ? mods.drift : module === "kart" ? mods.kart : module === "dokumenter" ? mods.dokumenter : module === "komponenter" ? mods.komponenter : mods.sider) {
    return children;
  }
  const label = ORG_MODULE_LABEL[module];
  return (
    <div className="mx-auto max-w-lg px-5 py-16">
      <EmptyState
        title={`${label} er ikke satt opp`}
        description={canEdit ? "Be agenten sette det opp. Da kommer det i menyen." : "En administrator må be agenten sette det opp."}
        action={
          canEdit ? (
            <Button variant="primary" onClick={() => panel.ask(ASK[module], { newConversation: true })}>
              Be agenten sette opp
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
