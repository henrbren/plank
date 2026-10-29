import { useRef, useState } from "react";
import { Building2, ImagePlus, MapPin } from "lucide-react";
import { useOrg, useOrgApi } from "@/lib/app";
import { Button, cn, useToast } from "@/components/ui";

type Kind = "properties" | "buildings";

export function placeImageUrl(orgId: string, kind: Kind, id: string, updatedAt: number) {
  return `/api/orgs/${orgId}/portfolio/${kind}/${id}/image?v=${updatedAt}`;
}

/** Samme utsnitt på kort, så husene kan sammenlignes. */
export function PlaceFrame({ kind, id, hasImage, updatedAt }: { kind: Kind; id: string; hasImage: boolean; updatedAt: number }) {
  const { orgId } = useOrg();
  if (!hasImage) {
    return (
      <div className="flex aspect-[16/10] items-center justify-center bg-panel-2 text-muted">
        {kind === "buildings" ? <Building2 className="size-6" /> : <MapPin className="size-6" />}
      </div>
    );
  }
  return <img src={placeImageUrl(orgId, kind, id, updatedAt)} alt="" className="aspect-[16/10] w-full object-cover" />;
}

/** Stort bilde øverst på eiendom og bygg, med samme ramme og utsnitt. */
export function PlaceCover({ kind, id, name, hasImage, updatedAt }: { kind: Kind; id: string; name: string; hasImage: boolean; updatedAt: number }) {
  const { orgId, canEdit } = useOrg();
  const call = useOrgApi();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const label = kind === "properties" ? "eiendommen" : "bygget";

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      await call(`/portfolio/${kind}/${id}/image`, { method: "POST", form });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke lagre bildet", "bad");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await call(`/portfolio/${kind}/${id}/image`, { method: "DELETE" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Kunne ikke fjerne bildet", "bad");
    } finally {
      setBusy(false);
    }
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="hidden"
      onChange={(e) => upload(e.target.files?.[0])}
    />
  );

  if (!hasImage) {
    if (!canEdit) return null;
    return (
      <div className="mb-6">
        {fileInput}
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="flex aspect-[2/1] w-full max-h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-panel-2 text-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
        >
          <ImagePlus className="size-5" />
          <span className="text-[13.5px] font-medium">{busy ? "Laster opp…" : `Legg til bilde av ${label}`}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="group relative mb-6 overflow-hidden rounded-2xl border border-line bg-panel-2">
      {fileInput}
      <img src={placeImageUrl(orgId, kind, id, updatedAt)} alt={name} className="aspect-[2/1] max-h-80 w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/25 via-transparent to-ink/10" />
      <div className={cn("absolute right-3 bottom-3 flex gap-2", !busy && "sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100", !canEdit && "hidden")}>
        <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Lagrer…" : "Bytt bilde"}
        </Button>
        <Button size="sm" variant="ghost" className="bg-panel/90" disabled={busy} onClick={remove}>
          Fjern
        </Button>
      </div>
    </div>
  );
}
