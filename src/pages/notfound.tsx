import { EmptyState, ButtonLink } from "@/components/ui";
import { useOrg } from "@/lib/app";

export function NotFound() {
  const { orgId } = useOrg();
  return (
    <div className="p-8">
      <EmptyState title="Fant ikke siden" description="Lenken kan være feil, eller innholdet er slettet." action={<ButtonLink to={`/o/${orgId}`}>Til oversikten</ButtonLink>} />
    </div>
  );
}
