import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../lib/api";
import type { AuditRow } from "../lib/types";
import { dateTime } from "../lib/format";
import { Badge, Collapsible, EmptyState, ErrorState, JsonView, Loading } from "../components/ui";
import { PageHeader } from "../components/Layout";

const TYPES = ["", "order", "cod", "shipment", "conversation", "return", "courier", "settings"];

export function AuditPage() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const r = useQuery({
    queryKey: ["audit", q, type, page],
    queryFn: () => api.get<{ rows: AuditRow[]; total: number; page: number; pageSize: number }>(`/api/audit-logs?q=${encodeURIComponent(q)}&entityType=${type}&page=${page}`),
  });
  const pages = r.data ? Math.max(1, Math.ceil(r.data.total / r.data.pageSize)) : 1;
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every change made by the agent, the system, the courier and support staff — personal data is masked" />
      <div className="space-y-3 p-4 lg:p-6">
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <input className="input w-64 pl-8" placeholder="Order no., AWB, action, actor…" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search audit log" />
          </div>
          <select className="input w-auto" value={type} onChange={(e) => (setType(e.target.value), setPage(1))} aria-label="Entity type">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t || "All entities"}
              </option>
            ))}
          </select>
        </div>
        <div className="card overflow-x-auto">
          {r.isLoading && <Loading />}
          {r.isError && <ErrorState error={r.error} onRetry={() => r.refetch()} />}
          {r.data?.rows.length === 0 && <EmptyState title="No audit entries match" />}
          {r.data && r.data.rows.length > 0 && (
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-slate-100 bg-slate-50/60">
                <tr>
                  <th className="th w-40">When</th>
                  <th className="th w-40">Actor</th>
                  <th className="th">Entity</th>
                  <th className="th">Change</th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="td text-xs text-slate-500">{dateTime(a.createdAt)}</td>
                    <td className="td">
                      <Badge tone={a.actor === "ai" ? "violet" : a.actor.startsWith("human") ? "amber" : a.actor === "courier" ? "blue" : "slate"}>{a.actor}</Badge>
                    </td>
                    <td className="td text-xs">
                      <div className="font-medium text-slate-700">{a.entityType}</div>
                      <div className="font-mono text-slate-500">{a.entityId.length > 20 ? `${a.entityId.slice(0, 18)}…` : a.entityId}</div>
                    </td>
                    <td className="td">
                      <Collapsible title={<code className="text-xs font-semibold">{a.action}</code>}>
                        <JsonView value={{ old: a.oldValue, new: a.newValue, meta: a.meta }} />
                      </Collapsible>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-slate-500">
            Page {page} of {pages} · {r.data?.total ?? 0} entries
          </span>
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button className="btn-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
