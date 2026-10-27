import { CheckSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useGet, useList, useOptions } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { BaseForm, FormField, FormSection, useFormContext, useWatch } from "@/components/form";
import { BaseTable, DataGrid, FilterBar, PeriodFilter, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, round2, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { RangeText, usePeriodState, type LedgerRange } from "./Ledgers";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CashBankRow {
  id: number; code: string; name: string; is_cash: boolean; is_bank: boolean; bank_name: string;
  opening_balance: number | string; receipts: number | string; payments: number | string; closing_balance: number | string;
  unreconciled: number | null;
}

export function CashBankPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search] = useSearchParams();
  const { values, set, params } = usePeriodState();
  const query = useGet<{ range: LedgerRange; accounts: CashBankRow[] }>(["accounts", "cash-bank"], "/accounts/cash-bank/", params);
  const rows = query.data?.accounts ?? [];
  const sum = (key: keyof CashBankRow) => formatAmount(round2(rows.reduce((t, r) => t + toNumber(r[key] as number), 0)));

  const columns: TableColumn<CashBankRow>[] = [
    col.custom("name", "Account", (r) => <>
      <span className="mr-2 tabular-nums text-slate-500">{r.code}</span><span className="font-medium">{r.name}</span>
      {r.bank_name && <span className="ml-2 text-2xs text-slate-500">{r.bank_name}</span>}
    </>, { footer: "Total" }),
    col.custom("kind", "Kind", (r) => (r.is_bank ? <Badge tone="blue">Bank</Badge> : <Badge tone="green">Cash</Badge>)),
    col.money("opening_balance", "Opening", { footer: sum("opening_balance") }),
    col.money("receipts", "Receipts", { footer: sum("receipts") }),
    col.money("payments", "Payments", { footer: sum("payments") }),
    col.money("closing_balance", "Closing", {
      footer: sum("closing_balance"),
      render: (r) => <span className={cn("font-medium", toNumber(r.closing_balance) < 0 && "text-red-700")}>{formatAmount(r.closing_balance)}</span>,
    }),
    col.number("unreconciled", "Unreconciled", {
      render: (r) => (r.unreconciled === null ? <span className="text-slate-300">–</span> : r.unreconciled > 0 && can("accounting.manage")
        ? <Link className="link" to={`/finance/reconciliation?account=${r.id}`} onClick={(e) => e.stopPropagation()}>{r.unreconciled}</Link>
        : r.unreconciled),
    }),
  ];

  return (
    <>
      <PageHeader title="Cash and bank" subtitle={query.data ? <RangeText range={query.data.range} /> : "Balances and movement of cash and bank accounts."}
        actions={can("accounting.manage") && <Button icon={<CheckSquare className="h-3.5 w-3.5" />} onClick={() => navigate("/finance/reconciliation")}>Reconcile bank</Button>} />
      <div className="panel overflow-hidden">
        <FilterBar><PeriodFilter values={values} set={set} /></FilterBar>
        {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : (
          <>
            <BaseTable rows={rows} columns={columns} footer minWidth={820}
              onRowClick={(r) => navigate({ pathname: `/finance/accounts/${r.id}`, search: search.toString() })}
              empty={{ title: "No cash or bank accounts", description: "Mark asset accounts as cash or bank in the chart of accounts." }} />
            {rows.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-slate-500">Negative closing balance on a bank account means it is overdrawn. Click an account to open its ledger.</p>}
          </>
        )}
      </div>
    </>
  );
}

interface BankAccount { id: number; code: string; name: string; is_bank: boolean; is_active: boolean }
interface UnreconciledLine {
  id: number; date: string; date_bs: string | null; journal_number: string; source_number: string; narration: string;
  deposit: number | string; withdrawal: number | string;
}
interface Unreconciled {
  account: { id: number; name: string }; statement_date: string; book_balance: number | string; cleared_balance: number | string;
  lines: UnreconciledLine[];
}
interface ReconcileValues {
  account: number | null; statement_date: string; statement_balance: string; notes: string; cleared_lines: number[];
}

/** Live summary and the tick list; both read the statement fields of the surrounding BaseForm. */
interface Summary { cleared: number; difference: number | null }

