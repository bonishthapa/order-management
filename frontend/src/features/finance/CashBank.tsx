import { CheckSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useGet, useList, useOptions } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { DataTable } from "@/components/data/DataTable";
import { FilterBar, PeriodFilter } from "@/components/data/Filters";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select } from "@/components/ui/Input";
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
  const totals = rows.reduce((t, r) => ({
    opening: t.opening + toNumber(r.opening_balance), receipts: t.receipts + toNumber(r.receipts),
    payments: t.payments + toNumber(r.payments), closing: t.closing + toNumber(r.closing_balance),
  }), { opening: 0, receipts: 0, payments: 0, closing: 0 });

  return (
    <>
      <PageHeader title="Cash and bank" subtitle={query.data ? <RangeText range={query.data.range} /> : "Balances and movement of cash and bank accounts."}
        actions={can("accounting.manage") && <Button icon={<CheckSquare className="h-3.5 w-3.5" />} onClick={() => navigate("/finance/reconciliation")}>Reconcile bank</Button>} />
      <div className="panel overflow-hidden">
        <FilterBar><PeriodFilter values={values} set={set} /></FilterBar>
        {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !rows.length ? (
          <EmptyState title="No cash or bank accounts" description="Mark asset accounts as cash or bank in the chart of accounts." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2">Account</th><th className="px-4 py-2">Kind</th>
                  <th className="px-4 py-2 text-right">Opening</th><th className="px-4 py-2 text-right">Receipts</th>
                  <th className="px-4 py-2 text-right">Payments</th><th className="px-4 py-2 text-right">Closing</th>
                  <th className="px-4 py-2 text-right">Unreconciled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer border-b border-line hover:bg-surface-muted"
                    onClick={() => navigate({ pathname: `/finance/accounts/${r.id}`, search: search.toString() })}>
                    <td className="px-4 py-2"><span className="mr-2 tabular-nums text-slate-500">{r.code}</span><span className="font-medium">{r.name}</span>
                      {r.bank_name && <span className="ml-2 text-2xs text-slate-500">{r.bank_name}</span>}</td>
                    <td className="px-4 py-2">{r.is_bank ? <Badge tone="blue">Bank</Badge> : <Badge tone="green">Cash</Badge>}</td>
                    <td className="num px-4 py-2">{formatAmount(r.opening_balance)}</td>
                    <td className="num px-4 py-2">{formatAmount(r.receipts)}</td>
                    <td className="num px-4 py-2">{formatAmount(r.payments)}</td>
                    <td className={cn("num px-4 py-2 font-medium", toNumber(r.closing_balance) < 0 && "text-red-700")}>{formatAmount(r.closing_balance)}</td>
                    <td className="num px-4 py-2" onClick={(e) => e.stopPropagation()}>
                      {r.unreconciled === null ? <span className="text-slate-300">–</span> : r.unreconciled > 0 && can("accounting.manage")
                        ? <Link className="link" to={`/finance/reconciliation?account=${r.id}`}>{r.unreconciled}</Link> : r.unreconciled}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-muted font-semibold">
                <tr>
                  <td className="px-4 py-2" colSpan={2}>Total</td>
                  <td className="num px-4 py-2">{formatAmount(round2(totals.opening))}</td>
                  <td className="num px-4 py-2">{formatAmount(round2(totals.receipts))}</td>
                  <td className="num px-4 py-2">{formatAmount(round2(totals.payments))}</td>
                  <td className="num px-4 py-2">{formatAmount(round2(totals.closing))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <p className="px-4 py-2 text-xs text-slate-500">Negative closing balance on a bank account means it is overdrawn. Click an account to open its ledger.</p>
          </div>
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

export function ReconciliationPage() {
  const { session, can, dateMode } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const accounts = useOptions<BankAccount>("accounts", { is_bank: "true", is_group: "false" });
  const account = search.get("account") ? Number(search.get("account")) : null;
  const [statementDate, setStatementDate] = useState(todayIn(session?.organization?.timezone));
  const [statementBalance, setStatementBalance] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);

  useEffect(() => {
    if (!account && accounts.data?.length) {
      const first = accounts.data.find((a) => a.is_active) ?? accounts.data[0];
      setSearch({ account: String(first.id) }, { replace: true });
    }
  }, [accounts.data, account, setSearch]);

  const open = useGet<Unreconciled>(["bank-reconciliations", "unreconciled", account], "/bank-reconciliations/unreconciled/",
    { account: account ?? "", statement_date: statementDate }, !!account && !!statementDate);
  useEffect(() => setSelected(new Set()), [account, statementDate]);
  const history = useList<any>("bank-reconciliations", { account: account ?? "", page: historyPage, page_size: 10 }, { enabled: !!account });

  const lines = open.data?.lines ?? [];
  const selectedNet = useMemo(() => round2(lines.filter((l) => selected.has(l.id))
    .reduce((s, l) => s + toNumber(l.deposit) - toNumber(l.withdrawal), 0)), [lines, selected]);
  const previouslyCleared = toNumber(open.data?.cleared_balance);
  const clearedBalance = round2(previouslyCleared + selectedNet);
  const hasStatement = statementBalance.trim() !== "" && !Number.isNaN(Number(statementBalance));
  const difference = hasStatement ? round2(toNumber(statementBalance) - clearedBalance) : null;
  const allSelected = lines.length > 0 && selected.size === lines.length;

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!account) e.account = "Choose a bank account.";
    if (!statementDate) e.statement_date = "Enter the statement date.";
    if (!hasStatement) e.statement_balance = "Enter the closing balance shown on the bank statement.";
    if (!selected.size) e.cleared_lines = "Tick the entries that appear on the statement.";
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async () => {
    setSaving(true);
    try {
      await api.post("/bank-reconciliations/reconcile/", {
        account, statement_date: statementDate, statement_balance: statementBalance, cleared_lines: [...selected], notes,
      });
      ["bank-reconciliations", "accounts"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      toast.success(`${selected.size} entr${selected.size === 1 ? "y" : "ies"} reconciled`);
      setSelected(new Set());
      setNotes("");
      setConfirm(false);
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const historyColumns = useMemo(() => [
    col.date("statement_date", "Statement date", { dateMode }),
    col.text("account_name", "Account", { flex: 2 }),
    col.money("statement_balance", "Statement balance"),
    col.money("book_balance", "Book balance"),
    col.money("cleared_balance", "Cleared balance"),
    col.money("difference", "Difference", { cellClassRules: { "text-red-700": (p: any) => toNumber(p.value) !== 0 } }),
    col.number("cleared_count", "Entries", { maxWidth: 100 }),
    col.text("created_by_name", "By"),
  ], [dateMode]);

  const canReconcile = can("accounting.manage");
  return (
    <>
      <PageHeader title="Bank reconciliation" back={{ to: "/finance/cash-bank", label: "Cash and bank" }}
        subtitle="Tick the book entries that appear on the bank statement. Cleared balance should equal the statement balance." />
      <div className="space-y-4">
        <Panel title="Statement">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Bank account" required error={errors.account}>
              <Select value={account ?? ""} onChange={(e) => setSearch(e.target.value ? { account: e.target.value } : {}, { replace: true })}>
                <option value="">Choose…</option>
                {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
              </Select>
            </Field>
            <Field label="Statement date" required error={errors.statement_date}>
              <DatePicker value={statementDate} onChange={setStatementDate} invalid={!!errors.statement_date} />
            </Field>
            <Field label="Statement closing balance" required error={errors.statement_balance} hint="Overdrawn balances are negative.">
              <NumberInput value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} invalid={!!errors.statement_balance} />
            </Field>
            <Field label="Notes" error={errors.notes}><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
          {open.data && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line px-4 py-3 text-[13px] sm:grid-cols-5">
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
        </Panel>
        <Panel title="Uncleared entries" actions={canReconcile && (
          <Button variant="primary" disabled={!lines.length} onClick={() => validate() && setConfirm(true)}>Reconcile ticked entries</Button>
        )}>
          {errors.cleared_lines && <Alert tone="error" className="m-4">{errors.cleared_lines}</Alert>}
          {!account ? <EmptyState title="Choose a bank account" /> : open.isLoading ? <LoadingBlock /> : open.error ? (
            <ErrorState error={open.error} onRetry={() => open.refetch()} />
          ) : !lines.length ? (
            <EmptyState title="Everything is reconciled" description="No uncleared entries up to the statement date." />
          ) : (
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead className="sticky top-0 border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2">
                      <input type="checkbox" className="accent-brand-600" aria-label="Tick all" checked={allSelected} disabled={!canReconcile}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))} />
                    </th>
                    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Voucher</th><th className="px-3 py-2">Document</th>
                    <th className="px-3 py-2">Particulars</th><th className="px-3 py-2 text-right">Deposit</th><th className="px-3 py-2 text-right">Withdrawal</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className={cn("border-b border-line", selected.has(l.id) && "bg-brand-50/60", canReconcile && "cursor-pointer")}
                      onClick={() => canReconcile && toggle(l.id)}>
                      <td className="px-3 py-1.5">
                        <input type="checkbox" className="accent-brand-600" aria-label={`Tick ${l.journal_number}`} checked={selected.has(l.id)}
                          disabled={!canReconcile} onClick={(e) => e.stopPropagation()} onChange={() => toggle(l.id)} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5"><DateText value={l.date} bs={l.date_bs} /></td>
                      <td className="px-3 py-1.5">{l.journal_number}</td>
                      <td className="px-3 py-1.5">{l.source_number || "–"}</td>
                      <td className="px-3 py-1.5">{l.narration}</td>
                      <td className="num px-3 py-1.5">{toNumber(l.deposit) ? formatAmount(l.deposit) : ""}</td>
                      <td className="num px-3 py-1.5">{toNumber(l.withdrawal) ? formatAmount(l.withdrawal) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Reconciliation history">
          {account ? (
            <DataTable id="reconciliation-history" columns={historyColumns} rows={history.data?.results} total={history.data?.count}
              page={historyPage} pageSize={10} onPageChange={setHistoryPage} loading={history.isLoading} fetching={history.isFetching}
              error={history.error} onRetry={() => history.refetch()}
              empty={{ title: "No reconciliations yet", description: "Completed reconciliations of this account appear here." }} />
          ) : <p className="p-4 text-xs text-slate-500">Choose a bank account.</p>}
        </Panel>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Reconcile ticked entries" loading={saving} onConfirm={submit}
        confirmLabel="Reconcile"
        description={<>
          {selected.size} entr{selected.size === 1 ? "y is" : "ies are"} marked cleared as of the statement date. Cleared balance {formatAmount(clearedBalance)};
          statement balance {formatAmount(statementBalance)}.
          {difference !== null && difference !== 0 && <span className="mt-2 block font-medium text-red-700">
            Difference of {formatAmount(difference)} remains. It is recorded with the reconciliation; check for missing bank charges or deposits.
          </span>}
        </>} />
    </>
  );
}
