import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { api } from "../lib/api";
import type { OrderRow } from "../lib/types";
import { dateTime } from "../lib/format";
import { Badge, EmptyState, ErrorState, Loading, Modal, RiskBadge, StatusBadge, useToast } from "../components/ui";
import { PageHeader } from "../components/Layout";
import { NewOrderForm } from "../components/NewOrderForm";

const FILTERS = [
  { key: "all", label: "All orders" },
  { key: "cod", label: "COD" },
  { key: "cod_pending", label: "Awaiting COD confirmation" },
  { key: "high_risk", label: "High risk" },
  { key: "on_hold", label: "On hold" },
  { key: "failed_delivery", label: "Failed delivery" },
  { key: "rto", label: "RTO" },
];

const PRESETS = [
  { key: "high_risk_first_time", label: "High-risk COD", hint: "First-time buyer, ~₹4,546, address “near Shiv mandir”, Patna (Appendix B #7)" },
  { key: "medium_risk", label: "Medium-risk COD", hint: "New customer, ₹3,000+ order, full address, Jaipur" },
  { key: "low_risk_repeat", label: "Low-risk COD", hint: "Repeat customer Aarav (several deliveries), Delhi" },
  { key: "prepaid", label: "Prepaid", hint: "Prepaid order — no COD confirmation needed" },
];

export function OrdersPage() {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [tab, setTab] = useState<"order" | "scenarios">("order");
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast, toastNode } = useToast();
  const orders = useQuery({ queryKey: ["orders", filter, q], queryFn: () => api.get<OrderRow[]>(`/api/orders?filter=${filter}&q=${encodeURIComponent(q)}`) });
  const create = useMutation({
    mutationFn: (preset: string) => api.post<{ orderNumber: string; webhookStatus: number }>("/api/orders/test", { preset, ...(phone.replace(/D/g, "").length >= 10 ? { phone: phone.replace(/D/g, "").slice(-10) } : {}) }),
    onSuccess: (r) => {
      setOpen(false);
      toast(`Test order ${r.orderNumber} sent through the signed webhook (HTTP ${r.webhookStatus}).`);
      void qc.invalidateQueries({ queryKey: ["orders"] });
      setTimeout(() => nav(`/orders/${r.orderNumber}`), 900);
    },
    onError: (e) => toast((e as Error).message, "err"),
  });

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="COD risk, confirmation status and deliveries"
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> New order
          </button>
        }
      />
      <div className="space-y-3 p-4 lg:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <input className="input w-56 pl-8" placeholder="Order no. or customer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
          </div>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)} className={clsx("rounded-md px-2.5 py-1.5 text-xs font-medium", filter === f.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50")}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="card overflow-x-auto">
          {orders.isLoading && <Loading />}
          {orders.isError && <ErrorState error={orders.error} onRetry={() => orders.refetch()} />}
          {orders.data?.length === 0 && <EmptyState title="No orders match" hint="Try another filter or create a test order." />}
          {orders.data && orders.data.length > 0 && (
            <table className="w-full min-w-[860px]">
              <thead className="border-b border-slate-100 bg-slate-50/60">
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Customer</th>
                  <th className="th">Payment</th>
                  <th className="th">Total</th>
                  <th className="th">Status</th>
                  <th className="th">COD risk</th>
                  <th className="th">Confirmation</th>
                  <th className="th">Delivery</th>
                  <th className="th">Placed</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.map((o) => (
                  <tr key={o.orderNumber} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="td">
                      <Link to={`/orders/${o.orderNumber}`} className="font-semibold text-brand-700 hover:underline">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="td">
                      <div>{o.customerName}</div>
                      <div className="text-xs text-slate-400">
                        {o.customerPhone} · {o.city}
                      </div>
                    </td>
                    <td className="td">
                      <Badge tone={o.paymentMethod === "COD" ? "amber" : "blue"}>{o.paymentMethod}</Badge>
                    </td>
                    <td className="td tabular-nums">{o.totalText}</td>
                    <td className="td">
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="td">{o.cod ? <RiskBadge score={o.cod.score} band={o.cod.band} /> : <span className="text-slate-300">—</span>}</td>
                    <td className="td">{o.cod ? <StatusBadge status={o.cod.status} /> : <span className="text-slate-300">—</span>}</td>
                    <td className="td">
                      {o.shipment ? (
                        <div className="flex items-center gap-1">
                          <StatusBadge status={o.shipment.status} />
                          {o.shipment.attempts > 0 && <span className="text-xs text-slate-500">×{o.shipment.attempts}</span>}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="td text-xs text-slate-500">{dateTime(o.placedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New order">
        <div className="mb-4 flex gap-1 border-b border-slate-100 pb-3">
          {(["order", "scenarios"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", tab === t ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600")}>
              {t === "order" ? "Enter an order" : "Quick test scenarios"}
            </button>
          ))}
        </div>
        {tab === "order" ? (
          <NewOrderForm
            onCreated={(no) => {
              setOpen(false);
              toast(`Order ${no} created — the customer is being notified.`);
              void qc.invalidateQueries({ queryKey: ["orders"] });
              setTimeout(() => nav(`/orders/${no}`), 1200);
            }}
            onError={(m) => toast(m, "err")}
          />
        ) : (
          <>
        <p className="mb-3 text-sm text-slate-500">Ready-made scenarios for testing (e.g. Appendix B #7). Sent through the same signed <code>order.created</code> webhook.</p>
        <label className="mb-3 block">
          <span className="label">Customer phone (optional)</span>
          <input className="input" inputMode="numeric" placeholder="e.g. your number, if linked to the Telegram bot" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={14} />
          <span className="mt-0.5 block text-[11px] text-slate-400">Leave empty for a random new customer.</span>
        </label>
        <div className="space-y-2">
          {PRESETS.map((p) => (
            <button key={p.key} disabled={create.isPending} onClick={() => create.mutate(p.key)} className="w-full rounded-lg border border-slate-200 p-3 text-left hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50">
              <div className="text-sm font-medium">{p.label}</div>
              <div className="text-xs text-slate-500">{p.hint}</div>
            </button>
          ))}
        </div>
          </>
        )}
      </Modal>
      {toastNode}
    </div>
  );
}
