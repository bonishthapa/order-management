import { Pencil, Plus } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useDetail, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { BaseForm, FormField, FormSection, useFormContext } from "@/components/form";
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
const BASE = "/contacts/customers";

export function CustomerList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const categories = useCategoryOptions("customer");
  return (
    <>
      <PageHeader title="Customers" subtitle="Balances are receivables from posted invoices, receipts, returns and journals."
        actions={can("customers.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/new`)}>New customer</Button>
        )} />
      <ResourceList resource="customers" searchPlaceholder="Code, name, contact, phone, PAN…" detailPath={(r) => `${BASE}/${r.id}`}
        exportUrl="/customers/export/" defaultOrdering="name"
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
          col.money("credit_limit", "Credit limit", { sortable: true }),
          col.money("balance", "Balance", { sortable: true }),
        ]}
        empty={{ title: "No customers", description: "Add a customer to start taking orders." }} />
    </>
  );
}

interface CustomerValues {
  code: string; name: string; contact_person: string; phone: string; email: string; billing_address: string; shipping_address: string;
  tax_id: string; credit_limit: string; payment_terms_days: string; category: number | null; notes: string; is_active: boolean;
}

const blank: CustomerValues = {
  code: "", name: "", contact_person: "", phone: "", email: "", billing_address: "", shipping_address: "", tax_id: "",
  credit_limit: "0", payment_terms_days: "30", category: null, notes: "", is_active: true,
};

function fromCustomer(c: any): CustomerValues {
  return {
    code: c.code ?? "", name: c.name ?? "", contact_person: c.contact_person ?? "", phone: c.phone ?? "", email: c.email ?? "",
    billing_address: c.billing_address ?? "", shipping_address: c.shipping_address ?? "", tax_id: c.tax_id ?? "",
    credit_limit: c.credit_limit ?? "0", payment_terms_days: String(c.payment_terms_days ?? 30), category: c.category ?? null,
    notes: c.notes ?? "", is_active: !!c.is_active,
  };
}

export function CustomerForm() {
  const { id } = useParams();
  const query = useDetail<any>("customers", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <CustomerFormBody key={id ?? "new"} initial={query.data} />;
}

function SameAsBilling() {
  const { getValues, setValue } = useFormContext<CustomerValues>();
  return <button type="button" className="link" onClick={() => setValue("shipping_address", getValues("billing_address"), { shouldDirty: true })}>Same as billing</button>;
}

function CustomerFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const submit = async (v: CustomerValues) => {
    const body = { ...v, name: v.name.trim(), credit_limit: v.credit_limit || "0", payment_terms_days: Number(v.payment_terms_days) };
    const { data } = initial ? await api.patch(`/customers/${initial.id}/`, body) : await api.post("/customers/", body);
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    toast.success(initial ? "Customer updated" : `Customer ${data.code} created`);
    navigate(`${BASE}/${data.id}`);
  };

  return (
    <>
      <PageHeader title={initial ? `Edit ${initial.name}` : "New customer"}
        back={{ to: initial ? `${BASE}/${initial.id}` : BASE, label: initial ? initial.name : "Customers" }} />
      <BaseForm<CustomerValues> defaultValues={initial ? fromCustomer(initial) : blank} onSubmit={submit}
        submitLabel={initial ? "Save changes" : "Create customer"} onCancel={() => navigate(-1)}>
        <FormSection title="Customer">
          <FormField name="code" label="Code" uppercase hint={initial ? undefined : "Leave blank to number automatically."} />
          <FormField name="name" label="Company name" required span={2} />
          <CategoryField kind="customer" canCreate={can("customers.manage")} />
          <FormField name="contact_person" label="Contact person" />
          <FormField name="phone" label="Phone" type="tel" />
          <FormField name="email" label="Email" type="email" />
          <FormField name="tax_id" label="PAN/VAT number" />
          <FormField name="billing_address" label="Billing address" type="textarea" span={2} />
          <FormField name="shipping_address" label="Shipping address" type="textarea" span={2} hint={<SameAsBilling />} />
        </FormSection>
        <FormSection title="Credit and terms">
          <FormField name="credit_limit" label="Credit limit" type="money" hint="0 means no limit is enforced."
            rules={{ validate: (v: string) => v === "" || toNumber(v) >= 0 || "Enter zero or a positive amount." }} />
          <FormField name="payment_terms_days" label="Payment terms (days)" type="number" required
            rules={{ pattern: { value: /^\d+$/, message: "Enter a whole number of days." } }} />
          <FormField name="is_active" label="Status" type="checkbox" hint="Active (can be used on new documents)" />
          <FormField name="notes" label="Notes" type="textarea" span={4} />
        </FormSection>
      </BaseForm>
    </>
  );
}

