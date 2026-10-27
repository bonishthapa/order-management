import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useGet } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { FilterBar, SearchBox } from "@/components/data/Filters";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Select, Textarea } from "@/components/ui/Input";
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

function DebitCredit({ value }: { value: number }) {
  if (!value) return <><td className="num px-3 py-1.5 text-slate-300">–</td><td className="num px-3 py-1.5 text-slate-300">–</td></>;
  return value > 0
    ? <><td className="num px-3 py-1.5">{formatAmount(value)}</td><td className="num px-3 py-1.5" /></>
    : <><td className="num px-3 py-1.5" /><td className="num px-3 py-1.5">{formatAmount(-value)}</td></>;
}

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
    // hidden when any ancestor is collapsed
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Flags</th>
                  {showBalances && <><th className="w-36 px-3 py-2 text-right">Debit</th><th className="w-36 px-3 py-2 text-right">Credit</th></>}
                  {canManage && <th className="w-20 px-3 py-2" />}
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => {
                  const visible = section.rows.filter((r) => !isHidden(r, section.rows));
                  if (!visible.length && term) return null;
                  const sectionTotal = section.rows.filter((r) => r.depth === 0).reduce((s, r) => s + r.rollup, 0);
                  return (
                    <Fragment key={section.value}>
                      <tr className="border-b border-line bg-surface-sunken/60">
                        <th className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-600" colSpan={2}>{section.label}</th>
                        {showBalances && <DebitCredit value={Math.round(sectionTotal * 100) / 100} />}
                        {canManage && <td />}
                      </tr>
                      {visible.map(({ account: a, depth, rollup, childCount }) => (
                        <tr key={a.id} className={cn("border-b border-line hover:bg-surface-muted", !a.is_group && showBalances && "cursor-pointer", !a.is_active && "text-slate-400")}
                          onClick={() => !a.is_group && showBalances && navigate(`/finance/accounts/${a.id}`)}>
                          <td className="px-3 py-1.5">
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
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {a.system_key && <Badge tone="blue">System</Badge>}
                              {a.is_group && <Badge>Group</Badge>}
                              {a.is_cash && <Badge tone="green">Cash</Badge>}
                              {a.is_bank && <Badge tone="green">Bank</Badge>}
                              {!a.is_active && <Badge tone="slate">Inactive</Badge>}
                            </div>
                          </td>
                          {showBalances && <DebitCredit value={a.is_group ? rollup : toNumber(a.balance)} />}
                          {canManage && (
                            <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                              <div className="flex justify-end gap-0.5">
                                <Button size="sm" variant="ghost" aria-label={`Edit ${a.code}`} onClick={() => setEditing(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                                {!a.system_key && !a.has_postings && childCount === 0 && (
                                  <Button size="sm" variant="ghost" aria-label={`Delete ${a.code}`} onClick={() => setDeleting(a)}><Trash2 className="h-3.5 w-3.5" /></Button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {showBalances && <p className="px-3 py-2 text-xs text-slate-500">Balances include posted entries up to the selected date. Group totals add up the accounts beneath them.</p>}
          </div>
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

function AccountDialog({ account, accounts, onClose }: { account: Account | null; accounts: Account[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [v, setV] = useState<AccountValues>(account ? {
    code: account.code, name: account.name, account_type: account.account_type, parent: account.parent, is_group: account.is_group,
    is_cash: account.is_cash, is_bank: account.is_bank, bank_name: account.bank_name, bank_account_number: account.bank_account_number,
    bank_branch: account.bank_branch, description: account.description, is_active: account.is_active,
  } : {
    code: "", name: "", account_type: "ASSET", parent: null, is_group: false, is_cash: false, is_bank: false, bank_name: "",
    bank_account_number: "", bank_branch: "", description: "", is_active: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof AccountValues>(key: K, value: AccountValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const system = !!account?.system_key;
  const locked = !!account?.has_postings;
  const excluded = account ? descendantsOf(account.id, accounts) : new Set<number>();
  const parents = accounts.filter((a) => a.is_group && a.account_type === v.account_type && !excluded.has(a.id))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const hasChildren = !!account && accounts.some((a) => a.parent === account.id);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!v.code.trim()) e.code = "Enter an account code.";
    if (!v.name.trim()) e.name = "Enter an account name.";
    if ((v.is_cash || v.is_bank) && v.account_type !== "ASSET") e.is_cash = "Cash and bank accounts are assets.";
    if ((v.is_cash || v.is_bank) && v.is_group) e.is_cash = "Group accounts cannot be cash or bank accounts.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body: Record<string, unknown> = { ...v, code: v.code.trim(), name: v.name.trim() };
    if (!v.is_bank) Object.assign(body, { bank_name: "", bank_account_number: "", bank_branch: "" });
    if (system) { delete body.account_type; delete body.is_group; delete body.is_active; }
    try {
      if (account) await api.patch(`/accounts/${account.id}/`, body);
      else await api.post("/accounts/", body);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success(account ? `Account ${v.code} updated` : `Account ${v.code} created`);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={account ? `Edit ${account.code} ${account.name}` : "New account"} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={submit}>{account ? "Save changes" : "Create account"}</Button></>}>
      {system && <Alert tone="info" className="mb-3" title={`System account: ${account?.system_label}`}>Posting rules depend on this account, so its type, group setting and active status are fixed.</Alert>}
      {!system && locked && <Alert tone="info" className="mb-3">This account has postings: its type cannot change and it cannot become a group.</Alert>}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Code" required error={errors.code}><Input value={v.code} onChange={(e) => set("code", e.target.value)} invalid={!!errors.code} /></Field>
        <Field label="Name" required error={errors.name}><Input value={v.name} onChange={(e) => set("name", e.target.value)} invalid={!!errors.name} /></Field>
        <Field label="Type" required error={errors.account_type}>
          <Select value={v.account_type} disabled={system || locked}
            onChange={(e) => { const t = e.target.value as AccountType; setV((p) => ({ ...p, account_type: t, parent: null, ...(t !== "ASSET" ? { is_cash: false, is_bank: false } : {}) })); }}>
            {ACCOUNT_TYPES.map((t) => <option key={t.value} value={t.value}>{TYPE_SINGULAR[t.value]}</option>)}
          </Select>
        </Field>
        <Field label="Parent group" error={errors.parent} hint="Only groups of the same type can be parents.">
          <Select value={v.parent ?? ""} onChange={(e) => set("parent", e.target.value ? Number(e.target.value) : null)} invalid={!!errors.parent}>
            <option value="">Top level</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
          </Select>
        </Field>
        <div className="space-y-1.5 sm:col-span-2">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="accent-brand-600" checked={v.is_group} disabled={system || locked || (v.is_group && hasChildren)}
              onChange={(e) => setV((p) => ({ ...p, is_group: e.target.checked, ...(e.target.checked ? { is_cash: false, is_bank: false } : {}) }))} />
            Group account (organises the chart; cannot be posted to)
          </label>
          {errors.is_group && <p className="text-xs text-red-600">{errors.is_group}</p>}
          {v.account_type === "ASSET" && !v.is_group && (
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-brand-600" checked={v.is_cash} onChange={(e) => setV((p) => ({ ...p, is_cash: e.target.checked, ...(e.target.checked ? { is_bank: false } : {}) }))} />
                Cash account
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-brand-600" checked={v.is_bank} onChange={(e) => setV((p) => ({ ...p, is_bank: e.target.checked, ...(e.target.checked ? { is_cash: false } : {}) }))} />
                Bank account (can be reconciled)
              </label>
            </div>
          )}
          {(errors.is_cash || errors.is_bank) && <p className="text-xs text-red-600">{errors.is_cash ?? errors.is_bank}</p>}
        </div>
        {v.is_bank && <>
          <Field label="Bank" error={errors.bank_name}><Input value={v.bank_name} onChange={(e) => set("bank_name", e.target.value)} /></Field>
          <Field label="Branch" error={errors.bank_branch}><Input value={v.bank_branch} onChange={(e) => set("bank_branch", e.target.value)} /></Field>
          <Field label="Account number" error={errors.bank_account_number} className="sm:col-span-2">
            <Input value={v.bank_account_number} onChange={(e) => set("bank_account_number", e.target.value)} />
          </Field>
        </>}
        <Field label="Description" error={errors.description} className="sm:col-span-2">
          <Textarea value={v.description} onChange={(e) => set("description", e.target.value)} rows={2} />
        </Field>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" className="accent-brand-600" checked={v.is_active} disabled={system} onChange={(e) => set("is_active", e.target.checked)} />
          Active (inactive accounts cannot receive new postings)
        </label>
        {errors.is_active && <p className="text-xs text-red-600 sm:col-span-2">{errors.is_active}</p>}
      </div>
    </Dialog>
  );
}
