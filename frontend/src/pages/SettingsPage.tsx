import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Timer, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { humanize } from "../lib/format";
import { ErrorState, Loading, Section, useToast } from "../components/ui";
import { PageHeader } from "../components/Layout";

interface Settings {
  cod: { confirmationDelaySec: number; reminderDelaySec: number; holdDelaySec: number; prepaidDiscountPct: number };
  risk: { lowMax: number; mediumMax: number; highValueThresholdInr: number; weights: Record<string, number> };
  ndr: { outreachDelaySec: number; noResponseDelaySec: number; attemptsBeforeHandover: number; rescheduleWindowDays: number };
  handover: Record<string, boolean | number>;
  agent: { maxToolIterations: number; pendingActionTtlMin: number };
}
interface SettingsResponse {
  settings: Settings;
  defaults: Settings;
  demoTimings: { cod: Partial<Settings["cod"]>; ndr: Partial<Settings["ndr"]> };
}

function Num({ label, value, onChange, suffix, hint }: { label: string; value: number; onChange: (v: number) => void; suffix?: string; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input type="number" className="input" value={value} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="shrink-0 text-xs text-slate-500">{suffix}</span>}
      </div>
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

const fmtSecs = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(s % 3600 ? 1 : 0)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function SettingsPage() {
  const qc = useQueryClient();
  const { toast, toastNode } = useToast();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsResponse>("/api/settings") });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(structuredClone(q.data.settings));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (v: Settings) => api.put<Settings>("/api/settings", v),
    onSuccess: () => {
      toast("Settings saved — new jobs use them immediately.");
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => toast((e as Error).message, "err"),
  });

  if (q.isLoading || !s) return q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <Loading />;
  const set = (fn: (d: Settings) => void) => setS((prev) => {
    const d = structuredClone(prev!);
    fn(d);
    return d;
  });

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Reminder timings, risk thresholds and handover rules — no code changes needed"
        actions={
          <>
            <button
              className="btn-secondary"
              onClick={() =>
                set((d) => {
                  Object.assign(d.cod, q.data!.demoTimings.cod);
                  Object.assign(d.ndr, q.data!.demoTimings.ndr);
                })
              }
            >
              <Timer className="size-4" /> Demo timings (seconds)
            </button>
            <button className="btn-secondary" onClick={() => setS(structuredClone(q.data!.defaults))}>
              <RotateCcw className="size-4" /> Defaults
            </button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(s)}>
              <Save className="size-4" /> Save
            </button>
          </>
        }
      />
      <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
        <Section title="COD confirmation">
          <div className="grid gap-3 sm:grid-cols-2">
            <Num label="Send confirmation after" value={s.cod.confirmationDelaySec} suffix={`sec (${fmtSecs(s.cod.confirmationDelaySec)})`} onChange={(v) => set((d) => void (d.cod.confirmationDelaySec = v))} hint="Target: within a minute" />
            <Num label="Reminder if no reply after" value={s.cod.reminderDelaySec} suffix={`sec (${fmtSecs(s.cod.reminderDelaySec)})`} onChange={(v) => set((d) => void (d.cod.reminderDelaySec = v))} hint="Default 2 hours, one reminder" />
            <Num label="Put on hold after" value={s.cod.holdDelaySec} suffix={`sec (${fmtSecs(s.cod.holdDelaySec)})`} onChange={(v) => set((d) => void (d.cod.holdDelaySec = v))} hint="Default 24 hours" />
            <Num label="Prepaid discount" value={s.cod.prepaidDiscountPct} suffix="%" onChange={(v) => set((d) => void (d.cod.prepaidDiscountPct = v))} />
          </div>
        </Section>
        <Section title="Failed delivery (NDR)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Num label="Message customer after" value={s.ndr.outreachDelaySec} suffix={`sec (${fmtSecs(s.ndr.outreachDelaySec)})`} onChange={(v) => set((d) => void (d.ndr.outreachDelaySec = v))} />
            <Num label="No-response window" value={s.ndr.noResponseDelaySec} suffix={`sec (${fmtSecs(s.ndr.noResponseDelaySec)})`} onChange={(v) => set((d) => void (d.ndr.noResponseDelaySec = v))} />
            <Num label="Hand over after failed attempts" value={s.ndr.attemptsBeforeHandover} onChange={(v) => set((d) => void (d.ndr.attemptsBeforeHandover = v))} hint="…when the customer doesn't respond" />
            <Num label="Reschedule window" value={s.ndr.rescheduleWindowDays} suffix="days" onChange={(v) => set((d) => void (d.ndr.rescheduleWindowDays = v))} />
          </div>
        </Section>
        <Section title="COD risk score">
          <div className="grid gap-3 sm:grid-cols-3">
            <Num label="Low risk up to" value={s.risk.lowMax} onChange={(v) => set((d) => void (d.risk.lowMax = v))} />
            <Num label="Medium risk up to" value={s.risk.mediumMax} onChange={(v) => set((d) => void (d.risk.mediumMax = v))} hint="Above = high" />
            <Num label="High order value above" value={s.risk.highValueThresholdInr} suffix="₹" onChange={(v) => set((d) => void (d.risk.highValueThresholdInr = v))} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {Object.entries(s.risk.weights).map(([k, v]) => (
              <Num key={k} label={`${humanize(k.replace(/([A-Z])/g, "_$1"))} (points)`} value={v} onChange={(nv) => set((d) => void (d.risk.weights[k] = nv))} />
            ))}
          </div>
        </Section>
        <Section title="Handover rules">
          <div className="space-y-2">
            {Object.entries(s.handover)
              .filter(([, v]) => typeof v === "boolean")
              .map(([k, v]) => (
                <label key={k} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <span>{humanize(k.replace(/([A-Z])/g, "_$1"))}</span>
                  <input type="checkbox" className="size-4 accent-brand-600" checked={v as boolean} onChange={(e) => set((d) => void (d.handover[k] = e.target.checked))} />
                </label>
              ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Num label="Manual review above" value={s.handover.refundReviewThresholdInr as number} suffix="₹" onChange={(v) => set((d) => void (d.handover.refundReviewThresholdInr = v))} />
            <Num label="Max failed verifications" value={s.handover.maxFailedVerifications as number} onChange={(v) => set((d) => void (d.handover.maxFailedVerifications = v))} />
            <Num label="Max unresolved turns" value={s.handover.maxFailedTurns as number} onChange={(v) => set((d) => void (d.handover.maxFailedTurns = v))} />
          </div>
        </Section>
      </div>
      {toastNode}
    </div>
  );
}
