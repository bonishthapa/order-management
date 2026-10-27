import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useGet } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { FormDialog, FormField, FormGrid, useFormContext, useWatch } from "@/components/form";
import { BaseTable, FilterBar, SearchBox, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Page";
import { formatAmount, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";

export interface Account {
  id: number;
  code: string;
  name: string;
  account_type: AccountType;
  type_label: string;
  parent: number | null;
  parent_name: string | null;
  system_key: string;
  system_label: string;
  is_group: boolean;
  is_cash: boolean;
  is_bank: boolean;
  bank_name: string;
  bank_account_number: string;
  bank_branch: string;
  description: string;
  is_active: boolean;
  balance: string | null;
  has_postings: boolean;
}

type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "ASSET", label: "Assets" }, { value: "LIABILITY", label: "Liabilities" }, { value: "EQUITY", label: "Equity" },
  { value: "INCOME", label: "Income" }, { value: "EXPENSE", label: "Expenses" },
];
const TYPE_SINGULAR: Record<AccountType, string> = { ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expense" };

interface TreeRow { account: Account; depth: number; rollup: number; childCount: number }

/** Flattens the chart into display order (code order, children under their parent) with group roll-ups of the server balances. */
function buildTree(accounts: Account[], type: AccountType): TreeRow[] {
  const ofType = accounts.filter((a) => a.account_type === type);
  const ids = new Set(ofType.map((a) => a.id));
  const children = new Map<number | null, Account[]>();
  ofType.forEach((a) => {
    const parent = a.parent && ids.has(a.parent) ? a.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), a]);
  });
  children.forEach((list) => list.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })));
  const rows: TreeRow[] = [];
  const visit = (account: Account, depth: number): number => {
    const row: TreeRow = { account, depth, rollup: 0, childCount: children.get(account.id)?.length ?? 0 };
    rows.push(row);
    let total = toNumber(account.balance);
    (children.get(account.id) ?? []).forEach((child) => { total += visit(child, depth + 1); });
    row.rollup = Math.round(total * 100) / 100;
    return row.rollup;
  };
  (children.get(null) ?? []).forEach((a) => visit(a, 0));
  return rows;
}

type ChartRow =
  | { kind: "section"; id: string; label: string; total: number }
  | { kind: "account"; id: number; row: TreeRow };

const debitOf = (v: number) => (v > 0 ? formatAmount(v) : v === 0 ? <span className="text-slate-300">–</span> : "");
const creditOf = (v: number) => (v < 0 ? formatAmount(-v) : v === 0 ? <span className="text-slate-300">–</span> : "");
const amountOf = (r: ChartRow) => (r.kind === "section" ? r.total : r.row.account.is_group ? r.row.rollup : toNumber(r.row.account.balance));

