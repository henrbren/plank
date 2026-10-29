import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowUpRight, CircleHelp, Search, Sparkles } from "lucide-react";
import type { HelpDetail, HelpIndex } from "@shared/types";
import { useAgentPanel, useOrg, useOrgQuery } from "@/lib/app";
import { renderMarkdown } from "@/lib/markdown";
import { Button, ButtonLink, EmptyState, Input, Loading, PageHeader } from "@/components/ui";

export function HelpPage() {
  const { orgId } = useOrg();
  const panel = useAgentPanel();
  const [q, setQ] = useState("");
  const help = useOrgQuery<HelpIndex>("/help", {
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.can_view_shots) return false;
      return data.articles.some((article) => !article.has_shot) ? 15_000 : false;
    },
  });

  const ask = (text: string) => panel.ask(text, { agentId: help.data?.agent_id ?? undefined, newConversation: true });
  const needle = q.trim().toLowerCase();
  const articles = useMemo(() => {
    const rows = help.data?.articles ?? [];
    if (!needle) return rows;
    return rows.filter((article) => `${article.title} ${article.summary} ${article.category}`.toLowerCase().includes(needle));
  }, [help.data, needle]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof articles>();
    for (const article of articles) {
      const list = map.get(article.category) ?? [];
      list.push(article);
      map.set(article.category, list);
    }
    return [...map.entries()];
  }, [articles]);

  if (help.isLoading) return <Loading />;
  if (help.isError || !help.data) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
        <EmptyState icon={<CircleHelp className="size-5" />} title="Kunne ikke hente hjelpen" description="Prøv å laste siden på nytt." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <PageHeader
        icon={<CircleHelp className="size-5" />}
        title="Hjelp"
        subtitle="Forklaringer som oppdateres når sidene endrer seg."
        actions={
          <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => ask("Jeg trenger hjelp til å bruke Plank.")}>
            Spør Hjelp
          </Button>
        }
      />
      <div className="relative mb-6 max-w-md">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <Input className="pl-9" placeholder="Søk i hjelpen …" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title={needle ? `Ingen treff på «${q.trim()}»` : "Ingen artikler ennå"}
          description="Hjelp-agenten kan åpne sidene og svare ut fra det som faktisk vises."
          action={
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => ask(needle ? `Jeg finner ikke hjelp om «${q.trim()}». Kan du forklare det?` : "Jeg trenger hjelp til å bruke Plank.")}>
              Spør Hjelp
            </Button>
          }
        />
      ) : (
        groups.map(([category, items]) => (
          <section key={category} className="mb-6">
            <h2 className="mb-2 text-[13px] font-semibold text-ink-2">{category}</h2>
            <div className="grid gap-3 @xl:grid-cols-2">
              {items.map((article) => (
                <Link key={article.slug} to={`/o/${orgId}/hjelp/${article.slug}`} className="rounded-xl border border-line bg-panel p-4 hover:bg-panel-2">
                  <div className="text-[15px] font-semibold">{article.title}</div>
                  <p className="mt-1 text-[13px] leading-snug text-muted">{article.summary}</p>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export function HelpArticlePage() {
  const { orgId } = useOrg();
  const { slug } = useParams();
  const panel = useAgentPanel();
  const detail = useOrgQuery<HelpDetail>(slug ? `/help/${slug}` : null, {
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.can_view_shots || data.article.has_shot) return false;
      return 15_000;
    },
  });

  if (detail.isLoading) return <Loading />;
  if (detail.isError || !detail.data) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
        <EmptyState
          icon={<CircleHelp className="size-5" />}
          title="Artikkelen finnes ikke"
          description="Den kan ha blitt fjernet, eller lenken er feil."
          action={
            <ButtonLink to={`/o/${orgId}/hjelp`} variant="primary">
              Tilbake til hjelp
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const { article, can_view_shots: canViewShots, agent_id: agentId } = detail.data;
  const href = articleHref(orgId, article.route);
  const ask = () =>
    panel.ask(`Forklar hvordan jeg bruker «${article.title}» i Plank. Hold deg til det som faktisk finnes på siden.`, {
      agentId: agentId ?? undefined,
      newConversation: true,
    });

  return (
    <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "Hjelp", to: `/o/${orgId}/hjelp` }]}
        title={article.title}
        subtitle={article.summary}
        actions={
          <>
            {href && (
              <ButtonLink to={href} icon={<ArrowUpRight className="size-4" />}>
                Åpne siden
              </ButtonLink>
            )}
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={ask}>
              Spør om dette
            </Button>
          </>
        }
      />
      {canViewShots && article.has_shot && (
        <img
          src={`/api/orgs/${orgId}/help/shots/${article.slug}?v=${article.updated_at}`}
          alt={`Skjermbilde av ${article.title}`}
          className="mb-6 w-full rounded-xl border border-line bg-panel-2"
        />
      )}
      {canViewShots && !article.has_shot && <p className="mb-6 text-[13px] text-muted">Skjermbildet kommer automatisk.</p>}
      <div className="prose-plank text-[14.5px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(article.body) }} />
    </div>
  );
}

function articleHref(orgId: string, route: string): string | null {
  if (!route) return null;
  if (route === "/") return `/o/${orgId}`;
  return `/o/${orgId}${route.startsWith("/") ? route : `/${route}`}`;
}
