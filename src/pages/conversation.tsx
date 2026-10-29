import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { CalendarClock, MessageSquare } from "lucide-react";
import type { Conversation, StoredMessage } from "@shared/types";
import { useAgentPanel, useOrg, useOrgQuery, useSetFocus } from "@/lib/app";
import { formatDateTime } from "@/lib/format";
import { AgentAvatar } from "@/components/domain";
import { Button, ErrorState, Loading, PageHeader } from "@/components/ui";
import { AssistantTurn, toItems, UserBubble } from "@/features/chat/transcript";

/** Fullsidevisning av en samtale (brukes særlig for rapporter fra planlagte kjøringer) */
export function ConversationPage() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const navigate = useNavigate();
  const panel = useAgentPanel();
  const conv = useOrgQuery<Conversation & { messages: StoredMessage[] }>(`/conversations/${id}`);
  useSetFocus("org");

  // Vanlige chatter åpnes i panelet
  useEffect(() => {
    if (conv.data?.source === "chat") {
      panel.setConversationId(conv.data.id);
      panel.setOpen(true);
    }
  }, [conv.data, panel]);

  if (conv.isLoading) return <Loading />;
  if (conv.error) return <ErrorState error={conv.error} />;
  const c = conv.data!;
  const items = toItems(c.messages);
  return (
    <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
      <PageHeader
        crumbs={[{ label: "Agenter", to: `/o/${orgId}/agents` }, { label: c.agent_name ?? "Agent", to: `/o/${orgId}/agents/${c.agent_id}` }]}
        icon={<AgentAvatar icon={c.agent_icon} color={c.agent_color} />}
        title={c.title ?? "Samtale"}
        subtitle={
          <span className="flex items-center gap-1.5">
            {c.source === "schedule" ? <CalendarClock className="size-3.5" /> : <MessageSquare className="size-3.5" />}
            {c.source === "schedule" ? "Planlagt kjøring" : "Samtale"} · {formatDateTime(c.created_at)}
          </span>
        }
        actions={
          c.source === "schedule" ? (
            <Button variant="primary" onClick={() => panel.ask(`Jeg har lest rapporten fra «${c.title}». Kan du gå videre med de viktigste funnene?`, { agentId: c.agent_id, newConversation: true })}>
              Følg opp i chat
            </Button>
          ) : (
            <Button onClick={() => navigate(-1)}>Tilbake</Button>
          )
        }
      />
      <div className="flex flex-col gap-6 rounded-xl border border-line bg-panel p-5">
        {items.map((it) => (it.kind === "user" ? <UserBubble key={it.id} item={it} color={c.agent_color} /> : <AssistantTurn key={it.id} item={it} orgId={orgId} />))}
      </div>
    </div>
  );
}
