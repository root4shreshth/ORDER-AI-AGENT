import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCircle2, MessageSquare, Send, Users } from "lucide-react";
import { api } from "../lib/api";
import { humanize, inr, timeAgo } from "../lib/format";
import { Badge, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { PageHeader } from "../components/Layout";

export interface TeamRequestRow {
  id: string;
  kind: string;
  status: "PENDING" | "ANSWERED" | "CLOSED";
  question: string;
  customerSummary: string;
  reply: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  quote: { text: string } | null;
  quoteUsed: boolean;
  orderNumber: string | null;
  createdAt: string;
  conversation: { id: string; channel: string; status: string; customerName: string };
}
interface CatalogProduct {
  sku: string;
  name: string;
  price: number;
  sizes: { size: string; stock: number }[];
}

function ReplyForm({ req, onDone }: { req: TeamRequestRow; onDone: (msg: string, ok?: boolean) => void }) {
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api.get<CatalogProduct[]>("/api/catalog") });
  const [reply, setReply] = useState("");
  const [withQuote, setWithQuote] = useState(req.kind === "BULK_QUOTE");
  const [sku, setSku] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [validDays, setValidDays] = useState("7");
  const product = catalog.data?.find((p) => p.sku === sku);
  const items = useMemo(
    () => (product ? product.sizes.map((s) => ({ sku, size: s.size, quantity: Number(qty[s.size] || 0) })).filter((i) => i.quantity > 0) : []),
    [product, qty, sku],
  );
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const price = Math.round(Number(unitPrice) * 100);
  const quoteValid = !withQuote || (items.length > 0 && price > 0);

  const send = useMutation({
    mutationFn: () =>
      api.post(`/api/team-requests/${req.id}/reply`, {
        reply,
        ...(withQuote ? { quote: { items: items.map((i) => ({ ...i, unitPrice: price })), validDays: Number(validDays) || 7 } } : {}),
      }),
    onSuccess: () => {
      onDone("Sent — the assistant is relaying your answer to the customer now.");
      void qc.invalidateQueries({ queryKey: ["team-requests"] });
    },
    onError: (e) => onDone((e as Error).message, false),
  });

  return (
    <form
      className="mt-3 space-y-3 border-t border-slate-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (reply.trim() && quoteValid) send.mutate();
      }}
    >
      <div>
        <span className="label">Your answer to the assistant (it will pass it on to the customer)</span>
        <textarea className="input min-h-[70px]" placeholder="e.g. We can do ₹1,000 per piece for 250 pieces, delivery in 12–15 days after payment." value={reply} onChange={(e) => setReply(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-brand-600" checked={withQuote} onChange={(e) => setWithQuote(e.target.checked)} />
        Approve a quote the customer can book in chat
      </label>
      {withQuote && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3">
          {catalog.isLoading ? (
            <Loading />
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <select className="input sm:col-span-2" value={sku} onChange={(e) => setSku(e.target.value)} aria-label="Product">
                  <option value="">Product…</option>
                  {catalog.data?.map((p) => (
                    <option key={p.sku} value={p.sku}>
                      {p.name} (list {inr(p.price)})
                    </option>
                  ))}
                </select>
                <input className="input" inputMode="decimal" placeholder="₹ per piece" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Price per piece" />
              </div>
              {product && (
                <div>
                  <span className="label">Quantity per size</span>
                  <div className="flex flex-wrap gap-2">
                    {product.sizes.map((s) => (
                      <label key={s.size} className="flex items-center gap-1 text-xs">
                        <span className="w-8 font-medium">{s.size}</span>
                        <input className="input w-20" inputMode="numeric" value={qty[s.size] ?? ""} onChange={(e) => setQty({ ...qty, [s.size]: e.target.value.replace(/\D/g, "") })} />
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <label className="flex items-center gap-1">
                  Valid for <input className="input w-14" inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value.replace(/\D/g, ""))} /> days
                </label>
                {totalQty > 0 && price > 0 && (
                  <span className="font-medium">
                    {totalQty} pcs × {inr(price)} = {inr(totalQty * price)} (+ shipping)
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <button className="btn-primary" disabled={!reply.trim() || !quoteValid || send.isPending}>
        <Send className="size-4" /> Send to assistant
      </button>
    </form>
  );
}

export function TeamPage() {
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");
  const [open, setOpen] = useState<string | null>(null);
  const { toast, toastNode } = useToast();
  const q = useQuery({ queryKey: ["team-requests", filter], queryFn: () => api.get<TeamRequestRow[]>(`/api/team-requests${filter === "PENDING" ? "?status=PENDING" : ""}`) });

  return (
    <div>
      <PageHeader title="Team" subtitle="The assistant asks you for decisions (bulk quotes, special requests) while it keeps chatting with the customer" />
      <div className="space-y-3 p-4 lg:p-6">
        <div className="flex gap-1">
          {(["PENDING", "ALL"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={clsx("rounded-md px-2.5 py-1.5 text-xs font-medium", filter === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200")}>
              {f === "PENDING" ? "Waiting for you" : "All requests"}
            </button>
          ))}
        </div>
        {q.isLoading && <Loading />}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data?.length === 0 && <EmptyState icon={<Users className="size-8" />} title={filter === "PENDING" ? "Nothing waiting for the team" : "No team requests yet"} hint="When a customer asks for a bulk quote or something only the team can decide, the assistant drafts a request here." />}
        {q.data?.map((r) => (
          <div key={r.id} className={clsx("card p-4", r.status === "PENDING" && "border-l-4 border-l-amber-400")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={r.status === "PENDING" ? "amber" : r.status === "ANSWERED" ? "green" : "slate"}>{r.status === "PENDING" ? "Waiting for team" : humanize(r.status)}</Badge>
                <Badge tone="violet">{humanize(r.kind)}</Badge>
                {r.conversation.channel === "telegram" && <Badge tone="blue">Telegram</Badge>}
                <span className="text-xs text-slate-500">
                  {r.conversation.customerName} · {timeAgo(r.createdAt)}
                </span>
              </div>
              <Link to={`/inbox/${r.conversation.id}`} className="btn-secondary px-2 py-1 text-xs">
                <MessageSquare className="size-3.5" /> Open chat
              </Link>
            </div>
            <div className="mt-3 rounded-lg bg-brand-50/60 p-3 text-sm">
              <div className="label">Assistant asks</div>
              <p className="whitespace-pre-wrap text-slate-800">{r.question}</p>
              <p className="mt-1 text-xs text-slate-500">{r.customerSummary}</p>
            </div>
            {r.reply && (
              <div className="mt-2 rounded-lg bg-emerald-50/60 p-3 text-sm">
                <div className="label">
                  {r.answeredBy ?? "Team"} answered {r.answeredAt ? timeAgo(r.answeredAt) : ""}
                </div>
                <p className="whitespace-pre-wrap">{r.reply}</p>
                {r.quote && (
                  <p className="mt-1 text-xs text-emerald-800">
                    <CheckCircle2 className="mr-1 inline size-3.5" />
                    Approved quote: {r.quote.text}
                    {r.orderNumber ? (
                      <>
                        {" "}
                        · booked as{" "}
                        <Link className="font-semibold underline" to={`/orders/${r.orderNumber}`}>
                          {r.orderNumber}
                        </Link>
                      </>
                    ) : r.quoteUsed ? " · used" : " · not booked yet"}
                  </p>
                )}
              </div>
            )}
            {r.status === "PENDING" &&
              (open === r.id ? (
                <ReplyForm
                  req={r}
                  onDone={(m, ok = true) => {
                    toast(m, ok ? "ok" : "err");
                    if (ok) setOpen(null);
                  }}
                />
              ) : (
                <button className="btn-primary mt-3" onClick={() => setOpen(r.id)}>
                  Reply
                </button>
              ))}
          </div>
        ))}
      </div>
      {toastNode}
    </div>
  );
}
