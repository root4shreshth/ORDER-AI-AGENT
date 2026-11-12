import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ExternalLink, Truck } from "lucide-react";
import { api } from "../lib/api";
import type { OrderDetail } from "../lib/types";
import { dateOnly, dateTime, humanize, inr } from "../lib/format";
import { Badge, Collapsible, ErrorState, JsonView, Loading, RiskBadge, Section, StatusBadge, useToast } from "../components/ui";
import { PageHeader } from "../components/Layout";

const COURIER_EVENTS = [
  { type: "picked_up", label: "Picked up" },
  { type: "in_transit", label: "In transit" },
  { type: "out_for_delivery", label: "Out for delivery" },
  { type: "delivery_failed", label: "Delivery failed" },
  { type: "delivered", label: "Delivered" },
  { type: "rto_initiated", label: "RTO initiated" },
];
const FAIL_REASONS = ["Customer not available", "Address not found", "Customer refused delivery", "Phone not reachable", "Premises closed"];

function RiskGauge({ score, band }: { score: number; band: string }) {
  const color = band === "HIGH" ? "bg-rose-500" : band === "MEDIUM" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex items-end justify-between">
        <div className="text-3xl font-semibold tabular-nums">
          {score}
          <span className="text-base text-slate-400">/100</span>
        </div>
        <RiskBadge score={score} band={band} />
      </div>
      <div className="mt-2 h-2 rounded-full bg-slate-100">
        <div className={clsx("h-2 rounded-full", color)} style={{ width: `${Math.max(score, 2)}%` }} />
      </div>
    </div>
  );
}

