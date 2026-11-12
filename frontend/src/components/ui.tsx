import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Inbox, Loader2, RefreshCw, X, ChevronDown, ChevronRight } from "lucide-react";
import { humanize } from "../lib/format";

type Tone = "slate" | "indigo" | "green" | "amber" | "red" | "blue" | "violet";
const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};

export function Badge({ tone = "slate", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", TONES[tone], className)}>{children}</span>;
}

const CONV_TONE: Record<string, Tone> = { AI_HANDLING: "indigo", NEEDS_HUMAN: "red", HUMAN_HANDLING: "amber", RESOLVED: "green" };
const CONV_LABEL: Record<string, string> = { AI_HANDLING: "AI handling", NEEDS_HUMAN: "Needs a person", HUMAN_HANDLING: "Human handling", RESOLVED: "Resolved" };
export const ConvStatusBadge = ({ status }: { status: string }) => <Badge tone={CONV_TONE[status] ?? "slate"}>{CONV_LABEL[status] ?? humanize(status)}</Badge>;

const ORDER_TONE: Record<string, Tone> = {
  PENDING_CONFIRMATION: "amber",
  ON_HOLD: "red",
  CONFIRMED: "blue",
  SHIPPED: "indigo",
  DELIVERED: "green",
  CANCELLED: "slate",
  RTO_INITIATED: "red",
  RTO_DELIVERED: "slate",
  DELIVERY_FAILED: "red",
  OUT_FOR_DELIVERY: "violet",
  IN_TRANSIT: "indigo",
  PICKED_UP: "blue",
  CREATED: "slate",
  AWAITING: "amber",
  CONVERTED_PREPAID: "green",
  ADDRESS_EDIT_REQUESTED: "amber",
};
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={ORDER_TONE[status] ?? "slate"}>{humanize(status)}</Badge>;

export function RiskBadge({ score, band }: { score: number; band: string }) {
  const tone: Tone = band === "HIGH" ? "red" : band === "MEDIUM" ? "amber" : "green";
  return (
    <Badge tone={tone}>
      <span className="tabular-nums">{score}</span> · {humanize(band)}
    </Badge>
  );
}

export function EngineBadge({ engine }: { engine: string | null | undefined }) {
  if (engine === "claude") return <Badge tone="violet">Claude</Badge>;
  if (engine === "mock") return <Badge tone="amber">MOCK AI</Badge>;
  if (engine === "template") return <Badge tone="slate">Automated</Badge>;
  if (engine === "human") return <Badge tone="amber">Human</Badge>;
  return null;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <AlertTriangle className="size-6 text-rose-500" />
      <div className="text-sm text-slate-700">{error instanceof Error ? error.message : "Something went wrong"}</div>
      {onRetry && (
        <button className="btn-secondary" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center">
      <div className="text-slate-300">{icon ?? <Inbox className="size-8" />}</div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint && <div className="max-w-sm text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("card", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="scroll-thin max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

export function Collapsible({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="flex w-full items-center gap-1 text-left" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="size-3.5 shrink-0 text-slate-400" />}
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="card flex max-h-[92vh] w-full max-w-lg flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="scroll-thin overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={clsx("mt-1 text-2xl font-semibold tabular-nums", accent ?? "text-slate-900")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? (
    <div className={clsx("fixed right-4 bottom-4 z-50 rounded-lg px-4 py-2.5 text-sm shadow-lg", msg.tone === "ok" ? "bg-slate-900 text-white" : "bg-rose-600 text-white")} role="status">
      {msg.text}
    </div>
  ) : null;
  return { toast: (text: string, tone: "ok" | "err" = "ok") => setMsg({ text, tone }), toastNode: node };
}
