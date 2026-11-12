import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BarChart3, MessageSquare, Package, ScrollText, Settings, ExternalLink, Bot, ShoppingBag, Users } from "lucide-react";
import { api } from "../lib/api";
import { getSocket, useAdminLiveUpdates } from "../lib/socket";
import { Badge } from "./ui";

interface SystemInfo {
  engine: "claude" | "mock";
  model: string;
  queue: Record<string, number>;
}

const NAV = [
  { to: "/inbox", label: "Inbox", icon: MessageSquare },
  { to: "/orders", label: "Orders", icon: Package },
  { to: "/team", label: "Team", icon: Users },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

const SOURCE_LABEL: Record<string, string> = { store: "website store", dashboard: "dashboard", chat_telegram: "Telegram chat", chat_web: "website chat" };

/** Live team alert for every new order (from the event bus via Socket.IO). */
function NewOrderAlerts() {
  const [alerts, setAlerts] = useState<{ orderNumber: string; source: string; total: number; at: number }[]>([]);
  useEffect(() => {
    const s = getSocket();
    const onNew = (e: { orderNumber: string; source: string; total: number }) => setAlerts((a) => [{ ...e, at: Date.now() }, ...a].slice(0, 3));
    s.on("order:new", onNew);
    return () => {
      s.off("order:new", onNew);
    };
  }, []);
  useEffect(() => {
    if (!alerts.length) return;
    const t = setTimeout(() => setAlerts((a) => a.filter((x) => Date.now() - x.at < 9000)), 9500);
    return () => clearTimeout(t);
  }, [alerts]);
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2" role="status" aria-live="polite">
      {alerts.map((a) => (
        <Link key={a.orderNumber + a.at} to={`/orders/${a.orderNumber}`} className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg hover:bg-slate-800">
          <ShoppingBag className="size-4 text-emerald-300" />
          <span>
            New order <b>{a.orderNumber}</b> · ₹{(a.total / 100).toLocaleString("en-IN")} · via {SOURCE_LABEL[a.source] ?? a.source}
          </span>
        </Link>
      ))}
    </div>
  );
}

export function Layout() {
  useAdminLiveUpdates();
  const sys = useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemInfo>("/api/system"), refetchInterval: 15_000 });
  const needs = useQuery({ queryKey: ["conversations", "NEEDS_HUMAN"], queryFn: () => api.get<unknown[]>("/api/conversations?status=NEEDS_HUMAN") });
  const teamPending = useQuery({ queryKey: ["team-requests", "PENDING"], queryFn: () => api.get<unknown[]>("/api/team-requests?status=PENDING") });

  return (
    <div className="flex h-full">
      <aside className="flex w-16 shrink-0 flex-col border-r border-slate-200 bg-white lg:w-56">
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
          <img src="/favicon.svg" alt="" className="size-7" />
          <div className="hidden lg:block">
            <div className="text-sm leading-tight font-semibold">Wishluck</div>
            <div className="text-[11px] leading-tight text-slate-500">Order Ops</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium", isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")
              }
              title={label}
            >
              <Icon className="size-4 shrink-0" />
              <span className="hidden flex-1 lg:inline">{label}</span>
              {to === "/inbox" && (needs.data?.length ?? 0) > 0 && <span className="hidden rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white lg:inline">{needs.data!.length}</span>}
              {to === "/team" && (teamPending.data?.length ?? 0) > 0 && <span className="hidden rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white lg:inline">{teamPending.data!.length}</span>}
            </NavLink>
          ))}
          <a href="/chat" target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50" title="Open customer chat">
            <ExternalLink className="size-4 shrink-0" />
            <span className="hidden lg:inline">Customer chat</span>
          </a>
        </nav>
        <div className="hidden border-t border-slate-100 p-3 text-xs lg:block">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-600">
            <Bot className="size-3.5" /> Agent engine
          </div>
          {sys.data ? (
            <>
              {sys.data.engine === "claude" ? <Badge tone="violet">Claude · {sys.data.model}</Badge> : <Badge tone="amber">MOCK MODE — no API key</Badge>}
              <div className="mt-2 text-slate-500">
                Jobs: {sys.data.queue.delayed ?? 0} scheduled · {sys.data.queue.active ?? 0} running · {sys.data.queue.failed ?? 0} failed
              </div>
            </>
          ) : (
            <span className="text-slate-400">{sys.isError ? "Backend unreachable" : "…"}</span>
          )}
        </div>
      </aside>
      <NewOrderAlerts />
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
