import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Bot, Check } from "lucide-react";
import type { Component, Document, Task } from "@shared/types";
import { useOrg, useOrgApi } from "@/lib/app";
import { formatBytes, formatDate } from "@/lib/format";
import { ConditionBadge, DocKindBadge, DocStatus, DueDate, fileIcon, PriorityBadge, ServiceBadge, TaskTypeBadge } from "./domain";
import { cn, useToast } from "./ui";

const th = "px-3 py-2 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase whitespace-nowrap";
const td = "px-3 py-2.5 align-middle";

export function TableShell({ children, head }: { children: React.ReactNode; head: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full min-w-[640px] border-collapse text-[13.5px]">
        <thead className="border-b border-line bg-panel-2/40">{head}</thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

// ─── Oppgaver ────────────────────────────────────────────────────────────────

export function TaskTable({ tasks, onOpen, showBuilding = true }: { tasks: Task[]; onOpen: (t: Task) => void; showBuilding?: boolean }) {
  const call = useOrgApi();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const complete = async (t: Task) => {
    setBusy(t.id);
    try {
      await call(`/tasks/${t.id}`, { method: "PATCH", body: { status: t.status === "done" ? "open" : "done" } });
      if (t.status !== "done") toast("Oppgaven er markert som utført", "ok");
    } finally {
      setBusy(null);
    }
  };
  return (
    <TableShell
      head={
        <tr>
          <th className={cn(th, "w-10")} />
          <th className={th}>Oppgave</th>
          <th className={th}>Type</th>
          {showBuilding && <th className={th}>Bygg</th>}
          <th className={th}>Frist</th>
        </tr>
      }
    >
      {tasks.map((t) => {
        const done = t.status === "done" || t.status === "cancelled";
        return (
          <tr key={t.id} className="cursor-pointer hover:bg-panel-2/50" onClick={() => onOpen(t)}>
            <td className={td} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => complete(t)}
                disabled={busy === t.id}
                aria-label={done ? "Gjenåpne" : "Marker som utført"}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border transition-colors",
                  done ? "border-ok bg-ok text-white" : "border-line-strong hover:border-ok hover:text-ok",
                  t.status === "in_progress" && "border-info",
                )}
              >
                {(done || busy === t.id) && <Check className="size-3" />}
              </button>
            </td>
            <td className={td}>
              <div className={cn("font-medium", done && "text-muted line-through")}>{t.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                {t.component_name && <span>{t.component_name}</span>}
                {t.agent_name && (
                  <span className="flex items-center gap-1">
                    <Bot className="size-3" />
                    {t.agent_name}
                  </span>
                )}
                {t.status === "in_progress" && <span className="text-info">Pågår</span>}
              </div>
            </td>
            <td className={td}>
              <div className="flex gap-1.5">
                <TaskTypeBadge type={t.type} />
                <PriorityBadge priority={t.priority} />
              </div>
            </td>
            {showBuilding && <td className={cn(td, "text-ink-2")}>{t.building_name ?? "–"}</td>}
            <td className={td}>
              <DueDate date={t.due_date} done={done} />
            </td>
          </tr>
        );
      })}
    </TableShell>
  );
}

// ─── Komponenter ─────────────────────────────────────────────────────────────

export function ComponentTable({ components, showLocation = true }: { components: Component[]; showLocation?: boolean }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  return (
    <TableShell
      head={
        <tr>
          <th className={th}>Komponent</th>
          <th className={th}>NS 3451</th>
          {showLocation && <th className={th}>Plassering</th>}
          <th className={th}>Tilstand</th>
          <th className={th}>Neste service</th>
        </tr>
      }
    >
      {components.map((c) => (
        <tr key={c.id} className="cursor-pointer hover:bg-panel-2/50" onClick={() => navigate(`/o/${orgId}/components/${c.id}`)}>
          <td className={td}>
            <div className="font-medium">{c.name}</div>
            <div className="text-[12px] text-muted">{[c.manufacturer, c.model].filter(Boolean).join(" · ") || c.category || "–"}</div>
          </td>
          <td className={cn(td, "font-mono text-[12.5px]")}>
            {c.ns3451 ?? "–"}
            {c.tfm && <div className="text-[11.5px] text-muted">{c.tfm}</div>}
          </td>
          {showLocation && <td className={cn(td, "text-ink-2")}>{[c.building_name, c.floor_name, c.room_name].filter(Boolean).join(" › ") || "–"}</td>}
          <td className={td}>
            <ConditionBadge condition={c.condition} />
          </td>
          <td className={td}>
            <ServiceBadge next={c.next_service_at} />
          </td>
        </tr>
      ))}
    </TableShell>
  );
}

// ─── Dokumenter ──────────────────────────────────────────────────────────────

export function DocumentTable({ documents, showLocation = true }: { documents: Document[]; showLocation?: boolean }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  return (
    <TableShell
      head={
        <tr>
          <th className={th}>Dokument</th>
          <th className={th}>Type</th>
          {showLocation && <th className={th}>Bygg</th>}
          <th className={th}>Status</th>
          <th className={th}>Lastet opp</th>
        </tr>
      }
    >
      {documents.map((d) => {
        const Icon = fileIcon(d.mime, d.filename);
        const href = d.kind === "ifc" ? `/o/${orgId}/models/${d.id}` : `/o/${orgId}/documents/${d.id}`;
        return (
          <tr key={d.id} className="cursor-pointer hover:bg-panel-2/50" onClick={() => navigate(href)}>
            <td className={td}>
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-muted">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <Link to={href} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {d.title}
                  </Link>
                  <div className="truncate text-[12px] text-muted">
                    {d.filename} · {formatBytes(d.size)}
                    {d.ns3451 && ` · NS ${d.ns3451}`}
                  </div>
                </div>
              </div>
            </td>
            <td className={td}>
              <DocKindBadge kind={d.kind} />
            </td>
            {showLocation && <td className={cn(td, "text-ink-2")}>{d.building_name ?? d.property_name ?? "–"}</td>}
            <td className={td}>
              <DocStatus status={d.status} error={d.error} />
            </td>
            <td className={cn(td, "text-ink-2 whitespace-nowrap")}>{formatDate(d.created_at)}</td>
          </tr>
        );
      })}
    </TableShell>
  );
}
