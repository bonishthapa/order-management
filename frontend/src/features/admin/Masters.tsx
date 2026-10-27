import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useOptions, type Params } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { FormDialog, FormField, FormGrid, type FormFieldProps } from "@/components/form";
import { BaseTable, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { useStoredState } from "@/hooks/useStoredState";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any> & { id: number; is_active: boolean };

interface AccountOption { id: number; code: string; name: string; is_cash: boolean; is_bank: boolean; is_active: boolean }

/** A master field: a FormField, or an account picker backed by the accounts list. */
type MasterField = FormFieldProps & { account?: { params: Params; filter?: (a: AccountOption) => boolean } };

interface MasterConfig {
  key: string;
  label: string;
  resource: string;
  singular: string;
  description: string;
  perm: string;
  columns: TableColumn<Row>[];
  fields: MasterField[];
  defaults: Record<string, unknown>;
}

const PAYMENT_KINDS = [
  { value: "CASH", label: "Cash" }, { value: "BANK", label: "Bank transfer" }, { value: "CHEQUE", label: "Cheque" },
  { value: "CARD", label: "Card" }, { value: "WALLET", label: "Digital wallet" },
];

const yesNo = (key: string, header: string) =>
  col.custom<Row>(key, header, (r) => (r[key] ? "Yes" : <span className="text-slate-400">No</span>), { value: (r) => (r[key] ? "Yes" : "No") });
const optional = (key: string, header: string) =>
  col.custom<Row>(key, header, (r) => r[key] || <span className="text-slate-400">–</span>);
const strong = (key: string, header: string) => col.custom<Row>(key, header, (r) => <span className="font-medium">{r[key]}</span>);

const MASTERS: MasterConfig[] = [
  {
    key: "tax", label: "Tax rates", resource: "tax-rates", singular: "tax rate", perm: "settings.manage",
    description: "VAT and other rates offered on document lines. The default rate is preselected on new lines.",
    columns: [
      strong("name", "Name"),
      col.percent<Row>("rate", "Rate"),
      col.custom<Row>("is_default", "Default", (r) => (r.is_default ? <Badge tone="blue">Default</Badge> : "")),
    ],
    fields: [
      { name: "name", label: "Name", required: true, maxLength: 60 },
      { name: "rate", label: "Rate", type: "percent", required: true, suffix: "%",
        rules: { validate: (v: string) => Number(v) >= 0 || "Enter a number of zero or more." } },
      { name: "is_default", label: "Default", type: "checkbox", span: "full", hint: "Default rate for new lines" },
    ],
    defaults: { name: "", rate: "", is_default: false, is_active: true },
  },
  {
    key: "units", label: "Units", resource: "units", singular: "unit", perm: "settings.manage",
    description: "Units of measure for products. Fractional quantities are allowed only where enabled.",
    columns: [strong("code", "Code"), col.text<Row>("name", "Name"), yesNo("allow_fractions", "Fractions")],
    fields: [
      { name: "code", label: "Code", required: true, maxLength: 12, uppercase: true },
      { name: "name", label: "Name", required: true, maxLength: 60 },
      { name: "allow_fractions", label: "Fractions", type: "checkbox", span: "full", hint: "Allow fractional quantities (e.g. 2.5 kg)" },
    ],
    defaults: { code: "", name: "", allow_fractions: false, is_active: true },
  },
  {
    key: "payment", label: "Payment methods", resource: "payment-methods", singular: "payment method", perm: "settings.manage",
    description: "How money is received or paid. Choosing a method preselects its default cash or bank account.",
    columns: [
      strong("name", "Name"),
      col.text<Row>("kind", "Kind", { value: (r) => PAYMENT_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind }),
      col.custom<Row>("default_account_name", "Default account", (r) => r.default_account_name ?? <span className="text-slate-400">None</span>),
      yesNo("requires_reference", "Reference required"),
    ],
    fields: [
      { name: "name", label: "Name", required: true, maxLength: 60 },
      { name: "kind", label: "Kind", type: "select", required: true, emptyOption: false, options: PAYMENT_KINDS },
      { name: "default_account", label: "Default cash / bank account", span: "full", hint: "Only cash and bank accounts can be chosen.",
        account: { params: { is_group: "false", is_active: "true" }, filter: (a) => a.is_cash || a.is_bank } },
      { name: "requires_reference", label: "Reference", type: "checkbox", span: "full",
        hint: "Require a transaction reference (cheque or transfer number)" },
    ],
    defaults: { name: "", kind: "CASH", default_account: null, requires_reference: false, is_active: true },
  },
  {
    key: "branches", label: "Branches", resource: "branches", singular: "branch", perm: "settings.manage",
    description: "Branches group warehouses and can appear in document numbers.",
    columns: [strong("code", "Code"), col.text<Row>("name", "Name"), optional("address", "Address"), optional("phone", "Phone")],
    fields: [
      { name: "code", label: "Code", required: true, maxLength: 10, uppercase: true, hint: "Short code used in document numbers." },
      { name: "name", label: "Name", required: true, maxLength: 120 },
      { name: "phone", label: "Phone", type: "tel", maxLength: 40 },
      { name: "address", label: "Address", type: "textarea", rows: 2, span: "full" },
    ],
    defaults: { code: "", name: "", address: "", phone: "", is_active: true },
  },
  {
    key: "customer-categories", label: "Customer categories", resource: "customer-categories", singular: "customer category",
    perm: "customers.manage", description: "Groups customers for filtering and sales reports.",
    columns: [strong("name", "Name")],
    fields: [{ name: "name", label: "Name", required: true, maxLength: 80 }],
    defaults: { name: "", is_active: true },
  },
  {
    key: "supplier-categories", label: "Supplier categories", resource: "supplier-categories", singular: "supplier category",
    perm: "suppliers.manage", description: "Groups suppliers for filtering and purchase reports.",
    columns: [strong("name", "Name")],
    fields: [{ name: "name", label: "Name", required: true, maxLength: 80 }],
    defaults: { name: "", is_active: true },
  },
  {
    key: "expense-categories", label: "Expense categories", resource: "expense-categories", singular: "expense category",
    perm: "accounting.manage", description: "Each category posts to one expense account in the chart of accounts.",
    columns: [strong("name", "Name"), col.text<Row>("account_name", "Expense account")],
    fields: [
      { name: "name", label: "Name", required: true, maxLength: 100 },
      { name: "account", label: "Expense account", required: true, span: "full", hint: "Only expense posting accounts can be chosen.",
        account: { params: { is_group: "false", account_type: "EXPENSE", is_active: "true" } } },
    ],
    defaults: { name: "", account: null, is_active: true },
  },
];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

  const columns = useMemo<TableColumn<Row>[]>(() => {
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
    return [
      ...config.columns,
      col.custom<Row>("is_active", "Status", (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>), { width: 112 }),
      ...(canManage ? [col.custom<Row>("actions", "", (r) => (
        <span className="whitespace-nowrap">
          <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
          <Button size="sm" variant="ghost" loading={toggling === r.id} onClick={() => toggle(r)}>{r.is_active ? "Deactivate" : "Activate"}</Button>
        </span>
      ), { align: "right", width: 144 })] : []),
    ];
  }, [config, canManage, toggling, queryClient]);

  const rows = query.data?.filter((r) => showInactive || r.is_active);
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
      <BaseTable<Row> columns={columns} rows={rows} loading={query.isLoading} error={query.error} onRetry={() => query.refetch()}
        density="compact" rowClassName={(r) => cn(!r.is_active && "text-slate-400")}
        empty={{
          title: `No ${config.label.toLowerCase()}`,
          action: canManage ? <Button onClick={() => setEditing("new")}>Add {config.singular}</Button> : undefined,
        }} />
      {editing && <MasterDialog config={config} row={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function AccountSelect({ params, filter, value, onChange, invalid, disabled, required }: {
  params: Params; filter?: (a: AccountOption) => boolean; value: number | null; onChange: (v: number | null) => void;
  invalid?: boolean; disabled?: boolean; required?: boolean;
}) {
  const accounts = useOptions<AccountOption>("accounts", params);
  const options = (accounts.data ?? []).filter((a) => (filter ? filter(a) : true));
  return (
    <Select value={value ?? ""} invalid={invalid} disabled={disabled || accounts.isLoading}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{accounts.isLoading ? "Loading…" : required ? "Choose…" : "None"}</option>
      {options.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
    </Select>
  );
}

function MasterDialog({ config, row, onClose }: { config: MasterConfig; row: Row | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const defaults = useMemo(() => {
    const base: Record<string, any> = { ...config.defaults };
    if (row) for (const key of Object.keys(base)) base[key] = row[key] ?? base[key];
    if (row && "rate" in base) base.rate = String(Number(row.rate));
    return base;
  }, [config, row]);

  const submit = async (values: Record<string, any>) => {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) body[k] = typeof v === "string" ? v.trim() : v;
    if (row) await api.patch(`/${config.resource}/${row.id}/`, body);
    else await api.post(`/${config.resource}/`, body);
    queryClient.invalidateQueries({ queryKey: [config.resource] });
    toast.success(`${capitalize(config.singular)} ${row ? "updated" : "added"}`);
  };

  return (
    <FormDialog<Record<string, any>> open onOpenChange={(o) => !o && onClose()} title={row ? `Edit ${config.singular}` : `Add ${config.singular}`}
      submitLabel={row ? "Save changes" : `Add ${config.singular}`} defaultValues={defaults} onSubmit={submit}>
      <FormGrid columns={2}>
        {config.fields.map(({ account, ...field }) => (account
          ? <FormField key={field.name} {...field} type="custom" render={({ value, onChange, invalid, disabled }) => (
            <AccountSelect params={account.params} filter={account.filter} value={value ?? null} onChange={onChange}
              invalid={invalid} disabled={disabled} required={field.required} />
          )} />
          : <FormField key={field.name} {...field} />))}
        <FormField name="is_active" label="Status" type="checkbox" span="full" hint="Active (available on new documents)" />
      </FormGrid>
    </FormDialog>
  );
}
