import {
  Bot,
  Box,
  Building2,
  CircleCheck,
  DoorOpen,
  FileCheck,
  FileText,
  Layers,
  LayoutDashboard,
  ListChecks,
  MapPin,
  Sparkles,
  SquareCheck,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { DOCUMENT_KINDS, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, type DocumentKind, type DocumentStatus, type TaskPriority, type TaskStatus, type TaskType } from "@shared/types";
import { daysUntil, formatDate } from "@/lib/format";
import { Badge, cn } from "./ui";

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-ink" />
        <rect x="7" y="8" width="18" height="4" rx="1.5" fill="var(--accent)" />
        <rect x="7" y="14" width="14" height="4" rx="1.5" className="fill-bg" />
        <rect x="7" y="20" width="18" height="4" rx="1.5" className="fill-bg" opacity=".55" />
      </svg>
      {withText && <span className="text-[15px] font-semibold tracking-[-0.02em]">Plank</span>}
    </span>
  );
}

// ─── Agenter ─────────────────────────────────────────────────────────────────

export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  sparkles: Sparkles,
  "file-check": FileCheck,
  wrench: Wrench,
  "triangle-alert": TriangleAlert,
  "layout-dashboard": LayoutDashboard,
  box: Box,
  "list-checks": ListChecks,
  building: Building2,
};

export const AGENT_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  wood: { bg: "#f3e3d3", fg: "#8a4a1c", label: "Treverk" },
  moss: { bg: "#dfeadc", fg: "#3d6b3a", label: "Mose" },
  slate: { bg: "#dde4ea", fg: "#3b5266", label: "Skifer" },
  rust: { bg: "#f4dcd4", fg: "#9a3d26", label: "Rust" },
  ink: { bg: "#e4e1dc", fg: "#2c2925", label: "Blekk" },
  sky: { bg: "#d9e8f3", fg: "#2b6187", label: "Himmel" },
};

export function AgentAvatar({ icon, color, size = "md" }: { icon?: string | null; color?: string | null; size?: "sm" | "md" | "lg" }) {
  const Icon = AGENT_ICONS[icon ?? "bot"] ?? Bot;
  const c = AGENT_COLORS[color ?? "wood"] ?? AGENT_COLORS.wood!;
  const dim = { sm: "size-6 rounded-md", md: "size-8 rounded-lg", lg: "size-11 rounded-xl" }[size];
  const ic = { sm: "size-3.5", md: "size-4", lg: "size-5.5" }[size];
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", dim)} style={{ background: c.bg, color: c.fg }}>
      <Icon className={ic} />
    </span>
  );
}

// ─── Oppgaver ────────────────────────────────────────────────────────────────

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === "done" ? "ok" : status === "in_progress" ? "info" : status === "cancelled" ? "neutral" : "neutral";
  return (
    <Badge tone={tone} dot>
      {TASK_STATUSES[status]}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === "normal") return null;
  const tone = priority === "critical" ? "bad" : priority === "high" ? "warn" : "neutral";
  return <Badge tone={tone}>{TASK_PRIORITIES[priority]}</Badge>;
}

export function TaskTypeBadge({ type }: { type: TaskType }) {
  const tone = type === "avvik" ? "bad" : type === "kontroll" ? "info" : type === "dokumentasjon" ? "accent" : "neutral";
  return <Badge tone={tone}>{TASK_TYPES[type]}</Badge>;
}

export function DueDate({ date, done }: { date: string | null; done?: boolean }) {
  if (!date) return <span className="text-muted">–</span>;
  const d = daysUntil(date)!;
  const cls = done ? "text-muted" : d < 0 ? "text-bad font-medium" : d <= 7 ? "text-warn font-medium" : "text-ink-2";
  const rel = d === 0 ? "i dag" : d === 1 ? "i morgen" : d < 0 ? `${-d} d over` : d <= 30 ? `om ${d} d` : null;
  return (
    <span className={cn("tabular-nums", cls)} title={formatDate(date)}>
      {formatDate(date)}
      {rel && !done && <span className="ml-1 text-[12px] opacity-80">({rel})</span>}
    </span>
  );
}

// ─── Komponenter ─────────────────────────────────────────────────────────────

export function ConditionBadge({ condition }: { condition: string | null }) {
  if (!condition) return <span className="text-muted">–</span>;
  const tone = condition === "TG3" ? "bad" : condition === "TG2" ? "warn" : condition === "TG1" ? "info" : condition === "TG0" ? "ok" : "neutral";
  return <Badge tone={tone}>{condition}</Badge>;
}

export function ServiceBadge({ next }: { next: string | null }) {
  if (!next) return <span className="text-muted">–</span>;
  const d = daysUntil(next)!;
  if (d < 0)
    return (
      <Badge tone="bad" dot>
        {-d} d over
      </Badge>
    );
  if (d <= 60)
    return (
      <Badge tone="warn" dot>
        Om {d} d
      </Badge>
    );
  return (
    <Badge tone="ok" dot>
      {formatDate(next)}
    </Badge>
  );
}

// ─── Dokumenter ──────────────────────────────────────────────────────────────

export function DocKindBadge({ kind }: { kind: DocumentKind }) {
  return <Badge>{DOCUMENT_KINDS[kind] ?? kind}</Badge>;
}

export function DocStatus({ status, error }: { status: DocumentStatus; error?: string | null }) {
  if (status === "processing")
    return (
      <Badge tone="info" className="animate-pulse">
        Behandles
      </Badge>
    );
  if (status === "error")
    return (
      <span title={error ?? ""}>
        <Badge tone="bad">Feil</Badge>
      </span>
    );
  if (status === "stored") return <Badge>Lagret</Badge>;
  return (
    <Badge tone="ok">
      <CircleCheck className="size-3" />
      Indeksert
    </Badge>
  );
}

export function fileIcon(mime: string, filename: string): LucideIcon {
  if (filename.toLowerCase().endsWith(".ifc")) return Box;
  if (mime.startsWith("image/")) return LayoutDashboard;
  return FileText;
}

// ─── Entiteter ───────────────────────────────────────────────────────────────

export const ENTITY_ICONS: Record<string, LucideIcon> = {
  property: MapPin,
  building: Building2,
  floor: Layers,
  room: DoorOpen,
  component: Wrench,
  task: SquareCheck,
  document: FileText,
  artifact: LayoutDashboard,
};

export const ENTITY_LABELS: Record<string, string> = {
  property: "Eiendom",
  building: "Bygg",
  floor: "Etasje",
  room: "Rom",
  component: "Komponent",
  task: "Oppgave",
  document: "Dokument",
  artifact: "Side",
};
