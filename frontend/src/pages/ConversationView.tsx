import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Bot, CheckCircle2, ExternalLink, Hand, RotateCcw, Send, ShieldAlert, Wrench, UserRound } from "lucide-react";
import { api } from "../lib/api";
import type { ConversationDetail, Message, ToolCall } from "../lib/types";
import { dateTime, humanize, ms, usd } from "../lib/format";
import { Badge, Collapsible, ConvStatusBadge, EngineBadge, ErrorState, JsonView, Loading, useToast } from "../components/ui";

function ToolTrace({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2">
      <div className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
        <Wrench className="size-3" /> Tool calls ({calls.length})
      </div>
      {calls.map((t) => (
        <Collapsible
          key={t.id}
          title={
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <code className="font-semibold text-slate-800">{t.toolName}</code>
              <Badge tone={t.ok ? "green" : "red"}>{t.output.code ?? (t.ok ? "ok" : "error")}</Badge>
              <span className="text-slate-400">{t.durationMs} ms</span>
            </span>
          }
        >
          <div className="grid gap-2 lg:grid-cols-2">
            <div>
              <div className="label">Input (validated)</div>
              <JsonView value={t.input} />
            </div>
            <div>
              <div className="label">Output</div>
              <JsonView value={t.output} />
            </div>
          </div>
        </Collapsible>
      ))}
    </div>
  );
}

function Bubble({ m, calls }: { m: Message; calls: ToolCall[] }) {
  if (m.role === "SYSTEM") return <div className="my-2 text-center text-xs text-slate-400">{m.content}</div>;
  const customer = m.role === "CUSTOMER";
  const flags = (m.meta?.flags as string[] | undefined) ?? [];
  return (
    <div className={clsx("flex gap-2", customer ? "justify-start" : "justify-end")}>
      {customer && (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200">
          <UserRound className="size-4 text-slate-600" />
        </div>
      )}
      <div className={clsx("max-w-[85%] lg:max-w-[70%]")}>
        <div className={clsx("rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap", customer ? "rounded-tl-sm bg-white ring-1 ring-slate-200" : m.role === "HUMAN" ? "rounded-tr-sm bg-amber-100 text-amber-950" : "rounded-tr-sm bg-brand-600 text-white")}>{m.content}</div>
        <div className={clsx("mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400", !customer && "justify-end")}>
          <span>{dateTime(m.createdAt)}</span>
          {!customer && <EngineBadge engine={m.engine} />}
          {m.meta?.inputMode === "voice" && <Badge tone="violet">🎤 voice</Badge>}
          {m.intent && <Badge>{humanize(m.intent)}</Badge>}
          {flags.map((f) => (
            <Badge key={f} tone="red">
              <ShieldAlert className="size-3" /> {humanize(f)}
            </Badge>
          ))}
          {m.latencyMs != null && <span>{ms(m.latencyMs)}</span>}
          {m.costUsd != null && m.costUsd > 0 && <span>{usd(m.costUsd)}</span>}
          {Boolean(m.meta?.fallback) && <Badge tone="amber">fallback reply</Badge>}
        </div>
        {!customer && <ToolTrace calls={calls} />}
      </div>
      {!customer && (
        <div className={clsx("mt-1 flex size-7 shrink-0 items-center justify-center rounded-full", m.role === "HUMAN" ? "bg-amber-200" : "bg-brand-100")}>
          {m.role === "HUMAN" ? <UserRound className="size-4 text-amber-800" /> : <Bot className="size-4 text-brand-700" />}
        </div>
      )}
    </div>
  );
}

