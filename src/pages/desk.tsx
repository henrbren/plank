import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Building2, ClipboardList, Copy, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { LeaseCreateModal, LeaseEditModal, LeasePlaceList, useRemoveLease } from "@/features/desk/edit";
import type { DeskAct, DeskCase, DeskHome, DeskRow, DeskTall, OrgOverview } from "@shared/types";
import { useAgentPanel, useOrg, useOrgApi, useOrgQuery, useSetFocus } from "@/lib/app";
import { Journey } from "@/features/onboarding/NextStep";
import { Badge, Button, ButtonLink, Card, EmptyState, ErrorState, IconButton, KeyValues, Loading, PageHeader, cn, useToast, type Tone } from "@/components/ui";

const TALL = new Set<string>(["ledig", "utlop", "wault", "gap", "restanse", "fart", "ko"]);

function laneTone(lane: string): Tone {
  if (lane === "restanse") return "bad";
  if (lane === "utflytting" || lane === "signering" || lane === "vedtak" || lane === "regulering" || lane === "opsjon") return "warn";
  if (lane === "ledig" || lane === "tilbud") return "info";
  return "neutral";
}

function kindLabel(kind: DeskRow["kind"]) {
  return kind === "bolig" ? "Bolig" : "Næring";
}

export function DeskPage() {
  const { orgId, me, isAdmin, canEdit } = useOrg();
  const panel = useAgentPanel();
  const call = useOrgApi();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [seeding, setSeeding] = useState(false);
  const [add, setAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const desk = useOrgQuery<DeskHome>("/desk");
  const overview = useOrgQuery<OrgOverview>(desk.data?.empty ? "/overview" : null);
  useSetFocus("org", undefined, "pulten");

  if (desk.isLoading || (desk.data?.empty && overview.isLoading)) return <Loading />;
  if (desk.error || !desk.data) return <ErrorState error={desk.error} />;

  const data = desk.data;
  const asked = params.get("tall");
  const tall: DeskTall | null = asked && TALL.has(asked) ? (asked as DeskTall) : null;
  const rows = tall ? data.rows.filter((r) => r.tall.includes(tall)) : data.rows.filter((r) => r.lane !== "gap");
  const active = data.kpis.find((k) => k.id === tall);
  const firstName = me.user.name?.split(" ")[0];
  const hour = new Date().getHours();
  const greeting = hour < 10 ? "God morgen" : hour < 17 ? "Hei" : "God kveld";
  const buildings = overview.data?.counts.buildings ?? 0;

  const setTall = (id: DeskTall) => {
    const next = new URLSearchParams(params);
    if (tall === id) next.delete("tall");
    else next.set("tall", id);
    setParams(next, { replace: true });
  };

  const seedDemo = async () => {
    setSeeding(true);
    try {
      await call("/demo", { method: "POST" });
      toast("Demodata er lastet inn", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Feil", "bad");
    } finally {
      setSeeding(false);
    }
  };

  const seedDesk = async () => {
    setSeeding(true);
    try {
      await call("/desk/seed", { method: "POST", body: {} });
      toast("Utleieeksempelet er inne", "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Feil", "bad");
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        title={`${greeting}${firstName ? `, ${firstName}` : ""}`}
        subtitle="Bolig og næring i samme kø. Sortert på frist, så på beløp."
        actions={
          <>
            {canEdit && (
              <Button icon={<Plus className="size-4" />} onClick={() => setAdd(true)}>
                Legg til
              </Button>
            )}
            {!data.empty && (
              <Button
                variant="primary"
                icon={<Sparkles className="size-4" />}
                onClick={() => panel.ask("Hva bør jeg ta først på utleiepulten i dag? Bolig og næring ligger i samme kø. Bruk desk_today. Ikke finn på tall.", { newConversation: true })}
              >
                Hva tar jeg først?
              </Button>
            )}
          </>
        }
      />

      {data.empty && buildings === 0 && <Journey onDemo={isAdmin ? seedDemo : undefined} seeding={seeding} />}

      {data.empty && buildings > 0 && (
        <EmptyState
          icon={<ClipboardList className="size-5" />}
          title="Ingen leieforhold ennå"
          description="Last inn et eksempel med boliger og næringslokaler. Køen, tallene og neste handling kommer med."
          action={
            isAdmin && (
              <Button variant="primary" loading={seeding} onClick={() => void seedDesk()}>
                Vis utleieeksempel
              </Button>
            )
          }
        />
      )}

      {data.empty && buildings === 0 && isAdmin && (
        <p className="text-[13px] text-muted">
          <button type="button" className="hover:text-ink disabled:opacity-60" disabled={seeding} onClick={() => void seedDesk()}>
            {seeding ? "Laster …" : "Eller bare utleieeksempelet, uten FDV-demoen"}
          </button>
        </p>
      )}

      {!data.empty && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 @xl:grid-cols-4">
            {data.kpis.map((k) => {
              const on = tall === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTall(k.id)}
                  className={cn(
                    "rounded-xl border bg-panel p-3 text-left transition-colors hover:bg-panel-2/50",
                    on ? "border-ink" : "border-line hover:border-line-strong",
                  )}
                >
                  <div className="text-[12.5px] text-muted">{k.label}</div>
                  <div className={cn("mt-1 text-[22px] leading-none font-semibold tracking-tight tabular-nums", k.tone === "bad" && "text-bad", k.tone === "warn" && "text-warn")}>{k.value}</div>
                  <div className="mt-1.5 text-[12px] text-muted">{k.hint}</div>
                </button>
              );
            })}
          </div>

          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-[13.5px] font-semibold">
              {rows.length === 1 ? "1 sak" : `${rows.length} saker`}
              {active ? ` i ${active.label.toLowerCase()}` : ""}
            </h2>
            {tall && (
              <button type="button" className="text-[12.5px] text-muted hover:text-ink" onClick={() => setTall(tall)}>
                Vis hele køen
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="text-[13.5px] text-muted">Ingen saker i dette tallet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row) => (
                <Row key={row.id} row={row} to={`/o/${orgId}/pult/${row.id}${tall ? `?fra=${tall}` : ""}`} onEdit={canEdit ? () => setEditId(row.id) : undefined} />
              ))}
            </div>
          )}
          {(data.aside ?? []).length > 0 && (
            <div className="mt-8">
              <h2 className="mb-1 text-[13.5px] font-semibold">Uten frist</h2>
              <p className="mb-2 text-[12.5px] text-muted">Disse har ingen frist, så de ligger ikke i køen.</p>
              <LeasePlaceList places={data.aside} canEdit={canEdit} />
            </div>
          )}
        </>
      )}
      <LeaseCreateModal open={add} onClose={() => setAdd(false)} />
      <LeaseEditModal open={editId != null} target={editId ? { caseId: editId } : null} onClose={() => setEditId(null)} />
    </div>
  );
}