interface CustomerSummary {
  balance: number | string; credit_limit: number | string; credit_exposure: number | string; overdue_amount: number | string;
  overdue_count: number; open_orders: number; last_invoice_date: string | null; unapplied_receipts: number | string;
}

const orderColumns: TableColumn[] = [
  col.doc("number", "Order", { sortable: true }), col.date("order_date", "Date", { sortable: true }),
  col.date("expected_delivery_date", "Expected"), col.text("warehouse_code", "Warehouse", { width: 120 }),
  col.status("status", "Status", "status_label"), col.money("grand_total", "Amount", { sortable: true }),
];
const invoiceColumns: TableColumn[] = [
  col.doc("number", "Invoice", { sortable: true }), col.date("invoice_date", "Date", { sortable: true }),
  col.date("due_date", "Due", { sortable: true }), col.status("status", "Status", "status_label"),
  col.status("payment_status", "Payment", "payment_status_label"), col.money("grand_total", "Amount", { sortable: true }),
  col.money("balance_due", "Outstanding"),
];
const receiptColumns: TableColumn[] = [
  col.doc("number", "Receipt", { sortable: true }), col.date("date", "Date", { sortable: true }),
  col.text("payment_method_name", "Method"), col.text("reference", "Reference"), col.status("status"),
  col.money("amount", "Amount", { sortable: true }), col.money("unapplied_amount", "Unapplied"),
];