export function ConversationView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { toast, toastNode } = useToast();
  const q = useQuery({ queryKey: ["conversation", id], queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`) });
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [q.data?.messages.length]);
  useEffect(() => {
    setDraft("");
  }, [id]);

  const callsByMessage = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    for (const t of q.data?.toolCalls ?? []) {
      if (!t.messageId) continue;
      map.set(t.messageId, [...(map.get(t.messageId) ?? []), t]);
    }
    return map;
  }, [q.data?.toolCalls]);

  // Tool calls of handover turns are linked to the handover message; unlinked ones are shown in the side panel.
  const unlinked = (q.data?.toolCalls ?? []).filter((t) => !t.messageId);

  const action = useMutation({
    mutationFn: (a: "takeover" | "release" | "resolve" | "reopen") => api.post(`/api/conversations/${id}/${a}`),
    onSuccess: (_d, a) => {
      toast(a === "takeover" ? "You own this conversation — the AI is paused." : a === "release" ? "Handed back to the AI." : a === "resolve" ? "Marked resolved." : "Reopened.");
      void qc.invalidateQueries({ queryKey: ["conversation", id] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const reply = useMutation({
    mutationFn: (content: string) => api.post(`/api/conversations/${id}/reply`, { content }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["conversation", id] });
    },
    onError: (e) => toast((e as Error).message, "err"),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const ticket = c.tickets[0];
  const human = c.status === "HUMAN_HANDLING";

  return (
    <div className="flex h-full flex-col xl:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
          <Link to="/inbox" className="rounded p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{c.customer?.name ?? "Unverified visitor"}</span>
              <ConvStatusBadge status={c.status} />
              {c.channel === "telegram" && <Badge tone="blue">Telegram</Badge>}
            </div>
            <div className="text-xs text-slate-500">
              {c.customer?.phone ?? "phone not verified"} · verified orders: {c.verifiedOrderNumbers.length ? c.verifiedOrderNumbers.join(", ") : "none"}
              {c.assignedTo && ` · owner: ${c.assignedTo}`}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(c.status === "AI_HANDLING" || c.status === "NEEDS_HUMAN") && (
              <button className="btn-primary" disabled={action.isPending} onClick={() => action.mutate("takeover")}>
                <Hand className="size-3.5" /> Take over
              </button>
            )}
            {(c.status === "HUMAN_HANDLING" || c.status === "NEEDS_HUMAN") && (
              <button className="btn-secondary" disabled={action.isPending} onClick={() => action.mutate("release")}>
                <Bot className="size-3.5" /> Return to AI
              </button>
            )}
            {c.status !== "RESOLVED" ? (
              <button className="btn-secondary" disabled={action.isPending} onClick={() => action.mutate("resolve")}>
                <CheckCircle2 className="size-3.5" /> Resolve
              </button>
            ) : (
              <button className="btn-secondary" disabled={action.isPending} onClick={() => action.mutate("reopen")}>
                <RotateCcw className="size-3.5" /> Reopen
              </button>
            )}
            <a className="btn-secondary" href={`/chat/c/${c.customerToken}`} target="_blank" rel="noreferrer" title="Open the customer's view of this chat">
              <ExternalLink className="size-3.5" /> Customer view
            </a>
          </div>
        </header>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto bg-slate-50 px-4 py-4">
          {c.messages.map((m) => (
            <Bubble key={m.id} m={m} calls={callsByMessage.get(m.id) ?? []} />
          ))}
          <div ref={endRef} />
        </div>

        <div className="border-t border-slate-200 bg-white p-3">
          {!human && (
            <div className="mb-2 text-xs text-slate-500">
              {c.status === "NEEDS_HUMAN" ? "Waiting for a person — the AI has stopped replying. Take over to respond." : c.status === "AI_HANDLING" ? "The AI agent is handling this chat. Take over to reply yourself." : "Resolved. Reopen to continue."}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) reply.mutate(draft.trim());
            }}
          >
            <textarea
              className="input min-h-[44px] flex-1 resize-y"
              rows={2}
              placeholder={human ? "Write a reply to the customer…" : "Take over to reply"}
              value={draft}
              disabled={!human}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn-primary self-end" disabled={!human || !draft.trim() || reply.isPending}>
              <Send className="size-3.5" /> Send
            </button>
          </form>
        </div>
      </div>

      <aside className="scroll-thin w-full shrink-0 space-y-3 overflow-y-auto border-l border-slate-200 bg-white p-4 xl:w-80">
        {ticket ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-rose-900">Handover ticket</div>
              <Badge tone={ticket.status === "CLOSED" ? "green" : "red"}>{humanize(ticket.status)}</Badge>
            </div>
            <dl className="mt-2 space-y-2 text-sm">
              <div>
                <dt className="label">Why it was handed over</dt>
                <dd className="font-medium">{humanize(ticket.reason)}</dd>
              </div>
              <div>
                <dt className="label">Customer mood</dt>
                <dd>{humanize(ticket.mood)}</dd>
              </div>
              <div>
                <dt className="label">Summary</dt>
                <dd className="text-slate-700">{ticket.summary}</dd>
              </div>
              {ticket.orderContext && (
                <div>
                  <dt className="label">Order context</dt>
                  <dd>
                    <JsonView value={ticket.orderContext} />
                  </dd>
                </div>
              )}
              <div>
                <dt className="label">Suggested reply</dt>
                <dd className="rounded-lg bg-white p-2 text-slate-700 ring-1 ring-slate-200">{ticket.suggestedReply}</dd>
                <button
                  className="btn-secondary mt-2 w-full"
                  onClick={() => {
                    setDraft(ticket.suggestedReply);
                    if (!human) toast("Suggested reply loaded — take over to send it.");
                  }}
                >
                  Use suggested reply
                </button>
              </div>
            </dl>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">No handover for this conversation.</div>
        )}

        <div className="rounded-xl border border-slate-200 p-3 text-sm">
          <div className="mb-2 font-semibold">Context</div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt className="text-slate-500">Flow</dt>
            <dd>{c.context?.flow ?? "Chat"}</dd>
            <dt className="text-slate-500">Language</dt>
            <dd>{c.language ?? "—"}</dd>
            <dt className="text-slate-500">Failed verifications</dt>
            <dd>{c.failedVerifyCount}</dd>
            <dt className="text-slate-500">First response</dt>
            <dd>{ms(c.firstResponseMs)}</dd>
          </dl>
          {c.verifiedOrderNumbers.map((o) => (
            <Link key={o} to={`/orders/${o}`} className="mt-2 block text-xs font-medium text-brand-700 hover:underline">
              Open order {o} →
            </Link>
          ))}
        </div>

        {c.pendingActions.length > 0 && (
          <div className="rounded-xl border border-slate-200 p-3 text-sm">
            <div className="mb-2 font-semibold">Proposed actions</div>
            <ul className="space-y-2">
              {c.pendingActions.map((p) => (
                <li key={p.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <code className="font-semibold">{p.type}</code>
                    <Badge tone={p.status === "EXECUTED" ? "green" : p.status === "PENDING" ? "amber" : p.status === "FAILED" ? "red" : "slate"}>{humanize(p.status)}</Badge>
                  </div>
                  <div className="mt-0.5 text-slate-600">{p.summary}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {unlinked.length > 0 && (
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-1 text-sm font-semibold">Other tool calls</div>
            <ToolTrace calls={unlinked} />
          </div>
        )}
      </aside>
      {toastNode}
    </div>
  );
}
