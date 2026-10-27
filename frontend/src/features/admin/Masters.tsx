import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useOptions, type Params } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { useStoredState } from "@/hooks/useStoredState";
import { cn } from "@/utils/cn";
import { formatPercent } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any> & { id: number; is_active: boolean };

interface AccountOption { id: number; code: string; name: string; is_cash: boolean; is_bank: boolean; is_active: boolean }

type FieldDef =
  | { name: string; label: string; type: "text"; required?: boolean; maxLength?: number; hint?: string; upper?: boolean; wide?: boolean }
  | { name: string; label: string; type: "textarea"; hint?: string }
  | { name: string; label: string; type: "number"; required?: boolean; hint?: string; suffix?: string }
  | { name: string; label: string; type: "checkbox"; hint?: string }
  | { name: string; label: string; type: "select"; required?: boolean; options: { value: string; label: string }[] }
  | { name: string; label: string; type: "account"; required?: boolean; params: Params; filter?: (a: AccountOption) => boolean; hint?: string };

interface ColumnDef { label: string; render: (row: Row) => ReactNode; align?: "right" }

interface MasterConfig {
  key: string;
  label: string;
  resource: string;
  singular: string;
  description: string;
  perm: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  defaults: Record<string, unknown>;
}

const PAYMENT_KINDS = [
  { value: "CASH", label: "Cash" }, { value: "BANK", label: "Bank transfer" }, { value: "CHEQUE", label: "Cheque" },
  { value: "CARD", label: "Card" }, { value: "WALLET", label: "Digital wallet" },
];

const yesNo = (v: boolean) => (v ? "Yes" : <span className="text-slate-400">No</span>);

const MASTERS: MasterConfig[] = [
  {
    key: "tax", label: "Tax rates", resource: "tax-rates", singular: "tax rate", perm: "settings.manage",
    description: "VAT and other rates offered on document lines. The default rate is preselected on new lines.",
    columns: [
      { label: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
      { label: "Rate", render: (r) => formatPercent(r.rate), align: "right" },
      { label: "Default", render: (r) => (r.is_default ? <Badge tone="blue">Default</Badge> : "") },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true, maxLength: 60 },
      { name: "rate", label: "Rate", type: "number", required: true, suffix: "%" },
      { name: "is_default", label: "Default rate for new lines", type: "checkbox" },
    ],
    defaults: { name: "", rate: "", is_default: false, is_active: true },
  },
  {
    key: "units", label: "Units", resource: "units", singular: "unit", perm: "settings.manage",
    description: "Units of measure for products. Fractional quantities are allowed only where enabled.",
    columns: [
      { label: "Code", render: (r) => <span className="font-medium">{r.code}</span> },
      { label: "Name", render: (r) => r.name },
      { label: "Fractions", render: (r) => yesNo(r.allow_fractions) },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true, maxLength: 12, upper: true },
      { name: "name", label: "Name", type: "text", required: true, maxLength: 60 },
      { name: "allow_fractions", label: "Allow fractional quantities (e.g. 2.5 kg)", type: "checkbox" },
    ],
    defaults: { code: "", name: "", allow_fractions: false, is_active: true },
  },
  {
    key: "payment", label: "Payment methods", resource: "payment-methods", singular: "payment method", perm: "settings.manage",
    description: "How money is received or paid. Choosing a method preselects its default cash or bank account.",
    columns: [
      { label: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
      { label: "Kind", render: (r) => PAYMENT_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind },
      { label: "Default account", render: (r) => r.default_account_name ?? <span className="text-slate-400">None</span> },
      { label: "Reference required", render: (r) => yesNo(r.requires_reference) },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true, maxLength: 60 },
      { name: "kind", label: "Kind", type: "select", required: true, options: PAYMENT_KINDS },
      { name: "default_account", label: "Default cash / bank account", type: "account", params: { is_group: "false", is_active: "true" },
        filter: (a) => a.is_cash || a.is_bank, hint: "Only cash and bank accounts can be chosen." },
      { name: "requires_reference", label: "Require a transaction reference (cheque or transfer number)", type: "checkbox" },
    ],
    defaults: { name: "", kind: "CASH", default_account: null, requires_reference: false, is_active: true },
  },
  {
    key: "branches", label: "Branches", resource: "branches", singular: "branch", perm: "settings.manage",
    description: "Branches group warehouses and can appear in document numbers.",
    columns: [
      { label: "Code", render: (r) => <span className="font-medium">{r.code}</span> },
      { label: "Name", render: (r) => r.name },
      { label: "Address", render: (r) => r.address || <span className="text-slate-400">–</span> },
      { label: "Phone", render: (r) => r.phone || <span className="text-slate-400">–</span> },
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true, maxLength: 10, upper: true, hint: "Short code used in document numbers." },
      { name: "name", label: "Name", type: "text", required: true, maxLength: 120 },
      { name: "phone", label: "Phone", type: "text", maxLength: 40 },
      { name: "address", label: "Address", type: "textarea" },
    ],
    defaults: { code: "", name: "", address: "", phone: "", is_active: true },
  },
  {
    key: "customer-categories", label: "Customer categories", resource: "customer-categories", singular: "customer category",
    perm: "customers.manage", description: "Groups customers for filtering and sales reports.",
    columns: [{ label: "Name", render: (r) => <span className="font-medium">{r.name}</span> }],
    fields: [{ name: "name", label: "Name", type: "text", required: true, maxLength: 80 }],
    defaults: { name: "", is_active: true },
  },
  {
    key: "supplier-categories", label: "Supplier categories", resource: "supplier-categories", singular: "supplier category",
    perm: "suppliers.manage", description: "Groups suppliers for filtering and purchase reports.",
    columns: [{ label: "Name", render: (r) => <span className="font-medium">{r.name}</span> }],
    fields: [{ name: "name", label: "Name", type: "text", required: true, maxLength: 80 }],
    defaults: { name: "", is_active: true },
  },
  {
    key: "expense-categories", label: "Expense categories", resource: "expense-categories", singular: "expense category",
    perm: "accounting.manage", description: "Each category posts to one expense account in the chart of accounts.",
    columns: [
      { label: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
      { label: "Expense account", render: (r) => r.account_name },
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true, maxLength: 100 },
      { name: "account", label: "Expense account", type: "account", required: true,
        params: { is_group: "false", account_type: "EXPENSE", is_active: "true" }, hint: "Only expense posting accounts can be chosen." },
    ],
    defaults: { name: "", account: null, is_active: true },
  },
];

