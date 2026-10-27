import { HandCoins, Pencil, Plus, Send, Trash2, Undo2 } from "lucide-react";
import { BaseTable, col, ResourceList } from "@/components/table";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FormDialog, FormField, FormGrid, useWatch } from "@/components/form";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { Attachments } from "@/components/document/Attachments";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { TradeDocumentForm } from "@/components/document/TradeDocumentForm";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatAmount } from "@/utils/format";
import { linkFor } from "@/utils/links";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const PAYMENT_STATUSES = [{ value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Partially paid" }, { value: "PAID", label: "Paid" }];

export function InvoiceList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Sales invoices" subtitle="Posted invoices recognise revenue and VAT and raise the customer's receivable."
        actions={can("sales.invoice") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/sales/invoices/new")}>Direct invoice</Button>} />
      <ResourceList resource="sales-invoices" dated searchPlaceholder="Invoice no., customer, order…" detailPath={(r) => `/sales/invoices/${r.id}`}
        exportUrl="/sales-invoices/export/"
        filters={[
          { type: "select", name: "status", label: "Status", options: [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }] },
          { type: "select", name: "payment_status", label: "Payment", options: PAYMENT_STATUSES },
          { type: "entity", name: "customer", label: "Customer", resource: "customers" },
          { type: "boolean", name: "overdue", label: "Overdue only" },
        ]}
        columns={[
          col.doc("number", "Invoice", { sortable: true }),
          col.date("invoice_date", "Date", { sortable: true }),
          col.text("customer_display", "Customer", { flex: 2 }),
          col.text("order_number", "Order"),
          col.date("due_date", "Due", { sortable: true }),
          col.status("status", "Status", "status_label"),
          col.status("payment_status", "Payment", "payment_status_label"),
          col.money("grand_total", "Total", { sortable: true }),
          col.money("balance_due", "Balance due", { sortable: true }),
        ]} />
    </>
  );
}

const directInvoiceProps = {
  resource: "sales-invoices",
  detailPath: (id: number) => `/sales/invoices/${id}`,
  party: { field: "customer" as const, resource: "customers", label: "Customer" },
  dateField: "invoice_date",
  dateLabel: "Invoice date",
  secondaryDate: { field: "due_date", label: "Due date (default: payment terms)" },
  referenceField: { field: "customer_reference", label: "Customer reference" },
  warehouse: { required: false, label: "Issue stock from", hint: "Required when the invoice contains stock items." },
  priceMode: "sales" as const,
};

export function InvoiceForm() {
  const { id } = useParams();
  const query = useDetail<any>("sales-invoices", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && query.error) return <ErrorState error={query.error} />;
  return (
    <>
      <PageHeader title={query.data ? "Edit draft invoice" : "Direct invoice"} back={{ to: "/sales/invoices", label: "Invoices" }}
        subtitle="A direct invoice issues stock itself when posted. To invoice an order, open the order and use “Create invoice”." />
      <TradeDocumentForm {...directInvoiceProps} initial={query.data} />
    </>
  );
}

function OrderInvoiceEditDialog({ invoice, onClose }: { invoice: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Edit draft invoice"
      description="Lines come from the sales order and cannot be changed here."
      defaultValues={{ invoice_date: invoice.invoice_date, due_date: invoice.due_date, notes: invoice.notes, customer_reference: invoice.customer_reference }}
      onSubmit={async (values) => {
        await api.patch(`/sales-invoices/${invoice.id}/`, values);
        await queryClient.invalidateQueries({ queryKey: ["sales-invoices"] });
        toast.success("Saved");
      }}>
      <FormGrid>
        <FormField name="invoice_date" label="Invoice date" type="date" required />
        <DueDate />
        <FormField name="customer_reference" label="Customer reference" span={2} />
        <FormField name="notes" label="Notes" type="textarea" span={2} />
      </FormGrid>
    </FormDialog>
  );
}

function DueDate() {
  const invoiceDate = useWatch({ name: "invoice_date" });
  return <FormField name="due_date" label="Due date" type="date" required min={invoiceDate} />;
}