export function AccountsPage() {
  const { can, session } = useAuth();
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(todayIn(session?.organization?.timezone));
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const query = useGet<Account[]>(["accounts", "chart"], "/accounts/", { as_of: asOf });
  const canManage = can("accounting.manage");
  const showBalances = can(["accounting.view", "reports.financial"]);

  const sections = useMemo(() => {
    const all = query.data ?? [];
    return ACCOUNT_TYPES.map((t) => ({ ...t, rows: buildTree(all, t.value) }));
  }, [query.data]);

  const term = search.trim().toLowerCase();
  const matches = (a: Account) => !term || a.code.toLowerCase().includes(term) || a.name.toLowerCase().includes(term);
  const isHidden = (row: TreeRow, rows: TreeRow[]) => {
    if (!showInactive && !row.account.is_active) return true;
    if (term) return !matches(row.account);
    let parent = row.account.parent;
    while (parent) {
      if (collapsed.has(parent)) return true;
      parent = rows.find((r) => r.account.id === parent)?.account.parent ?? null;
    }
    return false;
  };
  const toggle = (id: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const rows: ChartRow[] = sections.flatMap((section) => {
    const visible = section.rows.filter((r) => !isHidden(r, section.rows));
    if (!visible.length && term) return [];
    const total = Math.round(section.rows.filter((r) => r.depth === 0).reduce((s, r) => s + r.rollup, 0) * 100) / 100;
    return [{ kind: "section" as const, id: section.value, label: section.label, total },
      ...visible.map((row) => ({ kind: "account" as const, id: row.account.id, row }))];
  });

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/accounts/${deleting.id}/`);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success(`Account ${deleting.code} deleted`);
      setDeleting(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<ChartRow>[] = [
    col.custom("account", "Account", (r) => {
      if (r.kind === "section") return <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{r.label}</span>;
      const { account: a, depth, childCount } = r.row;
      return (
        <div className="flex items-center gap-1" style={{ paddingLeft: term ? 0 : depth * 18 }}>
          {a.is_group && childCount > 0 && !term ? (
            <button type="button" aria-label={collapsed.has(a.id) ? "Expand" : "Collapse"} className="rounded p-0.5 text-slate-400 hover:bg-surface-sunken"
              onClick={(e) => { e.stopPropagation(); toggle(a.id); }}>
              {collapsed.has(a.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : <span className="w-[18px]" />}
          <span className="w-14 shrink-0 tabular-nums text-slate-500">{a.code}</span>
          <span className={cn(a.is_group ? "font-semibold text-slate-800" : "text-slate-800", !a.is_active && "text-slate-400")}>{a.name}</span>
        </div>
      );
    }),
    col.custom("flags", "Flags", (r) => r.kind === "account" && (
      <div className="flex flex-wrap gap-1">
        {r.row.account.system_key && <Badge tone="blue">System</Badge>}
        {r.row.account.is_group && <Badge>Group</Badge>}
        {r.row.account.is_cash && <Badge tone="green">Cash</Badge>}
        {r.row.account.is_bank && <Badge tone="green">Bank</Badge>}
        {!r.row.account.is_active && <Badge tone="slate">Inactive</Badge>}
      </div>
    )),
    ...(showBalances ? [
      col.custom<ChartRow>("debit", "Debit", (r) => debitOf(amountOf(r)), { align: "right", width: 144 }),
      col.custom<ChartRow>("credit", "Credit", (r) => creditOf(amountOf(r)), { align: "right", width: 144 }),
    ] : []),
    ...(canManage ? [col.custom<ChartRow>("actions", "", (r) => r.kind === "account" && (
      <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" aria-label={`Edit ${r.row.account.code}`} onClick={() => setEditing(r.row.account)}><Pencil className="h-3.5 w-3.5" /></Button>
        {!r.row.account.system_key && !r.row.account.has_postings && r.row.childCount === 0 && (
          <Button size="sm" variant="ghost" aria-label={`Delete ${r.row.account.code}`} onClick={() => setDeleting(r.row.account)}><Trash2 className="h-3.5 w-3.5" /></Button>
        )}
      </div>
    ), { width: 80 })] : []),
  ];

  return (
    <>
      <PageHeader title="Chart of accounts" subtitle="Group accounts organise the chart; postings go to the accounts under them."
        actions={canManage && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>New account</Button>} />
      <div className="panel overflow-hidden">
        <FilterBar>
          <SearchBox value={search} onChange={setSearch} placeholder="Code or name…" />
          {showBalances && (
            <div className="flex items-center gap-2 text-[13px] text-slate-600">
              <span>Balances as of</span>
              <DatePicker compact value={asOf} onChange={(v) => setAsOf(v || todayIn(session?.organization?.timezone))} className="w-[160px]" />
            </div>
          )}
          <label className="flex h-8 items-center gap-1.5 rounded border border-line-strong bg-white px-2.5 text-[13px] text-slate-700">
            <input type="checkbox" className="accent-brand-600" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={() => setCollapsed(new Set())}>Expand all</Button>
            <Button variant="ghost" onClick={() => setCollapsed(new Set((query.data ?? []).filter((a) => a.is_group).map((a) => a.id)))}>Collapse all</Button>
          </div>
        </FilterBar>
        {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !query.data?.length ? (
          <EmptyState title="No accounts" description="The chart of accounts is created with the organisation." />
        ) : (
          <>
            <BaseTable<ChartRow> rows={rows} columns={columns} density="compact" minWidth={760} rowKey={(r) => `${r.kind}-${r.id}`}
              empty={{ title: "No matching accounts", description: "Try another code or name." }}
              rowClassName={(r) => cn(r.kind === "section" && "bg-surface-sunken/60",
                r.kind === "account" && !r.row.account.is_active && "text-slate-400",
                (r.kind === "section" || r.row.account.is_group) && "cursor-default")}
              onRowClick={showBalances ? (r) => { if (r.kind === "account" && !r.row.account.is_group) navigate(`/finance/accounts/${r.id}`); } : undefined} />
            {showBalances && <p className="border-t border-line px-3 py-2 text-xs text-slate-500">Balances include posted entries up to the selected date. Group totals add up the accounts beneath them.</p>}
          </>
        )}
      </div>
      {editing && <AccountDialog account={editing === "new" ? null : editing} accounts={query.data ?? []} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.code} ${deleting?.name}`} tone="danger"
        description="The account has no postings and no sub-accounts, so it can be removed. This is recorded in the audit trail."
        confirmLabel="Delete account" loading={busy} onConfirm={remove} />
    </>
  );
}

interface AccountValues {
  code: string; name: string; account_type: AccountType; parent: number | null; is_group: boolean; is_cash: boolean; is_bank: boolean;
  bank_name: string; bank_account_number: string; bank_branch: string; description: string; is_active: boolean;
}