function UnreconciledLines({ canReconcile, summaryRef }: { canReconcile: boolean; summaryRef: { current: Summary } }) {
  const { setValue, formState } = useFormContext<ReconcileValues>();
  const [account, statementDate, statementBalance, cleared] = useWatch<ReconcileValues, ["account", "statement_date", "statement_balance", "cleared_lines"]>({
    name: ["account", "statement_date", "statement_balance", "cleared_lines"],
  });
  const selected = useMemo(() => new Set(cleared ?? []), [cleared]);
  const open = useGet<Unreconciled>(["bank-reconciliations", "unreconciled", account], "/bank-reconciliations/unreconciled/",
    { account: account ?? "", statement_date: statementDate }, !!account && !!statementDate);
  useEffect(() => setValue("cleared_lines", []), [account, statementDate, setValue]);

  const lines = open.data?.lines ?? [];
  const selectedNet = round2(lines.filter((l) => selected.has(l.id)).reduce((s, l) => s + toNumber(l.deposit) - toNumber(l.withdrawal), 0));
  const previouslyCleared = toNumber(open.data?.cleared_balance);
  const clearedBalance = round2(previouslyCleared + selectedNet);
  const hasStatement = statementBalance?.trim() !== "" && !Number.isNaN(Number(statementBalance));
  const difference = hasStatement ? round2(toNumber(statementBalance) - clearedBalance) : null;
  const allSelected = lines.length > 0 && selected.size === lines.length;
  summaryRef.current = { cleared: clearedBalance, difference };
  const setSelected = (next: Set<number>) => setValue("cleared_lines", [...next], { shouldDirty: true });
  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const clearedError = (formState.errors.cleared_lines as { message?: string } | undefined)?.message;

  const columns: TableColumn<UnreconciledLine>[] = [
    {
      key: "tick", width: 40,
      header: <input type="checkbox" className="accent-brand-600" aria-label="Tick all" checked={allSelected} disabled={!canReconcile}
        onChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))} />,
      render: (l) => (
        <input type="checkbox" className="accent-brand-600" aria-label={`Tick ${l.journal_number}`} checked={selected.has(l.id)}
          disabled={!canReconcile} onClick={(e) => e.stopPropagation()} onChange={() => toggle(l.id)} />
      ),
    },
    col.date("date", "Date"),
    col.text("journal_number", "Voucher"),
    col.text("source_number", "Document", { render: (l) => l.source_number || "–" }),
    col.text("narration", "Particulars"),
    col.money("deposit", "Deposit", { render: (l) => (toNumber(l.deposit) ? formatAmount(l.deposit) : "") }),
    col.money("withdrawal", "Withdrawal", { render: (l) => (toNumber(l.withdrawal) ? formatAmount(l.withdrawal) : "") }),
  ];

  return (
    <>
      {open.data && (
        <div className="panel grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 text-[13px] sm:grid-cols-5">
          <div><div className="kv-label">Book balance</div><div className="mt-0.5 tabular-nums">{formatAmount(open.data.book_balance)}</div></div>
          <div><div className="kv-label">Previously cleared</div><div className="mt-0.5 tabular-nums">{formatAmount(previouslyCleared)}</div></div>
          <div><div className="kv-label">Ticked now ({selected.size})</div><div className="mt-0.5 tabular-nums">{formatAmount(selectedNet)}</div></div>
          <div><div className="kv-label">Cleared balance</div><div className="mt-0.5 font-semibold tabular-nums">{formatAmount(clearedBalance)}</div></div>
          <div><div className="kv-label">Difference</div>
            <div className={cn("mt-0.5 font-semibold tabular-nums", difference === null ? "text-slate-400" : difference === 0 ? "text-emerald-700" : "text-red-700")}>
              {difference === null ? "Enter statement balance" : formatAmount(difference)}
            </div>
          </div>
        </div>
      )}
      <Panel title="Uncleared entries">
        {clearedError && <Alert tone="error" className="m-4">{clearedError}</Alert>}
        {!account ? <EmptyState title="Choose a bank account" /> : open.isLoading ? <LoadingBlock /> : open.error ? (
          <ErrorState error={open.error} onRetry={() => open.refetch()} />
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <BaseTable rows={lines} columns={columns} density="compact" minWidth={760} stickyHeader
              rowClassName={(l) => cn(selected.has(l.id) && "bg-brand-50/60")}
              onRowClick={canReconcile ? (l) => toggle(l.id) : undefined}
              empty={{ title: "Everything is reconciled", description: "No uncleared entries up to the statement date." }} />
          </div>
        )}
      </Panel>
    </>
  );
}

/** Keeps ?account= in the URL in sync with the form and preselects the first bank account. */
function AccountSync({ accounts }: { accounts: BankAccount[] }) {
  const { setValue } = useFormContext<ReconcileValues>();
  const account = useWatch<ReconcileValues, "account">({ name: "account" });
  const [, setSearch] = useSearchParams();
  useEffect(() => {
    if (!account && accounts.length) setValue("account", (accounts.find((a) => a.is_active) ?? accounts[0]).id);
  }, [account, accounts, setValue]);
  useEffect(() => { if (account) setSearch({ account: String(account) }, { replace: true }); }, [account, setSearch]);
  return null;
}

