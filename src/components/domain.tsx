import { Box, Building2, CircleCheck, DoorOpen, FileText, Layers, LayoutDashboard, MapPin, SquareCheck, Wrench, type LucideIcon } from "lucide-react";
import { DOCUMENT_KINDS, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES, type DocumentKind, type DocumentStatus, type TaskPriority, type TaskStatus, type TaskType } from "@shared/types";
import { daysUntil, formatDate } from "@/lib/format";
import { useBrand } from "@/lib/brand";
import { Badge, cn } from "./ui";

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  const brand = useBrand();
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {brand.logo ? (
        <img src={brand.logo} alt="" className="size-6 object-contain" />
      ) : (
        <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
          <rect width="32" height="32" rx="7" className="fill-ink" />
          <rect x="7" y="8" width="18" height="4" rx="1.5" fill="var(--accent)" />
          <rect x="7" y="14" width="14" height="4" rx="1.5" className="fill-bg" />
          <rect x="7" y="20" width="18" height="4" rx="1.5" className="fill-bg" opacity=".55" />
        </svg>
      )}
      {withText && <span className="text-[15px] font-semibold tracking-[-0.02em]">{brand.name}</span>}
    </span>
  );
}

// ─── Agenter ─────────────────────────────────────────────────────────────────

/** Metta farger, som figurene i Grok Bot. `fg` er teksten når fargen brukes som bakgrunn. */
export const AGENT_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  wood: { bg: "#E0924A", fg: "#fff", label: "Tre" },
  moss: { bg: "#5E9A52", fg: "#fff", label: "Mose" },
  slate: { bg: "#5C7C99", fg: "#fff", label: "Skifer" },
  rust: { bg: "#D15A3A", fg: "#fff", label: "Rust" },
  ink: { bg: "#2C2926", fg: "#fff", label: "Blekk" },
  sky: { bg: "#3D7EBF", fg: "#fff", label: "Himmel" },
  amber: { bg: "#E0A825", fg: "#3a2a08", label: "Rav" },
  lilac: { bg: "#8B6FD4", fg: "#fff", label: "Syrin" },
  berry: { bg: "#C44B73", fg: "#fff", label: "Bær" },
  leaf: { bg: "#2F9B78", fg: "#fff", label: "Blad" },
};

export type AgentShape = "dot" | "square" | "sparkle" | "clover" | "flower" | "heart" | "house" | "star";

export const AGENT_SHAPES: { id: AgentShape; label: string }[] = [
  { id: "dot", label: "Prikken" },
  { id: "square", label: "Firkant" },
  { id: "sparkle", label: "Gnisten" },
  { id: "clover", label: "Kløver" },
  { id: "flower", label: "Blomst" },
  { id: "heart", label: "Hjerte" },
  { id: "house", label: "Hus" },
  { id: "star", label: "Stjerne" },
];

const LEGACY_SHAPE: Record<string, AgentShape> = {
  bot: "dot",
  sparkles: "sparkle",
  "file-check": "square",
  wrench: "clover",
  "triangle-alert": "star",
  "layout-dashboard": "square",
  box: "square",
  "list-checks": "clover",
  building: "house",
};

export function agentShape(icon?: string | null): AgentShape {
  if (AGENT_SHAPES.some((s) => s.id === icon)) return icon as AgentShape;
  return LEGACY_SHAPE[icon ?? ""] ?? "dot";
}

export function agentColor(color?: string | null) {
  return AGENT_COLORS[color ?? "wood"] ?? AGENT_COLORS.wood!;
}

function Eyes({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x - 4.1} cy={y} r="2.15" fill="#fff" />
      <circle cx={x + 4.1} cy={y} r="2.15" fill="#fff" />
      <circle cx={x - 3.35} cy={y + 0.35} r="1.05" fill="#1c1916" />
      <circle cx={x + 4.85} cy={y + 0.35} r="1.05" fill="#1c1916" />
    </g>
  );
}

function ShapePath({ shape, fill }: { shape: AgentShape; fill: string }) {
  if (shape === "dot") return <circle cx="16" cy="16" r="14" fill={fill} />;
  if (shape === "square") return <rect x="3" y="3" width="26" height="26" rx="7" fill={fill} />;
  if (shape === "sparkle") return <path fill={fill} d="M16 1.5c.6 6.2 2.4 9.6 8.5 10.5-6.1.9-7.9 4.3-8.5 10.5-.6-6.2-2.4-9.6-8.5-10.5C13.6 11.1 15.4 7.7 16 1.5z" />;
  if (shape === "clover")
    return (
      <g fill={fill}>
        <circle cx="16" cy="9" r="6.2" />
        <circle cx="9.2" cy="16.5" r="6.2" />
        <circle cx="22.8" cy="16.5" r="6.2" />
        <circle cx="16" cy="22.2" r="6.2" />
      </g>
    );
  if (shape === "flower")
    return (
      <g fill={fill}>
        <circle cx="16" cy="6.2" r="5" />
        <circle cx="24.6" cy="11" r="5" />
        <circle cx="24.6" cy="21" r="5" />
        <circle cx="16" cy="25.8" r="5" />
        <circle cx="7.4" cy="21" r="5" />
        <circle cx="7.4" cy="11" r="5" />
        <circle cx="16" cy="16" r="5.4" />
      </g>
    );
  if (shape === "heart") return <path fill={fill} d="M16 28C6 20.5 2 15.5 2 10.2 2 6.2 5 3.2 8.8 3.2c2.2 0 4.1 1.1 5.2 2.8 1.1-1.7 3-2.8 5.2-2.8 3.8 0 6.8 3 6.8 7 0 5.3-4 10.3-14 17.8z" />;
  if (shape === "house") return <path fill={fill} d="M16 2.5 2.5 14.2V29h10.2v-8.2h6.6V29H29.5V14.2z" />;
  return <path fill={fill} d="M16 1.8 19.8 11l9.7.6-7.5 6.2 2.4 9.4L16 22.4 7.6 27.2l2.4-9.4L2.5 11.6 12.2 11z" />;
}

const EYE: Record<AgentShape, { x: number; y: number }> = {
  dot: { x: 16, y: 15.5 },
  square: { x: 16, y: 16.5 },
  sparkle: { x: 16, y: 12.2 },
  clover: { x: 16, y: 15.5 },
  flower: { x: 16, y: 16 },
  heart: { x: 16, y: 13.2 },
  house: { x: 16, y: 18.5 },
  star: { x: 16, y: 14.2 },
};

/** Liten figur: form, farge og to øyne. Gamle ikonnavn tegnes som nærmeste form. */
export function AgentAvatar({ icon, color, size = "md" }: { icon?: string | null; color?: string | null; size?: "sm" | "md" | "lg" }) {
  const shape = agentShape(icon);
  const c = agentColor(color);
  const dim = { sm: "size-7", md: "size-9", lg: "size-12" }[size];
  const eye = EYE[shape];
  return (
    <span className={cn("inline-flex shrink-0", dim)} title={AGENT_SHAPES.find((s) => s.id === shape)?.label}>
      <svg viewBox="0 0 32 32" className="size-full" aria-hidden>
        <ShapePath shape={shape} fill={c.bg} />
        <Eyes x={eye.x} y={eye.y} />
      </svg>
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