function descendantsOf(id: number, accounts: Account[]): Set<number> {
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    accounts.forEach((a) => { if (a.parent && out.has(a.parent) && !out.has(a.id)) { out.add(a.id); grew = true; } });
  }
  return out;
}

/** Fields that depend on each other (type → parent groups, group → no cash/bank, cash ↔ bank). */
function AccountFields({ account, accounts }: { account: Account | null; accounts: Account[] }) {
  const { setValue } = useFormContext<AccountValues>();
  const [type, isGroup, isBank] = useWatch<AccountValues, ["account_type", "is_group", "is_bank"]>({ name: ["account_type", "is_group", "is_bank"] });
  const system = !!account?.system_key;
  const locked = !!account?.has_postings;
  const excluded = account ? descendantsOf(account.id, accounts) : new Set<number>();
  const parents = accounts.filter((a) => a.is_group && a.account_type === type && !excluded.has(a.id))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const hasChildren = !!account && accounts.some((a) => a.parent === account.id);
  const clearCashBank = () => { setValue("is_cash", false); setValue("is_bank", false); };

  return (
    <FormGrid>
      <FormField name="code" label="Code" required />
      <FormField name="name" label="Name" required />
      <FormField name="account_type" label="Type" type="select" required emptyOption={false} disabled={system || locked}
        options={ACCOUNT_TYPES.map((t) => ({ value: t.value, label: TYPE_SINGULAR[t.value] }))}
        onValueChange={(t) => { setValue("parent", null); if (t !== "ASSET") clearCashBank(); }} />
      <FormField name="parent" label="Parent group" type="select" emptyOption="Top level" hint="Only groups of the same type can be parents."
        options={parents.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))} />
      <FormField name="is_group" label="Group" type="checkbox" span="full" disabled={system || locked || (isGroup && hasChildren)}
        hint="Group account (organises the chart; cannot be posted to)" onValueChange={(v) => { if (v) clearCashBank(); }} />
      {type === "ASSET" && !isGroup && <>
        <FormField name="is_cash" label="Cash" type="checkbox" hint="Cash account" onValueChange={(v) => { if (v) setValue("is_bank", false); }} />
        <FormField name="is_bank" label="Bank" type="checkbox" hint="Bank account (can be reconciled)" onValueChange={(v) => { if (v) setValue("is_cash", false); }} />
      </>}
      {isBank && <>
        <FormField name="bank_name" label="Bank" />
        <FormField name="bank_branch" label="Branch" />
        <FormField name="bank_account_number" label="Account number" span="full" />
      </>}
      <FormField name="description" label="Description" type="textarea" rows={2} span="full" />
      <FormField name="is_active" label="Active" type="checkbox" span="full" disabled={system} hint="Active (inactive accounts cannot receive new postings)" />
    </FormGrid>
  );
}

function AccountDialog({ account, accounts, onClose }: { account: Account | null; accounts: Account[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const system = !!account?.system_key;
  const defaults: AccountValues = account ? {
    code: account.code, name: account.name, account_type: account.account_type, parent: account.parent, is_group: account.is_group,
    is_cash: account.is_cash, is_bank: account.is_bank, bank_name: account.bank_name, bank_account_number: account.bank_account_number,
    bank_branch: account.bank_branch, description: account.description, is_active: account.is_active,
  } : {
    code: "", name: "", account_type: "ASSET", parent: null, is_group: false, is_cash: false, is_bank: false, bank_name: "",
    bank_account_number: "", bank_branch: "", description: "", is_active: true,
  };

  const submit = async (v: AccountValues) => {
    const body: Record<string, unknown> = { ...v, code: v.code.trim(), name: v.name.trim() };
    if (!v.is_bank) Object.assign(body, { bank_name: "", bank_account_number: "", bank_branch: "" });
    if (system) { delete body.account_type; delete body.is_group; delete body.is_active; }
    if (account) await api.patch(`/accounts/${account.id}/`, body);
    else await api.post("/accounts/", body);
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
    toast.success(account ? `Account ${body.code} updated` : `Account ${body.code} created`);
  };

  return (
    <FormDialog<AccountValues> open onOpenChange={(o) => !o && onClose()} title={account ? `Edit ${account.code} ${account.name}` : "New account"}
      size="lg" submitLabel={account ? "Save changes" : "Create account"} defaultValues={defaults} onSubmit={submit}>
      {system && <Alert tone="info" className="mb-3" title={`System account: ${account?.system_label}`}>Posting rules depend on this account, so its type, group setting and active status are fixed.</Alert>}
      {!system && account?.has_postings && <Alert tone="info" className="mb-3">This account has postings: its type cannot change and it cannot become a group.</Alert>}
      <AccountFields account={account} accounts={accounts} />
    </FormDialog>
  );
}
