import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/api/client";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { useAuth } from "@/auth/AuthContext";
import { DateText } from "@/calendar/DateText";
import { BaseTable, col } from "@/components/table";
import { ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { PageHeader, Panel } from "@/components/ui/Page";
import { cn } from "@/utils/cn";
import { formatAmount, formatQty } from "@/utils/format";
import { linkFor, TYPE_LABELS } from "@/utils/links";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Data = Record<string, any>;

const compact = (v: number) => {
  const n = Math.abs(v);
  if (n >= 1e7) return `${(v / 1e7).toFixed(1)} Cr`;
  if (n >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
  if (n >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
};

function Metric({ label, value, note, to, tone }: { label: string; value: string; note?: React.ReactNode; to?: string; tone?: "negative" }) {
  const body = (
    <div className="min-w-0 px-4 py-3">
      <div className="text-2xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn("mt-1 truncate text-[17px] font-semibold tabular-nums text-slate-900", tone === "negative" && "text-red-700")}>{value}</div>
      {note && <div className="mt-0.5 truncate text-2xs text-slate-500">{note}</div>}
    </div>
  );
  return to ? <Link to={to} className="block hover:bg-surface-muted">{body}</Link> : body;
}

export function Dashboard() {
  const { can, session } = useAuth();
  const { selected } = useFiscalYear();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery<Data>({
    queryKey: ["dashboard", selected?.id],
    queryFn: async () => (await api.get("/reports/dashboard/", { params: { fiscal_year: selected?.id } })).data,
  });
  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const metrics: Parameters<typeof Metric>[0][] = [];
  if (data.sales) {
    metrics.push({ label: "Sales today", value: formatAmount(data.sales.today, 0), note: `${data.sales.today_count} invoice(s), excl. VAT`, to: "/sales/invoices" });
    metrics.push({ label: `Net sales FY ${data.fiscal_year?.name ?? ""}`, value: formatAmount(data.sales.period, 0), note: "Invoiced less returns, excl. VAT", to: "/reports/sales-by-date" });
  }
  if (data.purchases) metrics.push({ label: "Purchases", value: formatAmount(data.purchases.period, 0), note: "Supplier bills, excl. VAT", to: "/reports/purchases-by-date" });
  if (data.finance) {
    metrics.push({ label: "Gross profit", value: formatAmount(data.finance.gross_profit, 0), note: `Net sales − COGS ${formatAmount(data.finance.cogs, 0)}`,
      to: "/reports/gross-profit", tone: Number(data.finance.gross_profit) < 0 ? "negative" : undefined });
    metrics.push({ label: "Receivables", value: formatAmount(data.finance.receivables, 0), note: data.sales ? `${formatAmount(data.sales.overdue_amount, 0)} overdue` : undefined, to: "/reports/receivable-aging" });
    metrics.push({ label: "Payables", value: formatAmount(data.finance.payables, 0), note: data.purchases ? `${formatAmount(data.purchases.overdue_amount, 0)} overdue` : undefined, to: "/reports/payable-aging" });
    metrics.push({ label: "Cash and bank", value: formatAmount(data.finance.cash_total, 0), note: `${data.finance.cash_and_bank.length} accounts`, to: "/finance/cash-bank" });
  }
  if (data.inventory) metrics.push({ label: "Inventory value", value: formatAmount(data.inventory.value, 0), note: `${data.inventory.sku_in_stock} SKUs in stock · FIFO`, to: "/inventory/stock" });

  return (
    <>
      <PageHeader title="Dashboard"
        subtitle={<>{session?.organization?.name} · <DateText value={data.today} bs={data.today_bs} />{data.fiscal_year && <> · Fiscal year {data.fiscal_year.name}</>}</>} />
      {metrics.length > 0 && (
        <div className="panel mb-4 grid grid-cols-2 divide-x divide-y divide-line overflow-hidden sm:grid-cols-4 xl:grid-cols-8 xl:divide-y-0">
          {metrics.map((m) => <Metric key={m.label} {...m} />)}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        {data.trend && (
          <Panel title="Sales and purchases by month" className="xl:col-span-2"
            actions={<span className="text-2xs text-slate-500">BS months, excl. VAT</span>}>
            {data.trend.length === 0 ? <p className="p-6 text-center text-xs text-slate-500">No posted invoices or bills in this fiscal year yet.</p> : (
              <div className="h-64 px-2 py-3">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.trend.map((t: any) => ({ ...t, sales: Number(t.sales), purchases: Number(t.purchases) }))} barGap={2} margin={{ left: 4, right: 8 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#e2e5ea" }} />
                    <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={false} width={48} />
                    <Tooltip formatter={(v: number) => formatAmount(v)} cursor={{ fill: "#f4f7fb" }}
                      contentStyle={{ fontSize: 12, borderRadius: 4, border: "1px solid #e2e5ea" }} />
                    <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12 }} />
                    {data.sales && <Bar dataKey="sales" name="Sales" fill="#37567f" radius={[2, 2, 0, 0]} maxBarSize={28} />}
                    {data.purchases && <Bar dataKey="purchases" name="Purchases" fill="#a9b8cc" radius={[2, 2, 0, 0]} maxBarSize={28} />}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>
        )}
        <Panel title="Waiting for approval" actions={<span className="text-2xs text-slate-500">{data.approvals.length}</span>}>
          {data.approvals.length === 0 ? <p className="p-4 text-xs text-slate-500">Nothing is waiting for you.</p> : (
            <ul className="divide-y divide-line">
              {data.approvals.slice(0, 8).map((a: any) => (
                <li key={`${a.type}-${a.id}`}>
                  <Link to={linkFor(a.type, a.id) ?? "/"} className="flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-surface-muted">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-800">{a.number} <span className="font-normal text-slate-500">· {TYPE_LABELS[a.type]}</span></span>
                      <span className="block truncate text-2xs text-slate-500">{a.party}</span>
                    </span>
                    <span className="tabular-nums text-xs">{formatAmount(a.amount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {data.recent_invoices && (
          <Panel title="Recent invoices" className="xl:col-span-2" actions={<Link className="link text-xs" to="/sales/invoices">All invoices</Link>}>
            <BaseTable rows={data.recent_invoices} onRowClick={(i: any) => navigate(`/sales/invoices/${i.id}`)}
              empty={<p className="p-4 text-xs text-slate-500">No invoices posted yet.</p>} columns={[
                col.doc("number", "Invoice"),
                col.text("customer", "Customer", { maxWidth: 220, className: "truncate" }),
                col.date("date", "Date", { className: "hidden text-xs md:table-cell", headerClassName: "hidden md:table-cell" }),
                col.money("total", "Total"),
                col.money("balance_due", "Due"),
                col.status("payment_status", "Payment"),
              ]} />
          </Panel>
        )}
        {data.finance && (
          <Panel title="Cash and bank" actions={can("accounting.view") && <Link className="link text-xs" to="/finance/cash-bank">Details</Link>}>
            <ul className="divide-y divide-line">
              {data.finance.cash_and_bank.map((a: any) => (
                <li key={a.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                  <span className="truncate">{a.name}<span className="ml-1.5 text-2xs text-slate-400">{a.is_bank ? "Bank" : "Cash"}</span></span>
                  <span className={cn("tabular-nums", Number(a.balance) < 0 && "text-red-700")}>{formatAmount(a.balance)}</span>
                </li>
              ))}
              <li className="flex justify-between bg-surface-muted px-4 py-2 text-[13px] font-semibold">
                <span>Total</span><span className="tabular-nums">{formatAmount(data.finance.cash_total)}</span>
              </li>
            </ul>
          </Panel>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {data.low_stock && (
          <Panel title="Low stock" actions={<span className="text-2xs text-slate-500">{data.inventory.low_stock_count} at or below reorder level</span>}>
            <BaseTable rows={data.low_stock} density="compact"
              empty={<p className="p-4 text-xs text-slate-500">All products are above their reorder levels.</p>} columns={[
                col.custom("name", "Product", (p: any) => <Link className="hover:text-brand-700" to={`/inventory/products/${p.id}`}>{p.name}</Link>,
                  { maxWidth: 200, className: "truncate" }),
                col.custom("on_hand", "On hand", (p: any) => <span className={cn(Number(p.on_hand) <= 0 && "text-red-700")}>{formatQty(p.on_hand)} {p.unit}</span>,
                  { align: "right" }),
                col.qty("reorder_level", "Reorder at", { className: "text-slate-500" }),
              ]} />
          </Panel>
        )}
        {data.top_products && (
          <Panel title="Top products this year">
            <RankList rows={data.top_products.map((p: any) => ({ id: p.product_id, label: p.product, value: p.revenue, to: `/inventory/products/${p.product_id}` }))} />
          </Panel>
        )}
        {data.top_customers && (
          <Panel title="Top customers this year">
            <RankList rows={data.top_customers.map((c: any) => ({ id: c.customer_id, label: c.customer, value: c.revenue, to: `/contacts/customers/${c.customer_id}` }))} />
          </Panel>
        )}
      </div>
      {data.sales && (
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
          <Link className="hover:text-brand-700" to="/sales/orders?status=SUBMITTED">{data.sales.awaiting_approval} sales orders awaiting approval</Link>
          <Link className="hover:text-brand-700" to="/sales/orders?status=APPROVED">{data.sales.pending_orders} orders to deliver</Link>
          <Link className="hover:text-brand-700" to="/sales/invoices?overdue=true">{data.sales.overdue_count} overdue invoices</Link>
          {data.purchases && <Link className="hover:text-brand-700" to="/purchases/orders?status=APPROVED">{data.purchases.pending_orders} purchase orders awaiting receipt</Link>}
          {data.expenses && <Link className="hover:text-brand-700" to="/finance/expenses?status=SUBMITTED">{data.expenses.awaiting_approval} expenses awaiting approval</Link>}
        </div>
      )}
    </>
  );
}

function RankList({ rows }: { rows: { id: number; label: string; value: string; to: string }[] }) {
  if (!rows.length) return <p className="p-4 text-xs text-slate-500">No sales in this period yet.</p>;
  const max = Math.max(...rows.map((r) => Number(r.value)), 1);
  return (
    <ul className="space-y-2.5 p-4">
      {rows.map((r) => (
        <li key={r.id} className="text-[13px]">
          <div className="flex justify-between gap-3">
            <Link to={r.to} className="truncate hover:text-brand-700">{r.label}</Link>
            <span className="tabular-nums text-slate-600">{formatAmount(r.value, 0)}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-surface-sunken"><div className="h-1 rounded-full bg-brand-400" style={{ width: `${(Number(r.value) / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
