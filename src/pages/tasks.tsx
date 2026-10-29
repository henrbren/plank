import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Plus, Search, SquareCheck } from "lucide-react";
import { TASK_TYPES, type Task, type TreeProperty } from "@shared/types";
import { useOrg, useOrgQuery, useSetFocus } from "@/lib/app";
import { Button, EmptyState, Input, Loading, PageHeader, Select } from "@/components/ui";
import { TaskTable } from "@/components/lists";
import { TaskFormModal } from "@/components/forms";

export function TasksPage() {
  const { id } = useParams();
  const { orgId, canEdit } = useOrg();
  const navigate = useNavigate();
  const [status, setStatus] = useState("open");
  const [type, setType] = useState("");
  const [building, setBuilding] = useState("");
  const [q, setQ] = useState("");
  const [create, setCreate] = useState(false);
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const params = new URLSearchParams({ status });
  if (type) params.set("type", type);
  if (building) params.set("building_id", building);
  if (q.trim()) params.set("q", q.trim());
  const tasks = useOrgQuery<Task[]>(`/tasks?${params}`, { placeholderData: (prev) => prev });
  const openTask = useOrgQuery<Task>(id ? `/tasks/${id}` : null);
  useSetFocus(id ? "task" : "org", id, openTask.data?.title);

  const counts = (tasks.data ?? []).reduce<Record<string, number>>((acc, t) => ((acc[t.type] = (acc[t.type] ?? 0) + 1), acc), {});

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<SquareCheck className="size-5" />}
        title="Oppgaver"
        subtitle="Vedlikehold, avvik, kontroller og dokumentasjonsmangler – fra brukere og agenter."
        actions={
          canEdit && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
              Ny oppgave
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="flex rounded-lg border border-line-strong bg-panel p-0.5">
          {[
            ["open", "Åpne"],
            ["done", "Utførte"],
            ["all", "Alle"],
          ].map(([v, l]) => (
            <button key={v} onClick={() => setStatus(v!)} className={`h-7.5 rounded-md px-3 text-[13px] font-medium ${status === v ? "bg-panel-3 text-ink" : "text-muted hover:text-ink"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="relative min-w-52 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Søk i oppgaver …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="w-auto min-w-40" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Alle typer</option>
          {Object.entries(TASK_TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v} {counts[k] && !type ? `(${counts[k]})` : ""}
            </option>
          ))}
        </Select>
        <Select className="w-auto min-w-40" value={building} onChange={(e) => setBuilding(e.target.value)}>
          <option value="">Alle bygg</option>
          {tree.data?.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
      {tasks.isLoading ? (
        <Loading />
      ) : tasks.data?.length ? (
        <TaskTable tasks={tasks.data} onOpen={(t) => navigate(`/o/${orgId}/tasks/${t.id}`)} />
      ) : (
        <EmptyState icon={<SquareCheck className="size-5" />} title={status === "open" ? "Ingen åpne oppgaver" : "Ingen oppgaver"} description="Opprett oppgaver selv, eller la agentene registrere avvik og vedlikehold." />
      )}
      <TaskFormModal open={create} onClose={() => setCreate(false)} />
      <TaskFormModal open={!!id && !!openTask.data} onClose={() => navigate(`/o/${orgId}/tasks`)} task={openTask.data} />
    </div>
  );
}