export function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useSearchParams();
  const query = useDetail<any>("customers", id);
  const summary = useGet<CustomerSummary>(["customers", "summary", id], `/customers/${id}/summary/`, {}, !!id);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const c = query.data;
  const s = summary.data;
  const tab = search.get("tab") ?? "overview";
  const setTab = (t: string) => setSearch((prev) => {
    const next = new URLSearchParams();
    if (t !== "overview") next.set("tab", t);
    if (t === "ledger") ["fiscal_year", "date_from", "date_to"].forEach((k) => prev.get(k) && next.set(k, prev.get(k)!));
    return next;
  }, { replace: true });
  const limit = toNumber(s?.credit_limit);
  const headroom = limit > 0 ? limit - toNumber(s?.credit_exposure) : null;

  const tabs = [
    { value: "overview", label: "Overview" }, { value: "ledger", label: "Ledger" }, { value: "aging", label: "Aging" },
    ...(can("sales.view") ? [{ value: "orders", label: "Orders" }, { value: "invoices", label: "Invoices" }, { value: "receipts", label: "Receipts" }] : []),
    ...(can("audit.view") ? [{ value: "activity", label: "Activity" }] : []),
  ];

  return (
    <>
      <PageHeader back={{ to: BASE, label: "Customers" }} title={c.name} meta={<><ActiveBadge active={c.is_active} /></>}
        subtitle={<>{c.code}{c.category_name && <> · {c.category_name}</>}{c.tax_id && <> · PAN {c.tax_id}</>}</>}
        actions={<>
          {can("sales.manage") && c.is_active && <Button onClick={() => navigate(`/sales/orders/new?customer=${c.id}`)}>New order</Button>}
          {can("sales.receipt") && <Button onClick={() => navigate(`/sales/receipts/new?customer=${c.id}`)}>Record receipt</Button>}
          {can("customers.manage") && <Button variant="primary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/${c.id}/edit`)}>Edit</Button>}
        </>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabList className="mb-4" tabs={tabs} />
        <TabPanel value="overview" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="Balance receivable" value={s ? formatAmount(s.balance) : "…"}
              hint={s && toNumber(s.balance) < 0 ? "Negative: advance held for the customer" : "From the posted ledger"} />
            <SummaryCard label="Credit limit / exposure" value={s ? (limit > 0 ? formatAmount(s.credit_limit) : "No limit") : "…"}
              hint={s && <>Exposure {formatAmount(s.credit_exposure)}{headroom !== null && <> · {headroom >= 0 ? `${formatAmount(headroom)} available` : `${formatAmount(-headroom)} over limit`}</>}</>}
              tone={headroom !== null && headroom < 0 ? "danger" : "default"} />
            <SummaryCard label="Overdue" value={s ? formatAmount(s.overdue_amount) : "…"} tone={s && toNumber(s.overdue_amount) > 0 ? "danger" : "default"}
              hint={s && `${s.overdue_count} invoice${s.overdue_count === 1 ? "" : "s"} past due`} />
            <SummaryCard label="Unapplied receipts" value={s ? formatAmount(s.unapplied_receipts) : "…"}
              hint={s && <>{s.open_orders} open order{s.open_orders === 1 ? "" : "s"}{s.last_invoice_date && <> · last invoice <DateText value={s.last_invoice_date} /></>}</>} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Details" className="lg:col-span-2">
              <KeyValues items={[
                { label: "Code", value: c.code },
                { label: "Contact person", value: c.contact_person || "–" },
                { label: "Phone", value: c.phone ? <a className="link" href={`tel:${c.phone}`}>{c.phone}</a> : "–" },
                { label: "Email", value: c.email ? <a className="link" href={`mailto:${c.email}`}>{c.email}</a> : "–" },
                { label: "PAN/VAT", value: c.tax_id || "–" },
                { label: "Category", value: c.category_name ?? "–" },
                { label: "Credit limit", value: toNumber(c.credit_limit) > 0 ? formatAmount(c.credit_limit) : "No limit" },
                { label: "Payment terms", value: `${c.payment_terms_days} days` },
                { label: "Billing address", value: <span className="whitespace-pre-line">{c.billing_address || "–"}</span>, wide: true },
                { label: "Shipping address", value: <span className="whitespace-pre-line">{c.shipping_address || "–"}</span>, wide: true },
                ...(c.notes ? [{ label: "Notes", value: <span className="whitespace-pre-line">{c.notes}</span>, wide: true }] : []),
              ]} />
            </Panel>
            <OpeningBalancePanel kind="customer" party={c} />
          </div>
        </TabPanel>
        <TabPanel value="ledger"><PartyLedger kind="customer" party={c} /></TabPanel>
        <TabPanel value="aging"><PartyAging kind="customer" party={c} /></TabPanel>
        <TabPanel value="orders">
          <PartyDocuments resource="sales-orders" filter="customer" partyId={c.id} columns={orderColumns} detailBase="/sales/orders"
            gridId="customer-orders" emptyTitle="No sales orders" />
        </TabPanel>
        <TabPanel value="invoices">
          <PartyDocuments resource="sales-invoices" filter="customer" partyId={c.id} columns={invoiceColumns} detailBase="/sales/invoices"
            gridId="customer-invoices" emptyTitle="No invoices" />
        </TabPanel>
        <TabPanel value="receipts">
          <PartyDocuments resource="sales-receipts" filter="customer" partyId={c.id} columns={receiptColumns} detailBase="/sales/receipts"
            gridId="customer-receipts" emptyTitle="No receipts"
            newAction={can("sales.receipt") && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`/sales/receipts/new?customer=${c.id}`)}>Record receipt</Button>} />
        </TabPanel>
        {can("audit.view") && <TabPanel value="activity"><AuditActivity entityType="customer" entityId={c.id} /></TabPanel>}
      </Tabs>
    </>
  );
}
