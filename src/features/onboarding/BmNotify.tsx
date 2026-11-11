import { Checkbox } from "@/components/ui";

export const BM_NOTIFY_LABEL = "Varsle meg når det kommer nye dokumenter";
export const BM_NOTIFY_HINT = "E-post når det senere kommer nye dokumenter. Den første e-posten, når overføringen er ferdig, sender vi uansett.";

export function BmNotifyChoice({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={BM_NOTIFY_LABEL} description={BM_NOTIFY_HINT} />;
}
