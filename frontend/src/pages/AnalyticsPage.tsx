import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import { humanize, ms, usd } from "../lib/format";
import { EmptyState, ErrorState, Loading, Section, Stat } from "../components/ui";
import { PageHeader } from "../components/Layout";

interface Analytics {
  conversations: { total: number; resolvedWithoutHuman: number; resolvedWithoutHumanPct: number; byStatus: Record<string, number> };
  handoversByReason: { reason: string; count: number }[];
  cod: { total: number; sent: number; confirmed: number; cancelled: number; convertedToPrepaid: number; onHold: number; awaiting: number; confirmationRatePct: number; byRiskBand: { band: string; count: number }[] };
  savedFromRto: { total: number; codConvertedOrRiskyConfirmed: number; ndrRecovered: number; definition: string };
  firstResponse: { avgMs: number | null; medianMs: number | null; samples: number };
  aiLatency: { avgMs: number | null; samples: number };
  commonRequests: { intent: string; count: number }[];
  llm: { totalCostUsd: number; claudeConversations: number; avgCostPerChatUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; repliesByEngine: { claude: number; mock: number } };
  volume: { day: string; messages: number }[];
  generatedAt: string;
}

const BAR = "#4f46e5";
const RISK_COLORS: Record<string, string> = { LOW: "#10b981", MEDIUM: "#f59e0b", HIGH: "#f43f5e" };

function HBar({ data, dataKey, nameKey }: { data: Record<string, unknown>[]; dataKey: string; nameKey: string }) {
  if (!data.length) return <EmptyState title="No data yet" />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#64748b" }} />
        <YAxis type="category" dataKey={nameKey} width={170} tick={{ fontSize: 11, fill: "#334155" }} tickFormatter={(v: string) => humanize(v)} />
        <Tooltip labelFormatter={(v) => humanize(String(v))} />
        <Bar dataKey={dataKey} fill={BAR} radius={[0, 4, 4, 0]} barSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AnalyticsPage() {
  const q = useQuery({ queryKey: ["analytics"], queryFn: () => api.get<Analytics>("/api/analytics"), refetchInterval: 20_000 });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const codOutcomes = [
    { name: "Confirmed", value: a.cod.confirmed - a.cod.convertedToPrepaid },
    { name: "Switched to prepaid", value: a.cod.convertedToPrepaid },
    { name: "Cancelled", value: a.cod.cancelled },
    { name: "On hold", value: a.cod.onHold },
    { name: "Awaiting", value: a.cod.awaiting },
  ];

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Computed live from the database (seed data + everything done in this environment)" />
      <div className="space-y-4 p-4 lg:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Chats solved without a person" value={`${a.conversations.resolvedWithoutHumanPct}%`} hint={`${a.conversations.resolvedWithoutHuman} of ${a.conversations.total} chats`} accent="text-brand-700" />
          <Stat label="COD confirmation rate" value={`${a.cod.confirmationRatePct}%`} hint={`${a.cod.confirmed} confirmed / ${a.cod.confirmed + a.cod.cancelled} answered`} />
          <Stat label="Orders saved from RTO" value={a.savedFromRto.total} hint={`${a.savedFromRto.codConvertedOrRiskyConfirmed} COD · ${a.savedFromRto.ndrRecovered} failed deliveries`} accent="text-emerald-700" />
          <Stat label="Avg first response" value={ms(a.firstResponse.avgMs)} hint={`median ${ms(a.firstResponse.medianMs)} · ${a.firstResponse.samples} chats`} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Handovers by reason">
            <HBar data={a.handoversByReason} dataKey="count" nameKey="reason" />
          </Section>
          <Section title="Most common requests">
            <HBar data={a.commonRequests.map((c) => ({ ...c, intent: c.intent.replace(/^handover:/, "handover: ") }))} dataKey="count" nameKey="intent" />
          </Section>
          <Section title="COD outcomes">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={codOutcomes} margin={{ right: 8 }}>
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#334155" }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip />
                <Bar dataKey="value" fill={BAR} radius={[4, 4, 0, 0]} barSize={36} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
              {a.cod.byRiskBand.map((b) => (
                <span key={b.band} className="flex items-center gap-1">
                  <span className="size-2.5 rounded-sm" style={{ background: RISK_COLORS[b.band] }} /> {humanize(b.band)} risk: {b.count}
                </span>
              ))}
            </div>
          </Section>
          <Section title="Customer messages per day">
            {a.volume.length === 0 ? (
              <EmptyState title="No messages in the last 14 days" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={a.volume} margin={{ right: 8 }}>
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#64748b" }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#64748b" }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="messages" stroke={BAR} strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Section>
        </div>

        <Section title="LLM usage & cost">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Total LLM cost" value={usd(a.llm.totalCostUsd)} />
            <Stat label="Avg cost per Claude chat" value={usd(a.llm.avgCostPerChatUsd)} hint={`${a.llm.claudeConversations} chats`} />
            <Stat label="Input / output tokens" value={`${(a.llm.inputTokens / 1000).toFixed(1)}k / ${(a.llm.outputTokens / 1000).toFixed(1)}k`} />
            <Stat label="Cache-read tokens" value={`${(a.llm.cacheReadTokens / 1000).toFixed(1)}k`} hint="served from prompt cache" />
            <Stat label="Avg AI reply latency" value={ms(a.aiLatency.avgMs)} hint={`Claude ${a.llm.repliesByEngine.claude} · mock ${a.llm.repliesByEngine.mock} replies`} />
          </div>
          <p className="mt-3 text-xs text-slate-500">{a.savedFromRto.definition}</p>
        </Section>
      </div>
    </div>
  );
}
