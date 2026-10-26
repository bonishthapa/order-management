import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useGet } from "@/api/hooks";
import type { AuditEvent, RelatedDocument } from "@/api/types";
import { DateText } from "@/calendar/DateText";
import { StatusBadge } from "@/components/ui/Badge";
import { LoadingBlock } from "@/components/ui/Feedback";
import { Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, titleCase } from "@/utils/format";
import { linkFor, TYPE_LABELS } from "@/utils/links";

function describe(event: AuditEvent) {
  const action = event.action.includes(".") ? event.action.split(".")[1] : event.action;
  return titleCase(action.replace(/_/g, " "));
}

/** Connected documents (order → delivery → invoice → receipt → journals) and the audit history of a document. */
export function DocumentTimeline({ resource, id }: { resource: string; id: number }) {
  const { data, isLoading } = useGet<{ events: AuditEvent[]; related: RelatedDocument[] }>([resource, "timeline", id], `/${resource}/${id}/timeline/`);
  if (isLoading) return <Panel title="Activity"><LoadingBlock /></Panel>;
  const related = data?.related ?? [];
  const events = data?.events ?? [];
  return (
    <div className="space-y-4">
      <Panel title="Connected documents">
        {related.length === 0 ? <p className="p-4 text-xs text-slate-500">None yet.</p> : (
          <ul className="divide-y divide-line">
            {related.map((d) => {
              const to = linkFor(d.type, d.id);
              const current = d.type && to && window.location.pathname === to;
              return (
                <li key={`${d.type}-${d.id}-${d.relation}`} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                  <span className="w-28 shrink-0 text-2xs uppercase tracking-wide text-slate-400">{d.relation}</span>
                  <span className="min-w-0 flex-1">
                    {to && !current ? <Link to={to} className="link font-medium">{d.number}</Link> : <span className="font-medium">{d.number}</span>}
                    <span className="ml-2 text-2xs text-slate-500">{TYPE_LABELS[d.type] ?? d.label}{d.label && TYPE_LABELS[d.type] ? ` · ${d.label}` : ""}</span>
                  </span>
                  {d.date && <DateText value={d.date} bs={d.date_bs} className="hidden text-xs text-slate-500 md:inline" />}
                  {d.amount && <span className="w-24 text-right tabular-nums text-xs">{formatAmount(d.amount)}</span>}
                  <StatusBadge status={d.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <Panel title="History">
        {events.length === 0 ? <p className="p-4 text-xs text-slate-500">No recorded activity.</p> : (
          <ol className="relative space-y-3 p-4 before:absolute before:bottom-4 before:left-[21px] before:top-4 before:w-px before:bg-line">
            {events.map((e) => (
              <li key={e.id} className="relative flex gap-3 pl-6 text-[13px]">
                <span className="absolute left-[3px] top-1.5 h-2 w-2 rounded-full border-2 border-white bg-brand-400 ring-1 ring-brand-200" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-slate-800">{describe(e)}</span>
                    <span className="text-xs text-slate-500">by {e.user_name ?? "system"}</span>
                  </div>
                  <div className="text-2xs text-slate-400">{formatDateTime(e.created_at)} · {e.date_bs} BS</div>
                  {e.reason && <div className="mt-0.5 text-xs text-slate-600">Reason: {e.reason}</div>}
                  {e.new_values && Object.keys(e.new_values).length > 0 && e.old_values && (
                    <div className="mt-1 space-y-0.5 text-2xs text-slate-500">
                      {Object.keys(e.new_values).slice(0, 6).map((k) => (
                        <div key={k}>{k.replace(/_/g, " ")}: <span className="line-through">{String(e.old_values?.[k] ?? "–")}</span>
                          <ArrowRight className="mx-1 inline h-2.5 w-2.5" />{String(e.new_values?.[k] ?? "–")}</div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
