import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import clsx from "clsx";
import { Bot, RefreshCw, Send, ShoppingBag, UserRound } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { getSocket } from "../lib/socket";
import type { PublicMessage } from "../lib/types";

interface Session {
  conversationId: string;
  token: string;
  status: string;
  engine: "claude" | "mock";
  messages: PublicMessage[];
}

const STORAGE_KEY = "wishluck_chat";
const SUGGESTIONS = ["Where is my order WL10234?", "Do you deliver COD to 795001?", "Which kurta size for 5'8, 70kg?", "I want to return an item"];

function readStored(): { conversationId: string; token: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function CustomerChatPage() {
  const { token: linkToken } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (token: string) => {
    const s = await api.chat.get<Session>(`/api/chat/session?token=${encodeURIComponent(token)}`);
    setSession(s);
    return s;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const r = await api.chat.post<{ conversationId: string; token: string }>("/api/chat/start", {});
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
      } catch {
        /* storage unavailable */
      }
      await load(r.token);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load]);

  useEffect(() => {
    const token = linkToken ?? readStored()?.token;
    if (token) load(token).catch((e) => (e instanceof ApiError && e.status === 404 && !linkToken ? start() : setError((e as Error).message)));
    else void start();
  }, [linkToken, load, start]);

  // live updates (automated COD / NDR messages, human agent replies)
  useEffect(() => {
    if (!session) return;
    const s = getSocket();
    const join = () => s.emit("join:conversation", { conversationId: session.conversationId, token: session.token });
    join();
    s.on("connect", join);
    const refresh = () => void load(session.token).catch(() => undefined);
    s.on("message:new", refresh);
    s.on("conversation:updated", refresh);
    return () => {
      s.off("connect", join);
      s.off("message:new", refresh);
      s.off("conversation:updated", refresh);
    };
  }, [session?.conversationId, session?.token, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.messages.length, pending]);

  async function send(msg: string) {
    if (!session || !msg.trim() || sending) return;
    setSending(true);
    setPending(msg.trim());
    setText("");
    setError(null);
    try {
      await api.chat.post(`/api/chat/${session.conversationId}/messages`, { text: msg.trim() }, session.token);
      await load(session.token);
    } catch (e) {
      setError((e as Error).message);
      setText(msg);
    } finally {
      setPending(null);
      setSending(false);
    }
  }

  async function quickReply(choice: string, orderNumber: string | null) {
    if (!session || sending) return;
    setSending(true);
    try {
      await api.chat.post(`/api/chat/${session.conversationId}/quick-reply`, { choice, orderNumber }, session.token);
      await load(session.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const lastAi = [...(session?.messages ?? [])].reverse().find((m) => m.role !== "CUSTOMER" && m.role !== "SYSTEM");
  const showQuick = lastAi?.quickReplies && session?.messages[session.messages.length - 1]?.id === lastAi.id;
  const muted = session && (session.status === "NEEDS_HUMAN" || session.status === "HUMAN_HANDLING");

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-brand-50 to-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-brand-600">
            <ShoppingBag className="size-5 text-white" />
          </div>
          <div className="flex-1">
            <div className="font-semibold">Wishluck Support</div>
            <div className="text-xs text-slate-500">English · हिंदी · Hinglish — order status, returns, refunds & more</div>
          </div>
          {!linkToken && (
            <button
              className="btn-secondary"
              onClick={() => {
                try {
                  localStorage.removeItem(STORAGE_KEY);
                } catch {
                  /* ignore */
                }
                void start();
              }}
              title="Start a new conversation"
            >
              <RefreshCw className="size-3.5" /> New chat
            </button>
          )}
        </div>
        {session?.engine === "mock" && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">Demo mode: no Claude API key is configured, so replies come from a rule-based MOCK engine — not AI.</div>
        )}
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-3 px-4 py-5">
          {!session && !error && <div className="text-center text-sm text-slate-500">Connecting…</div>}
          {session && session.messages.length === 0 && (
            <div className="rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
              <div className="font-medium">Hi! 👋 How can we help today?</div>
              <p className="mt-1 text-slate-500">For order details, please keep your order number and the phone number used on the order handy.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {session?.messages.map((m) =>
            m.role === "SYSTEM" ? (
              <div key={m.id} className="text-center text-xs text-slate-500">
                {m.content}
              </div>
            ) : (
              <div key={m.id} className={clsx("flex items-end gap-2", m.role === "CUSTOMER" ? "justify-end" : "justify-start")}>
                {m.role !== "CUSTOMER" && (
                  <div className={clsx("flex size-7 shrink-0 items-center justify-center rounded-full", m.role === "HUMAN" ? "bg-amber-200" : "bg-brand-100")}>
                    {m.role === "HUMAN" ? <UserRound className="size-4 text-amber-800" /> : <Bot className="size-4 text-brand-700" />}
                  </div>
                )}
                <div className={clsx("max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap shadow-sm", m.role === "CUSTOMER" ? "rounded-br-sm bg-brand-600 text-white" : "rounded-bl-sm bg-white ring-1 ring-slate-200")}>
                  {m.content.split(/(https?:\/\/\S+)/g).map((part, i) =>
                    /^https?:\/\//.test(part) ? (
                      <a key={i} href={part.replace(/[).,]+$/, "")} target="_blank" rel="noreferrer" className="underline">
                        {part}
                      </a>
                    ) : (
                      <span key={i}>{part}</span>
                    ),
                  )}
                  {m.role === "HUMAN" && <div className="mt-1 text-[10px] font-medium text-amber-700">Wishluck team</div>}
                </div>
              </div>
            ),
          )}
          {pending && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand-600/80 px-3.5 py-2 text-sm text-white">{pending}</div>
              </div>
              {!muted && (
                <div className="flex items-end gap-2">
                  <div className="flex size-7 items-center justify-center rounded-full bg-brand-100">
                    <Bot className="size-4 text-brand-700" />
                  </div>
                  <div className="typing rounded-2xl rounded-bl-sm bg-white px-4 py-3 ring-1 ring-slate-200">
                    <span className="inline-block size-1.5 rounded-full bg-slate-400" /> <span className="inline-block size-1.5 rounded-full bg-slate-400" /> <span className="inline-block size-1.5 rounded-full bg-slate-400" />
                  </div>
                </div>
              )}
            </>
          )}
          {showQuick && (
            <div className="flex flex-wrap gap-2 pl-9">
              {lastAi!.quickReplies!.map((q) => (
                <button key={q.id} disabled={sending} className="rounded-full border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50" onClick={() => void quickReply(q.id, lastAi!.orderNumber)}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-3">
          {muted && <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">You're connected to our support team — a person will reply here.</div>}
          {error && <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input className="input flex-1" placeholder="Type your message…" value={text} onChange={(e) => setText(e.target.value)} disabled={!session} maxLength={2000} aria-label="Message" />
            <button className="btn-primary px-4" disabled={!session || !text.trim() || sending} aria-label="Send">
              <Send className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