function Row({ row, to, onEdit }: { row: DeskRow; to: string; onEdit?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-panel px-4 py-3 transition-colors hover:border-line-strong hover:bg-panel-2/40">
      <Link to={to} className="flex min-w-0 flex-1 flex-col gap-2 @md:flex-row @md:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-muted">{kindLabel(row.kind)}</span>
            <Badge tone={laneTone(row.lane)}>{row.laneLabel}</Badge>
            {row.dueSoon && <Badge tone="warn">Nå</Badge>}
          </div>
          <div className="mt-1 truncate text-[14.5px] font-medium">{row.title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-muted">{row.place}</div>
        </div>
        <div className="@md:w-44 @md:shrink-0 @md:text-right">
          <div className="text-[14px] font-medium tabular-nums">{row.moneyText}</div>
          <div className="mt-0.5 text-[12.5px] text-muted">{row.when}</div>
          <div className="mt-1 text-[12.5px] text-ink-2">{row.actionLabel}</div>
        </div>
      </Link>
      {onEdit && (
        <IconButton label="Rediger" onClick={onEdit}>
          <Pencil className="size-4" />
        </IconButton>
      )}
    </div>
  );
}

export function DeskCasePage() {
  const { orgId, caseId, canEdit } = useCaseParams();
  const navigate = useNavigate();
  const panel = useAgentPanel();
  const qc = useQueryClient();
  const call = useOrgApi();
  const toast = useToast();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const { remove, dialog } = useRemoveLease();
  const q = useOrgQuery<DeskCase>(caseId ? `/desk/cases/${encodeURIComponent(caseId)}` : null);
  useSetFocus("org", undefined, q.data ? `saken «${q.data.title}» (${q.data.id}) på pulten` : "pulten");

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const item = q.data;
  const fra = params.get("fra");
  const back = fra && TALL.has(fra) ? `/o/${orgId}/pult?tall=${fra}` : `/o/${orgId}/pult`;

  const run = async (extra: { unit_id?: string; lease_id?: string } = {}, key = "go") => {
    if (!caseId || busy) return;
    setBusy(key);
    try {
      const res = await call<DeskAct>(`/desk/cases/${encodeURIComponent(caseId)}`, { method: "POST", body: extra }, false);
      const nextPath = `/desk/cases/${encodeURIComponent(res.item.id)}`;
      qc.setQueryData(["org", orgId, nextPath], res.item);
      toast(res.notice, "ok");
      if (res.item.id !== caseId) {
        const fra = params.get("fra");
        navigate(`/o/${orgId}/pult/${res.item.id}${fra && TALL.has(fra) ? `?fra=${fra}` : ""}`, { replace: true });
      }
      void qc.invalidateQueries({
        queryKey: ["org", orgId],
        predicate: (query) => query.queryKey[2] !== `/desk/cases/${encodeURIComponent(caseId)}`,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Feil", "bad");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      toast("Brevet er kopiert", "ok");
    } catch {
      toast("Klarte ikke å kopiere", "bad");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "Pult", to: back }, { label: item.laneLabel }]}
        title={item.title}
        subtitle={item.place}
        actions={
          <>
            {canEdit && (
              <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>
                Rediger
              </Button>
            )}
            {canEdit && (
              <Button
                icon={<Trash2 className="size-4" />}
                onClick={() =>
                  void remove({ caseId: item.id, title: item.title }).then((gone) => {
                    if (gone) navigate(back);
                  })
                }
              >
                Fjern
              </Button>
            )}
            <Button
              icon={<Sparkles className="size-4" />}
              onClick={() =>
                panel.ask(
                  `Forklar saken ${item.id} på utleiepulten og gjør neste handling. Bruk desk_case og desk_act. Ikke finn på tall, og ikke send e-post.`,
                  { newConversation: true },
                )
              }
            >
              Be agenten ta den
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Badge>{kindLabel(item.kind)}</Badge>
        <Badge tone={laneTone(item.lane)}>{item.laneLabel}</Badge>
        {item.dueSoon && <Badge tone="warn">Nå</Badge>}
      </div>
      <p className="mb-6 max-w-2xl text-[14.5px] leading-relaxed">{item.why}</p>

      <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <Card>
            <KeyValues items={item.facts.map((f) => [f.label, f.value])} />
            {item.buildingId && (
              <ButtonLink to={`/o/${orgId}/buildings/${item.buildingId}`} size="sm" icon={<Building2 className="size-3.5" />} className="mt-4">
                Åpne bygget
              </ButtonLink>
            )}
            {item.taskId && (
              <ButtonLink to={`/o/${orgId}/tasks/${item.taskId}`} size="sm" className="mt-2">
                Åpne oppgaven
              </ButtonLink>
            )}
          </Card>

          {item.letters.map((letter) => (
            <Card key={letter.id}>
              <div className="mb-2 flex items-start justify-between gap-3">
                <h2 className="text-[14px] font-semibold">{letter.title}</h2>
                <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copy(letter.body)}>
                  Kopier
                </Button>
              </div>
              <pre className="font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{letter.body}</pre>
            </Card>
          ))}
        </div>

        <Card className="@3xl:sticky @3xl:top-4">
          <h2 className="text-[13.5px] font-semibold">Neste</h2>
          <p className="mt-1 mb-3 text-[13px] text-muted">{item.actionLabel}</p>
          {item.action === "offer" && (
            <ChoiceList
              empty="Ingen ledig bolig akkurat nå."
              items={item.offers.map((o) => ({
                key: o.unitId,
                title: o.name,
                sub: [o.place, o.rentText].filter(Boolean).join(" · "),
                fit: o.fit,
                run: () => void run({ unit_id: o.unitId }, o.unitId),
              }))}
              busy={busy}
              canEdit={canEdit}
            />
          )}
          {item.action === "match" && (
            <ChoiceList
              empty="Ingen venter med vedtak."
              items={item.matches.map((m) => ({
                key: m.leaseId,
                title: m.name,
                sub: [m.need, m.waited].filter(Boolean).join(" · "),
                fit: m.fit,
                run: () => void run({ lease_id: m.leaseId }, m.leaseId),
              }))}
              busy={busy}
              canEdit={canEdit}
            />
          )}
          {item.action !== "offer" && item.action !== "match" && (
            <Button variant="primary" className="w-full" loading={busy === "go"} disabled={!canEdit} onClick={() => void run({}, "go")}>
              {item.actionLabel}
            </Button>
          )}
        </Card>
      </div>
      <LeaseEditModal
        open={edit}
        target={caseId ? { caseId } : null}
        onClose={() => setEdit(false)}
        onSaved={(res) => {
          if (!res.item) {
            navigate(back);
            return;
          }
          if (res.item.id !== caseId) {
            const fra = params.get("fra");
            navigate(`/o/${orgId}/pult/${res.item.id}${fra && TALL.has(fra) ? `?fra=${fra}` : ""}`, { replace: true });
          }
        }}
      />
      {dialog}
    </div>
  );
}

function ChoiceList({
  items,
  empty,
  busy,
  canEdit,
}: {
  items: { key: string; title: string; sub: string; fit: boolean; run: () => void }[];
  empty: string;
  busy: string | null;
  canEdit: boolean;
}) {
  if (items.length === 0) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          disabled={!canEdit || busy != null}
          onClick={item.run}
          className="rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-panel-2 disabled:opacity-50"
        >
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-medium">{item.title}</span>
            {item.fit && <Badge tone="ok">Passer</Badge>}
          </div>
          {item.sub && <div className="mt-0.5 text-[12px] text-muted">{busy === item.key ? "Lagrer …" : item.sub}</div>}
        </button>
      ))}
    </div>
  );
}

function useCaseParams() {
  const { caseId } = useParams();
  const org = useOrg();
  return { ...org, caseId };
}
