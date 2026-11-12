import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BarChart3, MessageSquare, Package, ScrollText, Settings, ExternalLink, Bot } from "lucide-react";
import { api } from "../lib/api";
import { useAdminLiveUpdates } from "../lib/socket";
import { Badge } from "./ui";

interface SystemInfo {
  engine: "claude" | "mock";
  model: string;
  queue: Record<string, number>;
}

const NAV = [
  { to: "/inbox", label: "Inbox", icon: MessageSquare },
  { to: "/orders", label: "Orders", icon: Package },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  useAdminLiveUpdates();
  const sys = useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemInfo>("/api/system"), refetchInterval: 15_000 });
  const needs = useQuery({ queryKey: ["conversations", "NEEDS_HUMAN"], queryFn: () => api.get<unknown[]>("/api/conversations?status=NEEDS_HUMAN") });

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
