import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { LoaderCircle, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

// ─── Knapper ─────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-bg hover:bg-ink/85 border border-transparent",
  accent: "bg-accent text-accent-ink hover:bg-accent-hover border border-transparent",
  secondary: "bg-panel text-ink border border-line-strong hover:bg-panel-2 shadow-[0_1px_0_rgb(0_0_0/0.02)]",
  ghost: "bg-transparent text-ink-2 hover:bg-panel-2 hover:text-ink border border-transparent",
  danger: "bg-bad text-white hover:opacity-90 border border-transparent",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-8.5 px-3 text-[13.5px] gap-2 rounded-lg",
  lg: "h-10 px-4 text-[14.5px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md"; active?: boolean }>(
  function IconButton({ label, size = "md", active, className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40",
          size === "sm" ? "size-7" : "size-8",
          active && "bg-panel-2 text-ink",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export function ButtonLink({ to, variant = "secondary", size = "md", icon, children, className }: { to: string; variant?: Variant; size?: Size; icon?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn("inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors", variants[variant], sizes[size], className)}>
      {icon}
      {children}
    </Link>
  );
}

// ─── Skjema ──────────────────────────────────────────────────────────────────

const inputBase =
  "w-full rounded-lg border border-line-strong bg-panel px-3 text-[14px] text-ink placeholder:text-muted/80 transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputBase, "h-9", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputBase, "min-h-20 py-2 leading-relaxed", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(inputBase, "h-9 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8", className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  );
});
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23857d71' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="text-[12.5px] text-bad">{error}</span> : hint ? <span className="text-[12.5px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg p-2 hover:bg-panel-2", disabled && "cursor-not-allowed opacity-60")}>
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="text-[13.5px] font-medium">{label}</span>
        {description && <span className="text-[12.5px] text-muted">{description}</span>}
      </span>
    </label>
  );
}

// ─── Visning ─────────────────────────────────────────────────────────────────

type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-panel-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  bad: "bg-bad-soft text-bad border-transparent",
  info: "bg-info-soft text-info border-transparent",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-5.5 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium whitespace-nowrap", tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn("rounded-xl border border-line bg-panel", padded && "p-4", className)}>{children}</div>;
}

export function CardHeader({ title, action, icon }: { title: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
        {icon && <span className="text-muted">{icon}</span>}
        {title}
      </h3>
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("size-4 animate-spin text-muted", className)} />;
}

export function Loading({ label = "Laster …" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="m-6 rounded-xl border border-bad/30 bg-bad-soft p-4 text-[13.5px] text-bad">
      {error instanceof Error ? error.message : "Noe gikk galt"}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-panel-2 text-muted">{icon}</div>}
      <div className="text-[14.5px] font-semibold">{title}</div>
      {description && <div className="mt-1 max-w-md text-[13px] text-muted">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-panel-2", className)} />;
}

export function PageHeader({
  crumbs,
  title,
  subtitle,
  actions,
  icon,
}: {
  crumbs?: { label: string; to?: string }[];
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav className="mb-2 flex flex-wrap items-center gap-1 text-[12.5px] text-muted">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-line-strong">/</span>}
              {c.to ? (
                <Link to={c.to} className="hover:text-ink">
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon && <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-panel text-ink-2">{icon}</div>}
          <div className="min-w-0">
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
            {subtitle && <div className="mt-1 text-[13.5px] text-muted">{subtitle}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, to, tone }: { label: string; value: ReactNode; hint?: ReactNode; to?: string; tone?: "bad" | "warn" }) {
  const inner = (
    <>
      <div className="text-[12.5px] text-muted">{label}</div>
      <div className={cn("mt-1 text-[24px] leading-none font-semibold tracking-tight tabular-nums", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-muted">{hint}</div>}
    </>
  );
  const cls = "block rounded-xl border border-line bg-panel p-4 transition-colors";
  return to ? (
    <Link to={to} className={cn(cls, "hover:border-line-strong hover:bg-panel-2/50")}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors",
            value === t.value ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count != null && <span className="rounded-full bg-panel-2 px-1.5 text-[11.5px] text-muted tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cn("relative flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-panel shadow-pop sm:rounded-2xl", w)}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Lukk" size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ─── Meny ────────────────────────────────────────────────────────────────────

export function Menu({ trigger, children, align = "end", className }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "start" | "end"; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", fn);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", fn);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className={cn("relative", className)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div className={cn("absolute z-40 mt-1 min-w-52 rounded-xl border border-line bg-panel p-1 shadow-pop", align === "end" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, icon, children, danger, active }: { onClick?: () => void; icon?: ReactNode; children: ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors hover:bg-panel-2",
        danger ? "text-bad" : "text-ink",
        active && "bg-panel-2",
      )}
    >
      {icon && <span className="text-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "bad" | "neutral";
}
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                "pointer-events-auto rounded-xl border px-4 py-2.5 text-[13.5px] shadow-pop",
                t.tone === "bad" ? "border-bad/30 bg-bad-soft text-bad" : t.tone === "ok" ? "border-ok/30 bg-ok-soft text-ok" : "border-line bg-ink text-bg",
              )}
            >
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Bekreftelsesdialog som promise */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; message: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (opts: { title: string; message: ReactNode; confirm?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => setState({ confirm: "Bekreft", ...opts, resolve })),
    [],
  );
  const dialog = state ? (
    <Modal
      open
      size="sm"
      title={state.title}
      onClose={() => {
        state.resolve(false);
        setState(null);
      }}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              state.resolve(false);
              setState(null);
            }}
          >
            Avbryt
          </Button>
          <Button
            variant={state.danger ? "danger" : "primary"}
            onClick={() => {
              state.resolve(true);
              setState(null);
            }}
          >
            {state.confirm}
          </Button>
        </>
      }
    >
      <div className="text-[14px] text-ink-2">{state.message}</div>
    </Modal>
  ) : null;
  return { confirm, dialog };
}
