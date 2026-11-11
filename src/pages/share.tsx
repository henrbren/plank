import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { SharedArtifact } from "@shared/types";
import { Logo } from "@/components/domain";
import { ErrorState, Loading } from "@/components/ui";
import { ArtifactFrame } from "@/features/artifacts/ArtifactFrame";
import { api } from "@/lib/api";

/** Delingslenke. Bare denne siden, uten resten av Plank, og uten mulighet til å endre. */
export function SharePage() {
  const { token } = useParams();
  const page = useQuery({
    queryKey: ["share", token],
    queryFn: () => api<SharedArtifact>(`/share/${encodeURIComponent(token ?? "")}`),
    enabled: Boolean(token),
    retry: false,
  });

  if (page.isLoading) return <Loading />;
  if (page.error || !page.data) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <ErrorState error={page.error ?? new Error("Lenken er ikke gyldig")} />
      </div>
    );
  }
  const shared = page.data;

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <Logo withText={false} />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{shared.title}</h1>
        <span className="shrink-0 text-[12px] text-muted">Bare lesing</span>
      </header>
      <div className="min-h-0 flex-1">
        <ArtifactFrame
          html={shared.html}
          artifactId={shared.artifactId}
          buildingId={shared.buildingId}
          propertyId={shared.propertyId}
          orgName={shared.orgName}
          shareToken={token}
        />
      </div>
    </div>
  );
}
