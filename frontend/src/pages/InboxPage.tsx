import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { MessageSquare } from "lucide-react";
import { api } from "../lib/api";
import type { ConversationSummary, ConvStatus } from "../lib/types";
import { humanize, timeAgo } from "../lib/format";
import { Badge, ConvStatusBadge, EmptyState, ErrorState, Loading } from "../components/ui";
import { ConversationView } from "./ConversationView";

const FILTERS: { key: ConvStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "NEEDS_HUMAN", label: "Needs a person" },
  { key: "HUMAN_HANDLING", label: "Human" },
  { key: "AI_HANDLING", label: "AI" },
  { key: "RESOLVED", label: "Resolved" },
];

export function InboxPage() {
  const { id } = useParams();
  const [filter, setFilter] = useState<ConvStatus | "ALL">("ALL");
  const q = useQuery({
    queryKey: ["conversations", filter],
    queryFn: () => api.get<ConversationSummary[]>(`/api/conversations${filter === "ALL" ? "" : `?status=${filter}`}`),
  });

  return (
    <div className="flex h-full">
      <div className={clsx("flex w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-80 xl:w-96", id && "hidden md:flex")}>
        <div className="border-b border-slate-100 px-4 py-3">
          <h1 className="text-base font-semibold">Inbox</h1>
          <p className="text-xs text-slate-500">Live — updates as customers and the agent reply</p>
          <div className="mt-3 flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={clsx("rounded-md px-2 py-1 text-xs font-medium", filter === f.key ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {q.isLoading && <Loading />}
          {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {q.data?.length === 0 && <EmptyState title="No conversations here" hint="Open the customer chat or create a test COD order to start one." />}
          {q.data?.map((c) => (
            <Link
              key={c.id}
              to={`/inbox/${c.id}`}
              className={clsx("block border-b border-slate-100 px-4 py-3 hover:bg-slate-50", id === c.id && "bg-brand-50/60", c.status === "NEEDS_HUMAN" && "border-l-2 border-l-rose-500")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-slate-900">{c.customerName}</span>
                <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(c.lastMessageAt)}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {c.lastMessage ? `${c.lastMessage.role === "CUSTOMER" ? "" : c.lastMessage.role === "AI" ? "Agent: " : c.lastMessage.role === "HUMAN" ? "You: " : ""}${c.lastMessage.voice ? "🎤 " : ""}${c.lastMessage.content}` : "—"}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <ConvStatusBadge status={c.status} />
                {c.channel === "telegram" && <Badge tone="blue">Telegram</Badge>}
                {c.flow && <Badge tone="blue">{c.flow}</Badge>}
                {c.orderNumber && <Badge>{c.orderNumber}</Badge>}
                {c.ticket && c.status !== "RESOLVED" && <Badge tone="red">{humanize(c.ticket.reason)}</Badge>}
                {c.language && c.language !== "en" && <Badge tone="violet">{c.language === "hi" ? "Hindi" : "Hinglish"}</Badge>}
              </div>
            </Link>
          ))}
        </div>
      </div>
      <div className={clsx("min-w-0 flex-1", !id && "hidden md:block")}>
        {id ? <ConversationView id={id} /> : <EmptyState icon={<MessageSquare className="size-10" />} title="Select a conversation" hint="Conversations needing a person are marked in red." />}
      </div>
    </div>
  );
}
