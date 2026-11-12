import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCircle2, Package } from "lucide-react";
import { api } from "../lib/api";
import { dateTime, humanize, inr } from "../lib/format";
import { ErrorState, Loading, StatusBadge } from "../components/ui";

interface Track {
  awb: string;
  courier: string;
  status: string;
  orderNumber: string;
  city: string;
  expectedDelivery: string | null;
  timeline: { status: string; reason: string | null; location: string | null; at: string }[];
}

export function TrackPage() {
  const { awb = "" } = useParams();
  const q = useQuery({ queryKey: ["track", awb], queryFn: () => api.chat.get<Track>(`/api/public/track/${awb}`) });
  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="mb-4 flex items-center gap-2">
        <Package className="size-5 text-brand-600" />
        <h1 className="text-lg font-semibold">Track shipment</h1>
      </div>
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} />}
      {q.data && (
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-500">{q.data.courier}</div>
              <div className="font-semibold">AWB {q.data.awb}</div>
            </div>
            <StatusBadge status={q.data.status} />
          </div>
          <div className="mt-1 text-sm text-slate-500">
            Order {q.data.orderNumber} · to {q.data.city}
            {q.data.expectedDelivery && ` · expected ${q.data.expectedDelivery}`}
          </div>
          <ol className="relative mt-5 ml-2 border-l border-slate-200">
            {q.data.timeline.map((e, i) => (
              <li key={i} className="mb-4 ml-4">
                <span className={clsx("absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white", e.status === "DELIVERY_FAILED" ? "bg-rose-500" : e.status === "DELIVERED" ? "bg-emerald-500" : "bg-brand-500")} />
                <div className="text-sm font-medium">{humanize(e.status)}</div>
                <div className="text-xs text-slate-500">
                  {dateTime(e.at)}
                  {e.location && ` · ${e.location}`}
                  {e.reason && ` · ${e.reason}`}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function PayPage() {
  const { orderNumber = "" } = useParams();
  const [paid, setPaid] = useState(false);
  const q = useQuery({ queryKey: ["pay", orderNumber], queryFn: () => api.chat.get<{ orderNumber: string; total: number; discount: number }>(`/api/public/pay/${orderNumber}`) });
  return (
    <div className="mx-auto max-w-sm p-6">
      <div className="card p-5 text-center">
        <div className="text-xs font-semibold tracking-wide text-amber-700 uppercase">Demo payment page — no money moves</div>
        {q.isLoading && <Loading />}
        {q.isError && <ErrorState error={q.error} />}
        {q.data &&
          (paid ? (
            <div className="py-6">
              <CheckCircle2 className="mx-auto size-10 text-emerald-500" />
              <div className="mt-2 font-semibold">Payment simulated</div>
              <div className="text-sm text-slate-500">Order {q.data.orderNumber} is prepaid and confirmed.</div>
            </div>
          ) : (
            <>
              <div className="mt-3 text-sm text-slate-500">Order {q.data.orderNumber}</div>
              <div className="mt-1 text-3xl font-semibold">{inr(q.data.total)}</div>
              {q.data.discount > 0 && <div className="text-sm text-emerald-700">You saved {inr(q.data.discount)} with prepaid</div>}
              <button className="btn-primary mt-5 w-full" onClick={() => setPaid(true)}>
                Pay (simulated)
              </button>
            </>
          ))}
      </div>
    </div>
  );
}