export function OrderDetailPage() {
  const { orderNumber = "" } = useParams();
  const qc = useQueryClient();
  const { toast, toastNode } = useToast();
  const [reason, setReason] = useState(FAIL_REASONS[0]!);
  const q = useQuery({ queryKey: ["order", orderNumber], queryFn: () => api.get<OrderDetail>(`/api/orders/${orderNumber}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["order", orderNumber] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
  };
  const courier = useMutation({
    mutationFn: (type: string) => api.post(`/api/orders/${orderNumber}/courier-events`, { type, reason: type === "delivery_failed" || type === "rto_initiated" ? reason : undefined }),
    onSuccess: (_d, type) => {
      toast(`Courier "${humanize(type)}" webhook queued — the timeline updates in a moment.`);
      setTimeout(refresh, 1500);
    },
    onError: (e) => toast((e as Error).message, "err"),
  });
  const cod = useMutation({
    mutationFn: (choice: string) => api.post(`/api/orders/${orderNumber}/cod-response`, { choice }),
    onSuccess: () => {
      toast("COD status updated.");
      refresh();
    },
    onError: (e) => toast((e as Error).message, "err"),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data;
  const c = o.codConfirmation;
  const codOpen = c && ["AWAITING", "ADDRESS_EDIT_REQUESTED", "ON_HOLD"].includes(c.status);

  return (
    <div>
      <PageHeader
        title={`Order ${o.orderNumber}`}
        subtitle={`${o.customer.name} · ${o.customer.phone} · placed ${dateTime(o.placedAt)}`}
        actions={
          <>
            <Link to="/orders" className="btn-secondary">
              <ArrowLeft className="size-4" /> Orders
            </Link>
            <StatusBadge status={o.status} />
            <Badge tone={o.paymentMethod === "COD" ? "amber" : "blue"}>{o.paymentMethod}</Badge>
          </>
        }
      />
      <div className="grid gap-4 p-4 lg:p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {c && (
            <Section title="COD risk & confirmation" actions={<StatusBadge status={c.status} />}>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <RiskGauge score={c.riskScore} band={c.riskBand} />
                  <p className="mt-3 text-xs text-slate-500">Rules-based score (weights editable in Settings). High risk never auto-rejects — it gets a confirmation and a prepaid offer.</p>
                </div>
                <div>
                  <div className="label">Why this score</div>
                  <ul className="space-y-1.5">
                    {c.reasons.map((r) => (
                      <li key={r.signal} className="flex gap-2 text-sm">
                        <span className={clsx("w-10 shrink-0 text-right font-semibold tabular-nums", r.points > 0 ? "text-rose-600" : r.points < 0 ? "text-emerald-600" : "text-slate-400")}>
                          {r.points > 0 ? `+${r.points}` : r.points}
                        </span>
                        <span className="text-slate-700">{r.explanation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs md:grid-cols-4">
                <div>
                  <div className="label">Confirmation sent</div>
                  {dateTime(c.sentAt)}
                </div>
                <div>
                  <div className="label">Reminder</div>
                  {dateTime(c.reminderSentAt)}
                </div>
                <div>
                  <div className="label">Put on hold</div>
                  {dateTime(c.heldAt)}
                </div>
                <div>
                  <div className="label">Customer replied</div>
                  {c.response ? `${humanize(c.response)} · ${dateTime(c.respondedAt)}` : "—"}
                </div>
              </div>
              {codOpen && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <span className="self-center text-xs text-slate-500">Record a reply on the customer's behalf (e.g. after a call):</span>
                  <button className="btn-secondary" onClick={() => cod.mutate("CONFIRM")} disabled={cod.isPending}>
                    Confirm
                  </button>
                  <button className="btn-secondary" onClick={() => cod.mutate("PAY_ONLINE")} disabled={cod.isPending}>
                    Switch to prepaid
                  </button>
                  <button className="btn-danger" onClick={() => cod.mutate("CANCEL")} disabled={cod.isPending}>
                    Cancel order
                  </button>
                </div>
              )}
            </Section>
          )}

          <Section title="Items & amounts">
            <table className="w-full">
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.id} className="border-b border-slate-100 last:border-0">
                    <td className="td">
                      <div className="font-medium">{i.product.name}</div>
                      <div className="text-xs text-slate-400">
                        {i.sku} · size {i.size} · qty {i.quantity}
                        {i.exchangeCount > 0 && " · exchanged once"}
                        {i.returned && " · returned"}
                      </div>
                    </td>
                    <td className="td text-right tabular-nums">{inr(i.unitPrice * i.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-3 ml-auto grid max-w-xs grid-cols-2 gap-1 text-sm">
              <dt className="text-slate-500">Items</dt>
              <dd className="text-right tabular-nums">{inr(o.itemsTotal)}</dd>
              <dt className="text-slate-500">Shipping</dt>
              <dd className="text-right tabular-nums">{inr(o.shippingFee)}</dd>
              <dt className="text-slate-500">COD fee</dt>
              <dd className="text-right tabular-nums">{inr(o.codFee)}</dd>
              {o.discount > 0 && (
                <>
                  <dt className="text-slate-500">Prepaid discount</dt>
                  <dd className="text-right text-emerald-700 tabular-nums">−{inr(o.discount)}</dd>
                </>
              )}
              <dt className="font-semibold">Total</dt>
              <dd className="text-right font-semibold tabular-nums">{inr(o.total)}</dd>
            </dl>
          </Section>

          <Section
            title={
              <span className="flex items-center gap-2">
                <Truck className="size-4" /> Shipment
              </span>
            }
            actions={o.shipment && <StatusBadge status={o.shipment.status} />}
          >
            {o.shipment ? (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                  <div>
                    <div className="label">AWB</div>
                    <a className="font-medium text-brand-700 hover:underline" href={`/track/${o.shipment.awb}`} target="_blank" rel="noreferrer">
                      {o.shipment.awb}
                    </a>
                  </div>
                  <div>
                    <div className="label">Failed attempts</div>
                    {o.shipment.attemptCount}
                  </div>
                  <div>
                    <div className="label">Expected / rescheduled</div>
                    {dateOnly(o.shipment.rescheduledFor ?? o.shipment.expectedDeliveryAt)}
                  </div>
                  <div>
                    <div className="label">Follow-up</div>
                    {o.shipment.ndrOpen ? <Badge tone="red">Awaiting customer</Badge> : o.shipment.attemptCount > 0 ? <Badge tone="green">Handled</Badge> : "—"}
                  </div>
                </div>
                <ol className="relative ml-2 border-l border-slate-200">
                  {o.shipment.events.map((e) => (
                    <li key={e.id} className="mb-3 ml-4">
                      <span className={clsx("absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white", e.type === "DELIVERY_FAILED" || e.type === "RTO_INITIATED" ? "bg-rose-500" : e.type === "DELIVERED" ? "bg-emerald-500" : "bg-brand-500")} />
                      <div className="text-sm font-medium">
                        {humanize(e.type)} {e.reason && <span className="font-normal text-slate-500">— {e.reason}</span>}
                      </div>
                      <div className="text-xs text-slate-400">
                        {dateTime(e.occurredAt)} {e.location && `· ${e.location}`}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-sm text-slate-500">Not handed to the courier yet{o.status === "CONFIRMED" ? " — trigger “Picked up” below to ship it." : "."}</p>
            )}
            <div className="mt-3 rounded-lg bg-slate-50 p-3">
              <div className="label">Simulate a courier webhook (mock courier → signed POST /webhooks/courier)</div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <select className="input w-auto" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Failure reason">
                  {FAIL_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">reason used for “Delivery failed” / “RTO”</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COURIER_EVENTS.map((e) => (
                  <button key={e.type} className={e.type === "delivery_failed" ? "btn-danger" : "btn-secondary"} disabled={courier.isPending} onClick={() => courier.mutate(e.type)}>
                    {e.label}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <Section title="Audit trail">
            {o.audit.length === 0 ? (
              <p className="text-sm text-slate-500">No changes recorded.</p>
            ) : (
              <ul className="space-y-2">
                {o.audit.map((a) => (
                  <li key={a.id} className="text-sm">
                    <Collapsible
                      title={
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="text-xs font-semibold">{a.action}</code>
                          <Badge>{a.actor}</Badge>
                          <span className="text-xs text-slate-400">{dateTime(a.createdAt)}</span>
                        </span>
                      }
                    >
                      <JsonView value={{ old: a.oldValue, new: a.newValue, meta: a.meta }} />
                    </Collapsible>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Delivery address">
            <p className="text-sm">
              {o.addressLine1}
              {o.addressLine2 && <>, {o.addressLine2}</>}
              {o.landmark && <span className="block text-slate-500">Landmark: {o.landmark}</span>}
              <span className="block">
                {o.city}, {o.state} {o.pincode}
              </span>
            </p>
          </Section>
          <Section title="Customer conversations">
            {o.conversations.length === 0 ? (
              <p className="text-sm text-slate-500">No chats linked to this order yet.</p>
            ) : (
              <ul className="space-y-2">
                {o.conversations.map((cv) => (
                  <li key={cv.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link to={`/inbox/${cv.id}`} className="font-medium text-brand-700 hover:underline">
                      {cv.flow ? `${cv.flow} chat` : "Chat"} · {dateTime(cv.createdAt)}
                    </Link>
                    <a className="btn-secondary px-2 py-1 text-xs" href={`/chat/c/${cv.customerToken}`} target="_blank" rel="noreferrer" title="Open as the customer">
                      <ExternalLink className="size-3" /> Customer
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {(o.refunds.length > 0 || o.returnRequests.length > 0) && (
            <Section title="Returns & refunds">
              <ul className="space-y-2 text-sm">
                {o.returnRequests.map((r) => (
                  <li key={r.id}>
                    <Badge tone="violet">{r.type}</Badge> {humanize(r.status)} {r.newSize && `→ size ${r.newSize}`}
                    <div className="text-xs text-slate-500">
                      {r.reason} · {dateOnly(r.createdAt)}
                    </div>
                  </li>
                ))}
                {o.refunds.map((r) => (
                  <li key={r.id}>
                    <Badge tone="green">Refund</Badge> {inr(r.amount)} · {humanize(r.method)} · {humanize(r.status)}
                    <div className="text-xs text-slate-500">{r.completedAt ? `Completed ${dateOnly(r.completedAt)}` : r.expectedBy ? `Expected by ${dateOnly(r.expectedBy)}` : "Awaiting quality check"}</div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Notes">
            <ul className="space-y-2">
              {[...o.notes].reverse().map((n, i) => (
                <li key={i} className="text-sm">
                  <div>{n.text}</div>
                  <div className="text-xs text-slate-400">
                    {n.by} · {dateTime(n.at)}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
      {toastNode}
    </div>
  );
}