function History({ account }: { account: number | null }) {
  const [page, setPage] = useState(1);
  const history = useList<any>("bank-reconciliations", { account: account ?? "", page, page_size: 10 }, { enabled: !!account });
  const columns = useMemo<TableColumn[]>(() => [
    col.date("statement_date", "Statement date"),
    col.text("account_name", "Account", { flex: 2 }),
    col.money("statement_balance", "Statement balance"),
    col.money("book_balance", "Book balance"),
    col.money("cleared_balance", "Cleared balance"),
    col.money("difference", "Difference", {
      render: (r: any) => <span className={cn(toNumber(r.difference) !== 0 && "text-red-700")}>{formatAmount(r.difference)}</span>,
    }),
    col.number("cleared_count", "Entries", { width: 100 }),
    col.text("created_by_name", "By"),
  ], []);
  return (
    <Panel title="Reconciliation history">
      {account ? (
        <DataGrid id="reconciliation-history" columns={columns} rows={history.data?.results} total={history.data?.count}
          page={page} pageSize={10} onPageChange={setPage} loading={history.isLoading} fetching={history.isFetching}
          error={history.error} onRetry={() => history.refetch()}
          empty={{ title: "No reconciliations yet", description: "Completed reconciliations of this account appear here." }} />
      ) : <p className="p-4 text-xs text-slate-500">Choose a bank account.</p>}
    </Panel>
  );
}

export function ReconciliationPage() {
  const { session, can } = useAuth();
  const queryClient = useQueryClient();
  const [search] = useSearchParams();
  const accounts = useOptions<BankAccount>("accounts", { is_bank: "true", is_group: "false" });
  const canReconcile = can("accounting.manage");
  const summaryRef = useRef<Summary>({ cleared: 0, difference: null });
  const [confirm, setConfirm] = useState<null | { values: ReconcileValues; resolve: (ok: boolean) => void }>(null);
  const defaults = useRef<ReconcileValues>({
    account: search.get("account") ? Number(search.get("account")) : null, statement_date: todayIn(session?.organization?.timezone),
    statement_balance: "", notes: "", cleared_lines: [],
  }).current;

  const submit = async (v: ReconcileValues, form: any) => {
    if (!v.cleared_lines.length) {
      form.setError("cleared_lines", { type: "manual", message: "Tick the entries that appear on the statement." });
      throw new Error("Tick the entries that appear on the statement.");
    }
    const ok = await new Promise<boolean>((resolve) => setConfirm({ values: v, resolve }));
    setConfirm(null);
    if (!ok) return;
    await api.post("/bank-reconciliations/reconcile/", v);
    ["bank-reconciliations", "accounts"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    toast.success(`${v.cleared_lines.length} entr${v.cleared_lines.length === 1 ? "y" : "ies"} reconciled`);
    form.reset({ ...v, cleared_lines: [], notes: "" });
  };

  const n = confirm?.values.cleared_lines.length ?? 0;
  return (
    <>
      <PageHeader title="Bank reconciliation" back={{ to: "/finance/cash-bank", label: "Cash and bank" }}
        subtitle="Tick the book entries that appear on the bank statement. Cleared balance should equal the statement balance." />
      <BaseForm<ReconcileValues> defaultValues={defaults} onSubmit={submit} warnUnsaved={false}
        submitActions={canReconcile ? [{ key: "submit", label: "Reconcile ticked entries", primary: true }] : []}>
        <AccountSync accounts={accounts.data ?? []} />
        <FormSection title="Statement">
          <FormField name="account" label="Bank account" type="select" required
            options={(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} />
          <FormField name="statement_date" label="Statement date" type="date" required />
          <FormField name="statement_balance" label="Statement closing balance" type="money" required hint="Overdrawn balances are negative." />
          <FormField name="notes" label="Notes" />
        </FormSection>
        <UnreconciledLines canReconcile={canReconcile} summaryRef={summaryRef} />
      </BaseForm>
      <div className="mt-4"><History account={search.get("account") ? Number(search.get("account")) : null} /></div>
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => { if (!o) confirm?.resolve(false); }} title="Reconcile ticked entries"
        confirmLabel="Reconcile" onConfirm={() => confirm?.resolve(true)}
        description={<>
          {n} entr{n === 1 ? "y is" : "ies are"} marked cleared as of the statement date. Cleared balance {formatAmount(summaryRef.current.cleared)};
          statement balance {formatAmount(confirm?.values.statement_balance)}.
          {summaryRef.current.difference !== null && summaryRef.current.difference !== 0 && <span className="mt-2 block font-medium text-red-700">
            Difference of {formatAmount(summaryRef.current.difference)} remains. It is recorded with the reconciliation; check for missing bank charges or deposits.
          </span>}
        </>} />
    </>
  );
}
