import { useQuery } from "@tanstack/react-query";
import { FileBarChart2, Info } from "lucide-react";
import { Fragment, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/api/client";
import { cleanParams, useOptions } from "@/api/hooks";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { ExportMenu } from "@/components/data/ExportMenu";
import { PeriodFilter } from "@/components/data/Filters";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { useUrlState } from "@/hooks/useUrlState";
import { cn } from "@/utils/cn";
import { formatAmount, formatDate, formatPercent, formatQty } from "@/utils/format";
import { useAuth } from "@/auth/AuthContext";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ReportParam { name: string; label: string; type?: string; options?: [string, string][] }
interface ReportMeta { slug: string; title: string; basis: string; params: ReportParam[]; period: "range" | "as_of" | "none" }
interface Column { key: string; label: string; type: string }

export function useReportIndex() {
  return useQuery<{ group: string; reports: ReportMeta[] }[]>({ queryKey: ["reports", "index"], queryFn: async () => (await api.get("/reports/")).data, staleTime: 300_000 });
}

export function ReportsIndex() {
  const [params] = useSearchParams();
  const group = params.get("group");
  const { data, isLoading, error } = useReportIndex();
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorState error={error} />;
  const groups = (data ?? []).filter((g) => !group || g.group === group || (group === "Financial" && g.group === "Receivables & payables"));
  return (
    <>
      <PageHeader title={group ? `${group} reports` : "Reports"}
        subtitle="Every report is calculated from posted records and explains its basis. Revenue, cash received and profit are reported separately." />
      {groups.length === 0 && <EmptyState title="No reports available for your role" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <Panel key={g.group} title={g.group}>
            <ul className="divide-y divide-line">
              {g.reports.map((r) => (
                <li key={r.slug}>
                  <Link to={`/reports/${r.slug}`} className="flex gap-3 px-4 py-2.5 hover:bg-surface-muted">
                    <FileBarChart2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-slate-800">{r.title}</span>
                      <span className="line-clamp-2 block text-xs text-slate-500">{r.basis}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}

const LINK_ID_FIELDS: Record<string, string[]> = {
  customers: ["customer_id", "party_id"], suppliers: ["supplier_id", "party_id"], products: ["product_id"], accounts: ["account_id"],
  "stock-counts": ["count_id"],
};
const LINK_ROUTES: Record<string, string> = {
  customers: "/contacts/customers", suppliers: "/contacts/suppliers", products: "/inventory/products", accounts: "/finance/accounts",
  "sales-returns": "/sales/returns", "purchase-returns": "/purchases/returns", "sales-receipts": "/sales/receipts", "payment-vouchers": "/purchases/payments",
  expenses: "/finance/expenses", "stock-counts": "/inventory/counts",
};

function cellValue(col: Column, row: any, dateMode: any) {
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return "";
  switch (col.type) {
    case "money": return formatAmount(v);
    case "qty": return formatQty(v);
    case "percent": return formatPercent(v);
    case "date": return formatDate(v, dateMode, row[`${col.key}_bs`]);
    default: return String(v);
  }
}

function ParamControl({ param, values, set }: { param: ReportParam; values: Record<string, string>; set: (p: Record<string, string | null>) => void }) {
  const accounts = useOptions<any>("accounts", { is_group: "false" }, ["cash_account", "bank_account", "account"].includes(param.type ?? ""));
  if (param.options) {
    return (
      <Select aria-label={param.label} className="w-[150px]" value={values[param.name] ?? param.options[0][0]} onChange={(e) => set({ [param.name]: e.target.value })}>
        {param.options.map(([value, label]) => <option key={value} value={value}>{param.label}: {label}</option>)}
      </Select>
    );
  }
  if (param.type === "boolean") {
    return (
      <label className="flex h-8 items-center gap-1.5 rounded border border-line-strong bg-white px-2.5 text-[13px]">
        <input type="checkbox" className="accent-brand-600" checked={values[param.name] === "true"} onChange={(e) => set({ [param.name]: e.target.checked ? "true" : null })} />
        {param.label}
      </label>
    );
  }
  if (param.type === "warehouse") {
    return <div className="w-[200px]"><EntitySelect resource="warehouses" value={values[param.name] ? Number(values[param.name]) : null}
      onChange={(id) => set({ [param.name]: id ? String(id) : null })} placeholder="All warehouses" /></div>;
  }
  if (param.type && param.type.endsWith("account")) {
    const list = (accounts.data ?? []).filter((a: any) => param.type === "account" || (param.type === "cash_account" ? a.is_cash : a.is_bank));
    return (
      <Select aria-label={param.label} className="w-[230px]" value={values[param.name] ?? ""} onChange={(e) => set({ [param.name]: e.target.value })}>
        <option value="">{param.type === "account" ? "Accounts with activity" : "All accounts"}</option>
        {list.map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
      </Select>
    );
  }
  return <input className="control w-[170px]" placeholder={param.label} value={values[param.name] ?? ""} onChange={(e) => set({ [param.name]: e.target.value })} />;
}

export function ReportViewer() {
  const { slug } = useParams();
  const { dateMode } = useAuth();
  const index = useReportIndex();
  const { selected } = useFiscalYear();
  const [values, set] = useUrlState();
  const meta = index.data?.flatMap((g) => g.reports).find((r) => r.slug === slug);
  const fiscalYear = values.fiscal_year ?? (selected ? String(selected.id) : "");
  const requestParams = cleanParams({ ...values, fiscal_year: meta?.period === "range" && fiscalYear !== "all" ? fiscalYear : undefined });
  const report = useQuery<any>({
    queryKey: ["report", slug, requestParams],
    queryFn: async () => (await api.get(`/reports/${slug}/`, { params: requestParams })).data,
    enabled: !!meta,
  });
  const columns: Column[] = report.data?.columns ?? [];
  const chartData = useMemo(() => {
    const c = report.data?.chart;
    if (!c) return null;
    return report.data.rows.map((r: any) => Object.fromEntries([[c.x, r[c.x]], ...c.series.map((s: string) => [s, Number(r[s] ?? 0)])]));
  }, [report.data]);

  if (index.isLoading) return <LoadingBlock />;
  if (!meta) return <EmptyState title="Report not available" description="It does not exist or your role cannot view it." />;

  const linkFor = (col: Column, row: any): string | null => {
    const target = report.data?.links?.[col.key];
    if (!target || row.style) return null;
    const idField = (LINK_ID_FIELDS[target] ?? ["id"]).find((f) => row[f] !== undefined && row[f] !== null) ?? "id";
    return row[idField] ? `${LINK_ROUTES[target]}/${row[idField]}` : null;
  };
  const isNumeric = (c: Column) => ["money", "qty", "number", "percent"].includes(c.type);
  const seriesLabel = (key: string) => columns.find((c) => c.key === key)?.label ?? key;

  return (
    <>
      <PageHeader back={{ to: "/reports", label: "Reports" }} title={meta.title}
        actions={report.data && <ExportMenu url={`/reports/${slug}/`} params={requestParams} formats={["csv", "xlsx", "pdf"]} filename={slug} />} />
      <div className="panel mb-4">
        <div className="flex flex-wrap items-start gap-2 border-b border-line px-3 py-2.5">
          {meta.period === "range" && <PeriodFilter values={{ ...values, fiscal_year: fiscalYear }} set={set} />}
          {meta.period === "as_of" && (
            <div className="flex items-center gap-2 text-[13px] text-slate-600">As of
              <DatePicker compact className="w-[160px]" value={values.as_of ?? report.data?.as_of ?? ""} onChange={(v) => set({ as_of: v })} />
            </div>
          )}
          {meta.params.map((p) => <ParamControl key={p.name} param={p} values={values} set={set} />)}
        </div>
        <div className="flex gap-2 px-4 py-2.5 text-xs text-slate-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <div>
            <span className="font-medium text-slate-700">
              {meta.period === "range" && report.data?.range && (
                <>{report.data.range.start ? <DateText value={report.data.range.start} bs={report.data.range.start_bs} /> : "Beginning"} – {report.data.range.end
                  ? <DateText value={report.data.range.end} bs={report.data.range.end_bs} /> : "today"}{report.data.range.fiscal_year_name && ` · FY ${report.data.range.fiscal_year_name}`}. </>
              )}
              {meta.period === "as_of" && report.data?.as_of && <>As of <DateText value={report.data.as_of} bs={report.data.as_of_bs} />. </>}
            </span>
            {meta.basis}
          </div>
        </div>
      </div>

      {report.isLoading ? <LoadingBlock /> : report.error ? <ErrorState error={report.error} onRetry={() => report.refetch()} /> : (
        <>
          {report.data.summary && (
            <div className="panel mb-4 grid grid-cols-2 divide-x divide-line sm:grid-cols-5">
              {Object.entries(report.data.summary).map(([k, v]) => (
                <div key={k} className="px-4 py-2.5">
                  <div className="text-2xs uppercase tracking-wide text-slate-500">{k.replace(/_/g, " ")}</div>
                  <div className={cn("mt-0.5 text-[15px] font-semibold tabular-nums", Number(v) < 0 && "text-red-700")}>{formatAmount(v as string)}</div>
                </div>
              ))}
            </div>
          )}
          {chartData && chartData.length > 1 && (
            <Panel className="mb-4">
              <div className="h-56 px-2 py-3">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ left: 4, right: 8 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey={report.data.chart.x} tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#e2e5ea" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => formatAmount(v, 0)} />
                    <Tooltip formatter={(v: number, name: string) => [formatAmount(v), seriesLabel(name)]} contentStyle={{ fontSize: 12, borderRadius: 4 }} cursor={{ fill: "#f4f7fb" }} />
                    {report.data.chart.series.map((s: string, i: number) => (
                      <Bar key={s} dataKey={s} fill={i === 0 ? "#37567f" : "#8fa6c4"} radius={[2, 2, 0, 0]} maxBarSize={32} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}
          <Panel>
            {report.data.rows.length === 0 ? <EmptyState title="No records for this selection" description="Try a different period or filter." /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                    <tr>{columns.map((c) => <th key={c.key} className={cn("whitespace-nowrap px-3 py-2", isNumeric(c) && "text-right")}>{c.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {report.data.rows.map((row: any, i: number) => (
                      <tr key={i} className={cn("border-b border-line last:border-0",
                        row.style === "heading" && "bg-surface-muted font-semibold text-slate-800",
                        row.style === "subtotal" && "font-medium", (row.style === "total" || row.style === "grand") && "font-semibold",
                        row.style === "grand" && "border-t-2 border-slate-400")}>
                        {columns.map((c) => {
                          const href = linkFor(c, row);
                          const text = cellValue(c, row, dateMode);
                          return (
                            <td key={c.key} className={cn("px-3 py-1.5", isNumeric(c) && "num whitespace-nowrap", c.type === "date" && "whitespace-nowrap")}>
                              {href ? <Link className="hover:text-brand-700 hover:underline" to={href}>{text}</Link>
                                : c.key === columns[0].key && row.style && !text && row.label && !columns.some((x) => x.key === "label") ? row.label : text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  {report.data.totals && Object.keys(report.data.totals).length > 0 && (
                    <tfoot className="border-t-2 border-slate-300 bg-surface-muted font-semibold">
                      <tr>{columns.map((c, i) => (
                        <td key={c.key} className={cn("px-3 py-2", isNumeric(c) && "num whitespace-nowrap")}>
                          {i === 0 ? "Total" : report.data.totals[c.key] !== undefined ? cellValue(c, report.data.totals, dateMode) : ""}
                        </td>
                      ))}</tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </Panel>
          {report.data.details && report.data.details.length > 0 && (
            <Panel title="Open documents" className="mt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                    <tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Party</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2 text-right">Days overdue</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Outstanding</th></tr>
                  </thead>
                  <tbody>{report.data.details.map((d: any) => (
                    <Fragment key={d.id}>
                      <tr className="border-b border-line">
                        <td className="px-3 py-1.5"><Link className="link" to={`${slug === "payable-aging" ? "/purchases/bills" : "/sales/invoices"}/${d.id}`}>{d.number}</Link></td>
                        <td className="px-3 py-1.5">{d.party_name}</td>
                        <td className="px-3 py-1.5"><DateText value={d.date} /></td>
                        <td className="px-3 py-1.5"><DateText value={d.due_date} /></td>
                        <td className={cn("num px-3 py-1.5", d.days_overdue > 90 && "text-red-700")}>{d.days_overdue}</td>
                        <td className="num px-3 py-1.5">{formatAmount(d.total)}</td>
                        <td className="num px-3 py-1.5">{formatAmount(d.outstanding)}</td>
                      </tr>
                    </Fragment>
                  ))}</tbody>
                </table>
              </div>
            </Panel>
          )}
          {report.data.notes?.map((n: string) => <p key={n} className="mt-2 text-xs text-amber-700">{n}</p>)}
        </>
      )}
    </>
  );
}
