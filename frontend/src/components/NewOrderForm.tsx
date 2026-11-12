import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, Send, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { inr } from "../lib/format";
import { Badge, ErrorState, Loading } from "./ui";

interface CustomerOption {
  id: string;
  name: string;
  phone: string;
  telegramLinked: boolean;
  telegramUsername: string | null;
  orders: number;
}
interface CatalogProduct {
  sku: string;
  name: string;
  price: number;
  sizes: { size: string; stock: number }[];
}
interface Line {
  sku: string;
  size: string;
  quantity: number;
}

/**
 * Real order entry for the team (phone/WhatsApp/walk-in orders). The order goes through the same
 * signed order webhook as the store → COD risk + confirmation, or a welcome message for prepaid;
 * customers linked to the Telegram bot receive it on Telegram.
 */
export function NewOrderForm({ onCreated, onError }: { onCreated: (orderNumber: string) => void; onError: (msg: string) => void }) {
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.get<CustomerOption[]>("/api/customers") });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api.get<CatalogProduct[]>("/api/catalog") });
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lines, setLines] = useState<Line[]>([{ sku: "", size: "", quantity: 1 }]);
  const [address, setAddress] = useState({ addressLine1: "", addressLine2: "", landmark: "", pincode: "" });
  const [payment, setPayment] = useState<"COD" | "PREPAID">("COD");

  const products = catalog.data ?? [];
  const estimate = useMemo(() => {
    const items = lines.reduce((s, l) => s + (products.find((p) => p.sku === l.sku)?.price ?? 0) * l.quantity, 0);
    const shipping = items > 999_00 || items === 0 ? 0 : 79_00;
    const cod = payment === "COD" && items > 0 ? 49_00 : 0;
    return { items, shipping, cod, total: items + shipping + cod };
  }, [lines, products, payment]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ orderNumber: string }>("/api/orders", {
        ...(mode === "existing" ? { customerId } : { name, phone }),
        items: lines.filter((l) => l.sku && l.size),
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2 || undefined,
        landmark: address.landmark || undefined,
        pincode: address.pincode,
        paymentMethod: payment,
      }),
    onSuccess: (r) => onCreated(r.orderNumber),
    onError: (e) => onError((e as Error).message),
  });

  if (customers.isLoading || catalog.isLoading) return <Loading />;
  if (customers.isError || catalog.isError) return <ErrorState error={customers.error ?? catalog.error} />;
  const selected = customers.data?.find((c) => c.id === customerId);
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid =
    (mode === "existing" ? !!customerId : name.trim().length > 1 && phone.replace(/\D/g, "").length >= 10) &&
    lines.some((l) => l.sku && l.size) &&
    /\d/.test(address.addressLine1) &&
    /^\d{6}$/.test(address.pincode);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) create.mutate();
      }}
    >
      <fieldset>
        <div className="mb-2 flex gap-1">
          {(["existing", "new"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", mode === m ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600")}>
              {m === "existing" ? "Existing customer" : "New customer"}
            </button>
          ))}
        </div>
        {mode === "existing" ? (
          <>
            <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Customer">
              <option value="">Select a customer…</option>
              {customers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.telegramLinked ? "✈️ " : ""}
                  {c.name} · {c.phone}
                  {c.telegramUsername ? ` · @${c.telegramUsername}` : ""} · {c.orders} order{c.orders === 1 ? "" : "s"}
                </option>
              ))}
            </select>
            {selected && (
              <div className="mt-1.5 text-xs">
                {selected.telegramLinked ? (
                  <Badge tone="blue">On Telegram{selected.telegramUsername ? ` · @${selected.telegramUsername}` : ""} — confirmation goes to their Telegram</Badge>
                ) : (
                  <span className="text-slate-500">Not linked to Telegram — the message waits in their web chat.</span>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Customer name" />
            <input className="input" placeholder="Mobile number" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={14} aria-label="Mobile" />
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="label">Items</legend>
        {lines.map((l, i) => {
          const p = products.find((x) => x.sku === l.sku);
          return (
            <div key={i} className="flex gap-2">
              <select className="input flex-1" value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value, size: "" })} aria-label="Product">
                <option value="">Product…</option>
                {products.map((x) => (
                  <option key={x.sku} value={x.sku}>
                    {x.name} — {inr(x.price)}
                  </option>
                ))}
              </select>
              <select className="input w-28" value={l.size} onChange={(e) => setLine(i, { size: e.target.value })} disabled={!p} aria-label="Size">
                <option value="">Size</option>
                {p?.sizes.map((s) => (
                  <option key={s.size} value={s.size} disabled={s.stock === 0}>
                    {s.size} {s.stock === 0 ? "(out)" : `(${s.stock})`}
                  </option>
                ))}
              </select>
              <input className="input w-16" type="number" min={1} max={10} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} aria-label="Quantity" />
              <button type="button" className="rounded-lg px-2 text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove item">
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setLines((ls) => [...ls, { sku: "", size: "", quantity: 1 }])} disabled={lines.length >= 10}>
          <Plus className="size-3.5" /> Add item
        </button>
      </fieldset>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="label">Delivery address</legend>
        <input className="input sm:col-span-2" placeholder="House/flat no., building, street" value={address.addressLine1} onChange={(e) => setAddress({ ...address, addressLine1: e.target.value })} aria-label="Address line 1" />
        <input className="input" placeholder="Area / locality (optional)" value={address.addressLine2} onChange={(e) => setAddress({ ...address, addressLine2: e.target.value })} aria-label="Address line 2" />
        <input className="input" placeholder="Landmark (optional)" value={address.landmark} onChange={(e) => setAddress({ ...address, landmark: e.target.value })} aria-label="Landmark" />
        <input className="input" placeholder="Pincode" inputMode="numeric" maxLength={6} value={address.pincode} onChange={(e) => setAddress({ ...address, pincode: e.target.value.replace(/\D/g, "") })} aria-label="Pincode" />
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div className="flex gap-1">
          {(["COD", "PREPAID"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setPayment(m)} className={clsx("rounded-md px-2.5 py-1 text-xs font-medium", payment === m ? "bg-brand-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200")}>
              {m === "COD" ? "Cash on delivery" : "Prepaid"}
            </button>
          ))}
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold tabular-nums">≈ {inr(estimate.total)}</div>
          <div className="text-[11px] text-slate-500">
            items {inr(estimate.items)} · shipping {inr(estimate.shipping)}
            {estimate.cod ? ` · COD ${inr(estimate.cod)}` : ""} — final price set by the server
          </div>
        </div>
      </div>

      <button className="btn-primary w-full" disabled={!valid || create.isPending}>
        <Send className="size-4" /> {create.isPending ? "Creating…" : "Create order & notify customer"}
      </button>
    </form>
  );
}
