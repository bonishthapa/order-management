import { Pencil, Plus } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useDetail, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { BaseForm, FormField, FormSection } from "@/components/form";
import { ResourceList, col, type TableColumn } from "@/components/table";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatAmount, toNumber } from "@/utils/format";
import {
  ACTIVE_OPTIONS, ActiveBadge, AuditActivity, CategoryField, OpeningBalancePanel, PartyAging, PartyDocuments, PartyLedger,
  SummaryCard, useCategoryOptions,
} from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "/contacts/suppliers";

export function SupplierList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const categories = useCategoryOptions("supplier");
  return (
    <>
      <PageHeader title="Suppliers" subtitle="Balances are payables from posted bills, payments, returns and journals."
        actions={can("suppliers.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/new`)}>New supplier</Button>
        )} />
      <ResourceList resource="suppliers" searchPlaceholder="Code, name, contact, phone, PAN…" detailPath={(r) => `${BASE}/${r.id}`}
        exportUrl="/suppliers/export/" defaultOrdering="name"
        filters={[
          { type: "select", name: "category", label: "Category", options: categories },
          { type: "select", name: "is_active", label: "Status", options: ACTIVE_OPTIONS },
          { type: "boolean", name: "has_balance", label: "With balance" },
        ]}
        columns={[
          col.text("code", "Code", { sortable: true, width: 130, pinned: true }),
          col.text("name", "Name", { sortable: true, flex: 2, minWidth: 200,
            render: (r: any) => <span className={r.is_active ? "font-medium text-slate-800" : "text-slate-400"}>{r.name}{!r.is_active && " (inactive)"}</span> }),
          col.text("contact_person", "Contact"),
          col.text("phone", "Phone"),
          col.text("tax_id", "PAN/VAT"),
          col.text("category_name", "Category"),
          col.number("payment_terms_days", "Terms (days)", { width: 120 }),
          col.money("balance", "Balance", { sortable: true }),
        ]}
        empty={{ title: "No suppliers", description: "Add a supplier to start raising purchase orders." }} />
    </>
  );
}

interface SupplierValues {
  code: string; name: string; contact_person: string; phone: string; email: string; address: string; tax_id: string;
  payment_terms_days: string; category: number | null; bank_name: string; bank_account_name: string; bank_account_number: string;
  bank_branch: string; notes: string; is_active: boolean;
}

const blank: SupplierValues = {
  code: "", name: "", contact_person: "", phone: "", email: "", address: "", tax_id: "", payment_terms_days: "30", category: null,
  bank_name: "", bank_account_name: "", bank_account_number: "", bank_branch: "", notes: "", is_active: true,
};

function fromSupplier(s: any): SupplierValues {
  return {
    code: s.code ?? "", name: s.name ?? "", contact_person: s.contact_person ?? "", phone: s.phone ?? "", email: s.email ?? "",
    address: s.address ?? "", tax_id: s.tax_id ?? "", payment_terms_days: String(s.payment_terms_days ?? 30), category: s.category ?? null,
    bank_name: s.bank_name ?? "", bank_account_name: s.bank_account_name ?? "", bank_account_number: s.bank_account_number ?? "",
    bank_branch: s.bank_branch ?? "", notes: s.notes ?? "", is_active: !!s.is_active,
  };
}

const BANK_KEYS = ["bank_name", "bank_account_name", "bank_account_number", "bank_branch"] as const;