export function MastersPage() {
  const [tab, setTab] = useStoredState<string>("admin.masters.tab", MASTERS[0].key);
  const active = MASTERS.some((m) => m.key === tab) ? tab : MASTERS[0].key;
  return (
    <>
      <PageHeader title="Master lists" subtitle="Reference lists used across documents. Entries in use are deactivated rather than deleted." />
      <Tabs value={active} onValueChange={setTab}>
        <TabList className="mb-4" tabs={MASTERS.map((m) => ({ value: m.key, label: m.label }))} />
        {MASTERS.map((m) => <TabPanel key={m.key} value={m.key}><MasterTab config={m} /></TabPanel>)}
      </Tabs>
    </>
  );
}

function MasterTab({ config }: { config: MasterConfig }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useOptions<Row>(config.resource);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const canManage = can(config.perm);

  const toggle = async (row: Row) => {
    setToggling(row.id);
    try {
      await api.patch(`/${config.resource}/${row.id}/`, { is_active: !row.is_active });
      queryClient.invalidateQueries({ queryKey: [config.resource] });
      toast.success(`${row.name ?? row.code} ${row.is_active ? "deactivated" : "activated"}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setToggling(null);
    }
  };

  const rows = (query.data ?? []).filter((r) => showInactive || r.is_active);
  const inactiveCount = (query.data ?? []).filter((r) => !r.is_active).length;

  return (
    <Panel title={config.label}
      actions={<>
        {inactiveCount > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive ({inactiveCount})
          </label>
        )}
        {canManage && <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>Add {config.singular}</Button>}
      </>}>
      <p className="border-b border-line px-4 py-2 text-xs text-slate-500">{config.description}</p>
      {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !rows.length ? (
        <EmptyState title={`No ${config.label.toLowerCase()}`} action={canManage ? <Button onClick={() => setEditing("new")}>Add {config.singular}</Button> : undefined} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
              <tr>
                {config.columns.map((c) => <th key={c.label} className={cn("px-4 py-2 font-medium", c.align === "right" && "text-right")}>{c.label}</th>)}
                <th className="w-28 px-4 py-2 font-medium">Status</th>
                {canManage && <th className="w-36 px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn("border-b border-line last:border-0 hover:bg-surface-muted", !r.is_active && "text-slate-400")}>
                  {config.columns.map((c) => <td key={c.label} className={cn("px-4 py-1.5", c.align === "right" && "num")}>{c.render(r)}</td>)}
                  <td className="px-4 py-1.5">{r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  {canManage && (
                    <td className="whitespace-nowrap px-4 py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
                      <Button size="sm" variant="ghost" loading={toggling === r.id} onClick={() => toggle(r)}>
                        {r.is_active ? "Deactivate" : "Activate"}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <MasterDialog config={config} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function AccountSelect({ field, value, onChange, invalid }: {
  field: Extract<FieldDef, { type: "account" }>; value: number | null; onChange: (v: number | null) => void; invalid?: boolean;
}) {
  const accounts = useOptions<AccountOption>("accounts", field.params);
  const options = (accounts.data ?? []).filter((a) => (field.filter ? field.filter(a) : true));
  return (
    <Select value={value ?? ""} invalid={invalid} disabled={accounts.isLoading} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{accounts.isLoading ? "Loading…" : field.required ? "Choose…" : "None"}</option>
      {options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
    </Select>
  );
}

function MasterDialog({ config, row, onClose }: { config: MasterConfig; row: Row | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, any>>(() => {
    const base = { ...config.defaults };
    if (row) for (const key of Object.keys(base)) base[key] = row[key] ?? base[key];
    if (row && "rate" in base) base.rate = String(Number(row.rate));
    return base;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));

  const save = async () => {
    const e: Record<string, string> = {};
    for (const f of config.fields) {
      const v = values[f.name];
      if ("required" in f && f.required && (v === null || v === undefined || String(v).trim() === "")) e[f.name] = `${f.label} is required.`;
      if (f.type === "number" && String(v ?? "").trim() !== "" && (Number.isNaN(Number(v)) || Number(v) < 0)) e[f.name] = "Enter a number of zero or more.";
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) body[k] = typeof v === "string" ? v.trim() : v;
    for (const f of config.fields) if (f.type === "text" && f.upper && typeof body[f.name] === "string") body[f.name] = (body[f.name] as string).toUpperCase();
    setSaving(true);
    try {
      if (row) await api.patch(`/${config.resource}/${row.id}/`, body);
      else await api.post(`/${config.resource}/`, body);
      queryClient.invalidateQueries({ queryKey: [config.resource] });
      toast.success(row ? `${config.singular[0].toUpperCase()}${config.singular.slice(1)} updated` : `${config.singular[0].toUpperCase()}${config.singular.slice(1)} added`);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={row ? `Edit ${config.singular}` : `Add ${config.singular}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>{row ? "Save changes" : `Add ${config.singular}`}</Button></>}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {config.fields.map((f) => {
          const err = errors[f.name];
          if (f.type === "checkbox") {
            return (
              <label key={f.name} className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}
                {err && <span className="text-xs text-red-600">{err}</span>}
              </label>
            );
          }
          const wide = f.type === "textarea" || f.type === "account" || (f.type === "text" && f.wide);
          return (
            <Field key={f.name} label={f.label} required={"required" in f && f.required} error={err} hint={"hint" in f ? f.hint : undefined}
              className={cn(wide && "sm:col-span-2")}>
              {f.type === "text" && <Input value={values[f.name] ?? ""} maxLength={f.maxLength} invalid={!!err} onChange={(e) => set(f.name, e.target.value)} />}
              {f.type === "textarea" && <Textarea rows={2} value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)} />}
              {f.type === "number" && (
                <div className="flex items-center gap-1.5">
                  <NumberInput value={values[f.name] ?? ""} invalid={!!err} onChange={(e) => set(f.name, e.target.value)} />
                  {f.suffix && <span className="text-xs text-slate-500">{f.suffix}</span>}
                </div>
              )}
              {f.type === "select" && (
                <Select value={values[f.name] ?? ""} invalid={!!err} onChange={(e) => set(f.name, e.target.value)}>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              )}
              {f.type === "account" && <AccountSelect field={f} value={values[f.name] ?? null} invalid={!!err} onChange={(v) => set(f.name, v)} />}
            </Field>
          );
        })}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={!!values.is_active} onChange={(e) => set("is_active", e.target.checked)} />
          Active (available on new documents)
        </label>
      </div>
    </Dialog>
  );
}
