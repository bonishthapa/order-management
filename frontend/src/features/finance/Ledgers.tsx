import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useGet } from "@/api/hooks";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { DateText } from "@/calendar/DateText";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { DataGrid, ExportMenu, FilterBar, PeriodFilter, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Page";
import { useUrlState } from "@/hooks/useUrlState";
import { formatAmount } from "@/utils/format";
import { linkFor } from "@/utils/links";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LedgerRow {
  date: string;
  date_bs: string | null;
  journal_id: number;
  journal_number: string;
  source: string;
  source_id: number | null;
  source_number: string;
  source_link: string | null;
  narration: string;
  debit: number | string;
  credit: number | string;
  balance: number | string;
}

export interface LedgerRange {
  start: string | null;
  end: string | null;
  start_bs: string | null;
  end_bs: string | null;
  fiscal_year: number | null;
  fiscal_year_name: string | null;
}

export interface LedgerData {
  opening_balance: number | string;
  closing_balance: number | string;
  total_debit: number | string;
  total_credit: number | string;
  rows: LedgerRow[];
  range: LedgerRange;
  account?: { id: number; code: string; name: string; type: string; is_debit_normal: boolean };
}

/**
 * Fiscal year + AD/BS date range kept in the URL. Defaults to the fiscal year chosen in the top bar;
 * "all" removes the fiscal-year bound. Returns the params every ledger/period endpoint accepts.
 */
export function usePeriodState() {
  const [values, set] = useUrlState();
  const { selected } = useFiscalYear();
  const fiscalYear = values.fiscal_year ?? (selected ? String(selected.id) : "");
  const params: Record<string, string | undefined> = {
    fiscal_year: fiscalYear && fiscalYear !== "all" ? fiscalYear : undefined,
    date_from: values.date_from || undefined,
    date_to: values.date_to || undefined,
  };
  return { values: { ...values, fiscal_year: fiscalYear }, set, params };
}

/** Plain-text description of the period the server resolved. */
export function RangeText({ range }: { range: LedgerRange | undefined }) {
  if (!range) return null;
  if (!range.start && !range.end) return <span>All dates</span>;
  return (
    <span>
      {range.fiscal_year_name && <>FY {range.fiscal_year_name} · </>}
      {range.start ? <DateText value={range.start} bs={range.start_bs} /> : "Beginning"}
      {" – "}
      {range.end ? <DateText value={range.end} bs={range.end_bs} /> : "today"}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "muted" | "strong" }) {
  return (
    <div className="min-w-0">
      <div className="kv-label">{label}</div>
      <div className={cn("mt-0.5 tabular-nums text-[13px]", tone === "strong" && "text-sm font-semibold text-slate-900")}>{value}</div>
    </div>
  );
}

/**
 * Ledger body: opening, period totals, closing and a running-balance grid. Each row links to its journal
 * voucher and, where one exists, the source document.
 */
export function LedgerTable({ data, gridId, balanceHint, height = 560 }: {
  data: LedgerData; gridId: string; balanceHint?: ReactNode; height?: number | "auto";
}) {
  const rows = useMemo(() => data.rows.map((r, i) => ({ ...r, id: i + 1 })), [data.rows]);
  const columns = useMemo<TableColumn<LedgerRow & { id: number }>[]>(() => [
    col.date("date", "Date"),
    col.custom("journal_number", "Voucher", (r) => r.journal_id
      ? <Link className="link" to={`/finance/journals/${r.journal_id}`}>{r.journal_number}</Link> : <span>{r.journal_number}</span>, { minWidth: 160 }),
    col.custom("source_number", "Document", (r) => {
      if (!r.journal_id) return null;
      if (!r.source_number) return <span className="text-slate-400">–</span>;
      const to = linkFor(r.source_link, r.source_id);
      return to ? <Link className="link" to={to}>{r.source_number}</Link> : <span>{r.source_number}</span>;
    }, { minWidth: 160 }),
    col.text("narration", "Particulars", { flex: 3, minWidth: 220 }),
    col.money("debit", "Debit", { render: (r) => (Number(r.debit) ? formatAmount(r.debit) : "") }),
    col.money("credit", "Credit", { render: (r) => (Number(r.credit) ? formatAmount(r.credit) : "") }),
    col.money("balance", "Balance"),
  ], []);

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-line px-4 py-3 sm:grid-cols-4">
        <Stat label="Opening balance" value={formatAmount(data.opening_balance)} />
        <Stat label="Debits in period" value={formatAmount(data.total_debit)} />
        <Stat label="Credits in period" value={formatAmount(data.total_credit)} />
        <Stat label="Closing balance" value={formatAmount(data.closing_balance)} tone="strong" />
      </div>
      {balanceHint && <p className="border-b border-line px-4 py-2 text-xs text-slate-500">{balanceHint}</p>}
      {rows.length === 0 ? (
        <EmptyState title="No postings in this period" description="Change the period to see earlier or later entries." />
      ) : (
        <DataGrid id={gridId} columns={columns} rows={rows} height={height} total={rows.length}
          pinnedBottomRow={{ narration: "Period total / closing balance", debit: data.total_debit, credit: data.total_credit,
            balance: data.closing_balance }} />
      )}
    </div>
  );
}

/** Ledger of one posting account. Used at /finance/ledgers (``?account=``) and /finance/accounts/:id. */
export function LedgerPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { values, set, params } = usePeriodState();
  const accountId = id ?? search.get("account") ?? "";
  const query = useGet<LedgerData>(["accounts", "ledger", accountId], `/accounts/${accountId}/ledger/`, params, !!accountId);
  const data = query.data;

  const choose = (next: number | null) => {
    const keep = new URLSearchParams(search);
    keep.delete("account");
    if (id) {
      if (next) navigate({ pathname: `/finance/accounts/${next}`, search: keep.toString() });
      else navigate({ pathname: "/finance/ledgers", search: keep.toString() });
    } else {
      set({ account: next ? String(next) : null });
    }
  };

  const debitNormal = data?.account?.is_debit_normal;
  return (
    <>
      <PageHeader
        title={data?.account ? `${data.account.code} ${data.account.name}` : "Account ledger"}
        meta={data?.account && <Badge>{data.account.type.charAt(0) + data.account.type.slice(1).toLowerCase()}</Badge>}
        back={id ? { to: "/finance/accounts", label: "Chart of accounts" } : undefined}
        subtitle={data ? <RangeText range={data.range} /> : "Posted entries with running balance for any posting account."}
      />
      <div className="panel overflow-hidden">
        <FilterBar>
          <div className="w-full sm:w-72">
            <EntitySelect resource="accounts" params={{ is_group: "false" }} value={accountId ? Number(accountId) : null}
              onChange={(next) => choose(next)} placeholder="Choose an account…" clearable={!id} />
          </div>
          <PeriodFilter values={values} set={set} />
          <div className="ml-auto flex items-center gap-2">
            {accountId && <ExportMenu url={`/accounts/${accountId}/ledger/`} params={params}
              filename={`ledger-${data?.account?.code ?? accountId}`} />}
          </div>
        </FilterBar>
        {!accountId ? (
          <EmptyState title="Choose an account" description="Pick any posting account to see its ledger for the selected period." />
        ) : query.isLoading ? <LoadingBlock /> : query.error || !data ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <LedgerTable data={data} gridId="account-ledger"
            balanceHint={debitNormal === undefined ? undefined : debitNormal
              ? "Balances are debit balances (normal for assets and expenses); a negative figure is a credit balance."
              : "Balances are credit balances (normal for liabilities, equity and income); a negative figure is a debit balance."} />
        )}
      </div>
    </>
  );
}