export function SupplierForm() {
  const { id } = useParams();
  const query = useDetail<any>("suppliers", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <SupplierFormBody key={id ?? "new"} initial={query.data} />;
}

function SupplierFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const bankVisible = initial ? !!initial.bank_details_visible : can("suppliers.bank_view");

  const submit = async (v: SupplierValues) => {
    const body: Record<string, unknown> = { ...v, name: v.name.trim(), payment_terms_days: Number(v.payment_terms_days) };
    if (!bankVisible) BANK_KEYS.forEach((k) => delete body[k]);
    const { data } = initial ? await api.patch(`/suppliers/${initial.id}/`, body) : await api.post("/suppliers/", body);
    queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    toast.success(initial ? "Supplier updated" : `Supplier ${data.code} created`);
    navigate(`${BASE}/${data.id}`);
  };

  return (
    <>
      <PageHeader title={initial ? `Edit ${initial.name}` : "New supplier"}
        back={{ to: initial ? `${BASE}/${initial.id}` : BASE, label: initial ? initial.name : "Suppliers" }} />
      <BaseForm<SupplierValues> defaultValues={initial ? fromSupplier(initial) : blank} onSubmit={submit}
        submitLabel={initial ? "Save changes" : "Create supplier"} onCancel={() => navigate(-1)}>
        <FormSection title="Supplier">
          <FormField name="code" label="Code" uppercase hint={initial ? undefined : "Leave blank to number automatically."} />
          <FormField name="name" label="Company name" required span={2} />
          <CategoryField kind="supplier" canCreate={can("suppliers.manage")} />
          <FormField name="contact_person" label="Contact person" />
          <FormField name="phone" label="Phone" type="tel" />
          <FormField name="email" label="Email" type="email" />
          <FormField name="tax_id" label="PAN/VAT number" />
          <FormField name="address" label="Address" type="textarea" span={2} />
          <FormField name="payment_terms_days" label="Payment terms (days)" type="number" required
            rules={{ pattern: { value: /^\d+$/, message: "Enter a whole number of days." } }} />
          <FormField name="is_active" label="Status" type="checkbox" hint="Active (can be used on new documents)" />
        </FormSection>
        {bankVisible && (
          <FormSection title="Bank details" description="Changes to bank details are recorded in the audit trail.">
            <FormField name="bank_name" label="Bank" />
            <FormField name="bank_branch" label="Branch" />
            <FormField name="bank_account_name" label="Account name" />
            <FormField name="bank_account_number" label="Account number" />
          </FormSection>
        )}
        <FormSection title="Notes" columns={1}>
          <FormField name="notes" label="Notes" type="textarea" />
        </FormSection>
      </BaseForm>
    </>
  );
}

interface SupplierSummary {
  balance: number | string; overdue_amount: number | string; overdue_count: number; open_orders: number;
  last_bill_date: string | null; unapplied_payments: number | string;
}

const orderColumns: TableColumn[] = [
  col.doc("number", "Order", { sortable: true }), col.date("order_date", "Date", { sortable: true }),
  col.date("expected_delivery_date", "Expected"), col.text("warehouse_code", "Warehouse", { width: 120 }),
  col.status("status", "Status", "status_label"), col.money("grand_total", "Amount", { sortable: true }),
];
const billColumns: TableColumn[] = [
  col.doc("number", "Bill", { sortable: true }), col.text("supplier_invoice_number", "Supplier invoice"),
  col.date("bill_date", "Date", { sortable: true }), col.date("due_date", "Due", { sortable: true }),
  col.status("status", "Status", "status_label"), col.status("payment_status", "Payment", "payment_status_label"),
  col.money("grand_total", "Amount", { sortable: true }), col.money("balance_due", "Outstanding"),
];
const paymentColumns: TableColumn[] = [
  col.doc("number", "Voucher", { sortable: true }), col.date("date", "Date", { sortable: true }),
  col.text("payment_method_name", "Method"), col.text("paid_from_account_name", "Paid from", { flex: 2 }),
  col.text("reference", "Reference"), col.status("status"), col.money("amount", "Amount", { sortable: true }),
  col.money("unapplied_amount", "Unapplied"),
];