export function InvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("sales-invoices", id);
  const allocations = useGet<any[]>(["sales-invoices", "allocations", id], `/sales-invoices/${id}/allocations/`, {}, !!id);
  const action = useDocumentAction<any>("sales-invoices", id, ["sales-orders", "customers"]);
  const [editing, setEditing] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  const inv = query.data;
  const draft = inv.status === "DRAFT";
  return (
    <>
      <PageHeader back={{ to: "/sales/invoices", label: "Invoices" }} title={inv.number || `Draft invoice #${inv.id}`}
        meta={<><StatusBadge status={inv.status} label={inv.status_label} />{inv.status === "POSTED" && <StatusBadge status={inv.payment_status} label={inv.payment_status_label} />}
          {inv.is_overdue && <Badge tone="red">Overdue</Badge>}</>}
        subtitle={<>{inv.customer_display} · <DateText value={inv.invoice_date} bs={inv.invoice_date_bs} /></>}
        actions={<>
          {draft && can("sales.invoice") && (
            <>
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
                try { await api.delete(`/sales-invoices/${inv.id}/`); toast.success("Draft deleted"); navigate("/sales/invoices"); } catch (e) { toast.error(errorMessage(e)); }
              }}>Delete</Button>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => (inv.sales_order ? setEditing(true) : navigate(`/sales/invoices/${inv.id}/edit`))}>Edit</Button>
              <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "post", success: "Invoice posted" })}>Post invoice</Button>
            </>
          )}
          {inv.status === "POSTED" && Number(inv.balance_due) > 0 && can("sales.receipt") && (
            <Button variant="primary" icon={<HandCoins className="h-3.5 w-3.5" />} onClick={() => navigate(`/sales/receipts/new?customer=${inv.customer}&invoice=${inv.id}`)}>Record receipt</Button>
          )}
          {inv.status === "POSTED" && can("sales.return") && (
            <Button icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => navigate(`/sales/returns/new?invoice=${inv.id}`)}>Sales return</Button>
          )}
          {inv.status === "POSTED" && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${inv.number}`} loading={action.isPending}
              description="Revenue, VAT and the receivable are reversed; stock issued by a direct invoice is returned at its original cost. Receipts and credit notes must be removed first."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Invoice reversed" })} />
          )}
          <PrintButton url={`/sales-invoices/${inv.id}/pdf/`} filename={inv.number || "invoice"} />
        </>} />
      {draft && <Alert tone="info" className="mb-4">Draft – not yet posted. The invoice number and fiscal year are assigned when it is posted.</Alert>}
      {inv.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">{inv.reversal_reason}</Alert>}
      <Tabs defaultValue="overview">
        <TabList className="mb-4" tabs={[{ value: "overview", label: "Overview" }, { value: "payments", label: "Payments", count: allocations.data?.length },
          { value: "activity", label: "Activity and documents" }, { value: "files", label: "Attachments" }]} />
        <TabPanel value="overview" className="space-y-4">
          <Panel title="Invoice">
            <KeyValues items={[
              { label: "Customer", value: <Link className="link" to={`/contacts/customers/${inv.customer}`}>{inv.customer_display}</Link> },
              { label: "Invoice date", value: <DateText value={inv.invoice_date} bs={inv.invoice_date_bs} /> },
              { label: "Due date", value: <DateText value={inv.due_date} bs={inv.due_date_bs} /> },
              { label: "Fiscal year", value: inv.fiscal_year_name ?? "Assigned on posting" },
              { label: "Sales order", value: inv.sales_order ? <Link className="link" to={`/sales/orders/${inv.sales_order}`}>{inv.order_number}</Link> : "Direct invoice" },
              { label: "Customer reference", value: inv.customer_reference || "–" },
              { label: "PAN/VAT", value: inv.customer_tax_id || "–" },
              { label: "Posted by", value: inv.posted_by_name ?? "–" },
            ]} />
          </Panel>
          <Panel title="Items">
            <DocumentLines lines={inv.lines} extra={inv.status === "POSTED" ? [col.qty("returned_quantity", "Returned")] : []} />
            <div className="flex flex-col border-t border-line md:flex-row">
              <div className="flex-1 space-y-3 p-4 text-[13px] text-slate-600">
                {inv.notes && <div><div className="kv-label mb-1">Notes</div><p className="whitespace-pre-line">{inv.notes}</p></div>}
                {inv.terms && <div><div className="kv-label mb-1">Terms</div><p className="whitespace-pre-line text-xs">{inv.terms}</p></div>}
              </div>
              <DocumentTotals doc={inv}>
                {inv.status !== "DRAFT" && (
                  <div className="mt-2 space-y-0.5 border-t border-line pt-2">
                    <div className="flex justify-between text-slate-600"><span>Received</span><span className="tabular-nums">{formatAmount(inv.amount_paid)}</span></div>
                    {Number(inv.amount_credited) > 0 && <div className="flex justify-between text-slate-600"><span>Credit notes</span><span className="tabular-nums">{formatAmount(inv.amount_credited)}</span></div>}
                    <div className="flex justify-between font-semibold text-slate-900"><span>Balance due</span><span className="tabular-nums">{formatAmount(inv.balance_due)}</span></div>
                  </div>
                )}
              </DocumentTotals>
            </div>
          </Panel>
        </TabPanel>
        <TabPanel value="payments">
          <Panel title="Receipts and credits applied">
            <BaseTable rows={allocations.data} loading={allocations.isLoading} empty={<p className="p-4 text-xs text-slate-500">Nothing applied yet.</p>}
              columns={[
                col.date("date", "Date"),
                col.custom("source_number", "Document", (a: any) => (
                  <Link className="link" to={linkFor(a.source_type === "receipt" ? "sales-receipt" : "sales-return", a.source_id)!}>{a.source_number}</Link>)),
                col.custom("source_type", "Type", (a: any) => (a.source_type === "receipt" ? "Receipt" : "Credit note")),
                col.money("amount", "Amount"),
                col.custom("is_active", "State", (a: any) => (a.is_active ? <Badge tone="green">Applied</Badge> : <Badge>Reversed</Badge>)),
              ]} />
          </Panel>
        </TabPanel>
        <TabPanel value="activity"><DocumentTimeline resource="sales-invoices" id={inv.id} /></TabPanel>
        <TabPanel value="files"><Attachments entityType="salesinvoice" entityId={inv.id} canUpload={can("sales.invoice")} canDelete={draft} /></TabPanel>
      </Tabs>
      {editing && <OrderInvoiceEditDialog invoice={inv} onClose={() => setEditing(false)} />}
    </>
  );
}