export function SupplierDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useSearchParams();
  const query = useDetail<any>("suppliers", id);
  const summary = useGet<SupplierSummary>(["suppliers", "summary", id], `/suppliers/${id}/summary/`, {}, !!id);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const sp = query.data;
  const s = summary.data;
  const tab = search.get("tab") ?? "overview";
  const setTab = (t: string) => setSearch((prev) => {
    const next = new URLSearchParams();
    if (t !== "overview") next.set("tab", t);
    if (t === "ledger") ["fiscal_year", "date_from", "date_to"].forEach((k) => prev.get(k) && next.set(k, prev.get(k)!));
    return next;
  }, { replace: true });

  const tabs = [
    { value: "overview", label: "Overview" }, { value: "ledger", label: "Ledger" }, { value: "aging", label: "Aging" },
    ...(can("purchases.view") ? [{ value: "orders", label: "Purchase orders" }, { value: "bills", label: "Bills" }, { value: "payments", label: "Payments" }] : []),
    ...(can("audit.view") ? [{ value: "activity", label: "Activity" }] : []),
  ];

  return (
    <>
      <PageHeader back={{ to: BASE, label: "Suppliers" }} title={sp.name} meta={<ActiveBadge active={sp.is_active} />}
        subtitle={<>{sp.code}{sp.category_name && <> · {sp.category_name}</>}{sp.tax_id && <> · PAN {sp.tax_id}</>}</>}
        actions={<>
          {can("purchases.manage") && sp.is_active && <Button onClick={() => navigate(`/purchases/orders/new?supplier=${sp.id}`)}>New purchase order</Button>}
          {can("purchases.payment") && <Button onClick={() => navigate(`/purchases/payments/new?supplier=${sp.id}`)}>Record payment</Button>}
          {can("suppliers.manage") && <Button variant="primary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/${sp.id}/edit`)}>Edit</Button>}
        </>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabList className="mb-4" tabs={tabs} />
        <TabPanel value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="Balance payable" value={s ? formatAmount(s.balance) : "…"}
              hint={s && toNumber(s.balance) < 0 ? "Negative: advance paid to the supplier" : "From the posted ledger"} />
            <SummaryCard label="Overdue" value={s ? formatAmount(s.overdue_amount) : "…"} tone={s && toNumber(s.overdue_amount) > 0 ? "danger" : "default"}
              hint={s && `${s.overdue_count} bill${s.overdue_count === 1 ? "" : "s"} past due`} />
            <SummaryCard label="Open purchase orders" value={s ? s.open_orders : "…"}
              hint={s?.last_bill_date ? <>Last bill <DateText value={s.last_bill_date} /></> : "No posted bills"} />
            <SummaryCard label="Unapplied payments" value={s ? formatAmount(s.unapplied_payments) : "…"} hint="Advances not yet set against bills" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Panel title="Details">
                <KeyValues items={[
                  { label: "Code", value: sp.code },
                  { label: "Contact person", value: sp.contact_person || "–" },
                  { label: "Phone", value: sp.phone ? <a className="link" href={`tel:${sp.phone}`}>{sp.phone}</a> : "–" },
                  { label: "Email", value: sp.email ? <a className="link" href={`mailto:${sp.email}`}>{sp.email}</a> : "–" },
                  { label: "PAN/VAT", value: sp.tax_id || "–" },
                  { label: "Category", value: sp.category_name ?? "–" },
                  { label: "Payment terms", value: `${sp.payment_terms_days} days` },
                  { label: "Address", value: <span className="whitespace-pre-line">{sp.address || "–"}</span>, wide: true },
                  ...(sp.notes ? [{ label: "Notes", value: <span className="whitespace-pre-line">{sp.notes}</span>, wide: true }] : []),
                ]} />
              </Panel>
              {sp.bank_details_visible && (
                <Panel title="Bank details">
                  <KeyValues items={[
                    { label: "Bank", value: sp.bank_name || "–" },
                    { label: "Branch", value: sp.bank_branch || "–" },
                    { label: "Account name", value: sp.bank_account_name || "–" },
                    { label: "Account number", value: sp.bank_account_number ? <span className="tabular-nums">{sp.bank_account_number}</span> : "–" },
                  ]} />
                </Panel>
              )}
            </div>
            <OpeningBalancePanel kind="supplier" party={sp} />
          </div>
        </TabPanel>
        <TabPanel value="ledger"><PartyLedger kind="supplier" party={sp} /></TabPanel>
        <TabPanel value="aging"><PartyAging kind="supplier" party={sp} /></TabPanel>
        <TabPanel value="orders">
          <PartyDocuments resource="purchase-orders" filter="supplier" partyId={sp.id} columns={orderColumns} detailBase="/purchases/orders"
            gridId="supplier-orders" emptyTitle="No purchase orders" />
        </TabPanel>
        <TabPanel value="bills">
          <PartyDocuments resource="purchase-bills" filter="supplier" partyId={sp.id} columns={billColumns} detailBase="/purchases/bills"
            gridId="supplier-bills" emptyTitle="No supplier bills" />
        </TabPanel>
        <TabPanel value="payments">
          <PartyDocuments resource="payment-vouchers" filter="supplier" partyId={sp.id} columns={paymentColumns} detailBase="/purchases/payments"
            gridId="supplier-payments" emptyTitle="No payments"
            newAction={can("purchases.payment") && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => navigate(`/purchases/payments/new?supplier=${sp.id}`)}>Record payment</Button>} />
        </TabPanel>
        {can("audit.view") && <TabPanel value="activity"><AuditActivity entityType="supplier" entityId={sp.id} /></TabPanel>}
      </Tabs>
    </>
  );
}
