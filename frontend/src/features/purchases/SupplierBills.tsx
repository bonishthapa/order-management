import { HandCoins, Pencil, Plus, Send, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { DatePicker } from "@/calendar/DatePicker";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { Attachments } from "@/components/document/Attachments";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { TradeDocumentForm } from "@/components/document/TradeDocumentForm";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatAmount, formatQty } from "@/utils/format";
import { linkFor } from "@/utils/links";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const BILL_PAYMENT_STATUSES = [{ value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Partially paid" }, { value: "PAID", label: "Paid" }];
export const BILL_STATUSES = [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }];

export function SupplierBillList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Supplier bills" subtitle="Posted bills record purchases and input VAT and raise the amount payable to the supplier."
        actions={can("purchases.bill") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/purchases/bills/new")}>Direct bill</Button>} />
      <ResourceList resource="purchase-bills" dated searchPlaceholder="Bill no., supplier invoice no., supplier, order…" detailPath={(r) => `/purchases/bills/${r.id}`}
        exportUrl="/purchase-bills/export/"
        filters={[
          { type: "select", name: "status", label: "Status", options: BILL_STATUSES },
          { type: "select", name: "payment_status", label: "Payment", options: BILL_PAYMENT_STATUSES },
          { type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" },
          { type: "boolean", name: "overdue", label: "Overdue only" },
        ]}
        columns={(ctx) => [
          col.doc("number", "Bill", { sortable: true }),
          col.date("bill_date", "Date", ctx, { sortable: true }),
          col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("supplier_invoice_number", "Supplier invoice"),
          col.text("order_number", "Order"),
          col.date("due_date", "Due", ctx, { sortable: true }),
          col.status("status", "Status", "status_label"),
          col.status("payment_status", "Payment", "payment_status_label"),
          col.money("grand_total", "Total", { sortable: true }),
          col.money("balance_due", "Balance due", { sortable: true }),
        ]}
        empty={{ title: "No supplier bills", description: "Bill a received purchase order from the order, or record a direct bill." }} />
    </>
  );
}

const directBillProps = {
  resource: "purchase-bills",
  detailPath: (id: number) => `/purchases/bills/${id}`,
  party: { field: "supplier" as const, resource: "suppliers", label: "Supplier" },
  dateField: "bill_date",
  dateLabel: "Bill date",
  secondaryDate: { field: "due_date", label: "Due date (default: payment terms)" },
  referenceField: { field: "supplier_invoice_number", label: "Supplier invoice number", required: true },
  warehouse: { required: false, label: "Receive stock into", hint: "Required when the bill contains stock items." },
  priceMode: "purchase" as const,
  showTerms: false,
};

export function SupplierBillForm() {
  const { id } = useParams();
  const query = useDetail<any>("purchase-bills", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const bill = query.data;
  if (bill && (bill.status !== "DRAFT" || bill.purchase_order)) {
    return (
      <>
        <PageHeader title="Edit bill" back={{ to: `/purchases/bills/${bill.id}`, label: bill.number || `Draft bill #${bill.id}` }} />
        <Alert tone="warning" title="This bill cannot be edited here">
          {bill.status !== "DRAFT" ? "Posted bills are never edited; reverse the bill instead."
            : "Lines of an order-linked bill come from its goods receipts. Change the dates, notes or supplier invoice number from the bill."}
        </Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader title={bill ? "Edit draft bill" : "Direct bill"} back={{ to: bill ? `/purchases/bills/${bill.id}` : "/purchases/bills", label: bill ? `Draft bill #${bill.id}` : "Supplier bills" }}
        subtitle="A direct bill receives stock itself when posted. To bill a purchase order, open the order and use “Create bill”." />
      <TradeDocumentForm {...directBillProps} initial={bill} />
    </>
  );
}

function OrderBillEditDialog({ bill, onClose }: { bill: any; onClose: () => void }) {
  const [date, setDate] = useState(bill.bill_date);
  const [due, setDue] = useState(bill.due_date);
  const [notes, setNotes] = useState(bill.notes);
  const [invoiceNo, setInvoiceNo] = useState(bill.supplier_invoice_number);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Edit draft bill" description="Lines come from the purchase order's goods receipts and cannot be changed here."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={async () => {
        if (!invoiceNo.trim()) return setErrors({ supplier_invoice_number: "Enter the supplier's invoice number." });
        setSaving(true);
        try {
          await api.patch(`/purchase-bills/${bill.id}/`, { bill_date: date, due_date: due, notes, supplier_invoice_number: invoiceNo.trim() });
          await queryClient.invalidateQueries({ queryKey: ["purchase-bills"] });
          toast.success("Saved");
          onClose();
        } catch (e) { setErrors(fieldErrors(e)); toast.error(errorMessage(e)); } finally { setSaving(false); }
      }}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bill date" error={errors.bill_date}><DatePicker value={date} onChange={setDate} /></Field>
        <Field label="Due date" error={errors.due_date}><DatePicker value={due} onChange={setDue} min={date} /></Field>
        <Field label="Supplier invoice number" required error={errors.supplier_invoice_number} className="sm:col-span-2">
          <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} invalid={!!errors.supplier_invoice_number} />
        </Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

export function SupplierBillDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("purchase-bills", id);
  const allocations = useGet<any[]>(["purchase-bills", "allocations", id], `/purchase-bills/${id}/allocations/`, {}, !!id);
  const action = useDocumentAction<any>("purchase-bills", id, ["purchase-orders", "suppliers", "goods-received-notes"]);
  const [editing, setEditing] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const bill = query.data;
  const draft = bill.status === "DRAFT";
  const posted = bill.status === "POSTED";
  const hasGrn = bill.lines.some((l: any) => l.grn_number);
  const returnable = bill.lines.some((l: any) => Number(l.quantity) > Number(l.returned_quantity));
  return (
    <>
      <PageHeader back={{ to: "/purchases/bills", label: "Supplier bills" }} title={bill.number || `Draft bill #${bill.id}`}
        meta={<><StatusBadge status={bill.status} label={bill.status_label} />{posted && <StatusBadge status={bill.payment_status} label={bill.payment_status_label} />}
          {bill.is_overdue && <Badge tone="red">Overdue</Badge>}</>}
        subtitle={<>{bill.supplier_name} · Supplier invoice {bill.supplier_invoice_number} · <DateText value={bill.bill_date} bs={bill.bill_date_bs} /></>}
        actions={<>
          {draft && can("purchases.bill") && (
            <>
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
                try { await api.delete(`/purchase-bills/${bill.id}/`); toast.success("Draft deleted"); navigate(bill.purchase_order ? `/purchases/orders/${bill.purchase_order}` : "/purchases/bills"); }
                catch (e) { toast.error(errorMessage(e)); }
              }}>Delete</Button>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => (bill.purchase_order ? setEditing(true) : navigate(`/purchases/bills/${bill.id}/edit`))}>Edit</Button>
              <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "post", success: "Bill posted" })}>Post bill</Button>
            </>
          )}
          {posted && Number(bill.balance_due) > 0 && can("purchases.payment") && (
            <Button variant="primary" icon={<HandCoins className="h-3.5 w-3.5" />}
              onClick={() => navigate(`/purchases/payments/new?supplier=${bill.supplier}&bill=${bill.id}`)}>Record payment</Button>
          )}
          {posted && returnable && can("purchases.return") && (
            <Button icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => navigate(`/purchases/returns/new?bill=${bill.id}`)}>Purchase return</Button>
          )}
          {posted && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${bill.number}`} loading={action.isPending}
              description="Purchases, input VAT and the payable are reversed; stock received by a direct bill is removed at its original cost. Payments, debit notes and purchase returns must be removed first."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Bill reversed" })} />
          )}
          <PrintButton url={`/purchase-bills/${bill.id}/pdf/`} filename={bill.number || "supplier-bill"} />
        </>} />
      {draft && <Alert tone="info" className="mb-4">Draft – not yet posted. The bill number and fiscal year are assigned when it is posted.</Alert>}
      {bill.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">{bill.reversal_reason}</Alert>}
      <Tabs defaultValue="overview">
        <TabList className="mb-4" tabs={[{ value: "overview", label: "Overview" }, { value: "payments", label: "Payments", count: allocations.data?.length },
          { value: "activity", label: "Activity and documents" }, { value: "files", label: "Attachments" }]} />
        <TabPanel value="overview" className="space-y-4">
          <Panel title="Bill">
            <KeyValues items={[
              { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${bill.supplier}`}>{bill.supplier_name}</Link> },
              { label: "Supplier invoice no.", value: bill.supplier_invoice_number },
              { label: "Bill date", value: <DateText value={bill.bill_date} bs={bill.bill_date_bs} /> },
              { label: "Due date", value: <DateText value={bill.due_date} bs={bill.due_date_bs} /> },
              { label: "Fiscal year", value: bill.fiscal_year_name ?? "Assigned on posting" },
              { label: "Purchase order", value: bill.purchase_order ? <Link className="link" to={`/purchases/orders/${bill.purchase_order}`}>{bill.order_number}</Link> : "Direct bill" },
              { label: "Posted by", value: bill.posted_by_name ?? "–" },
              { label: "Journal", value: bill.journal ? <Link className="link" to={`/finance/journals/${bill.journal}`}>View journal</Link> : "–" },
            ]} />
          </Panel>
          <Panel title="Items">
            <DocumentLines lines={bill.lines} extra={[
              ...(hasGrn ? [{ key: "grn_number", label: "GRN", render: (l: any) => (l.receipt_line && l.grn_number ? l.grn_number : "–") }] : []),
              ...(posted ? [{ key: "returned_quantity", label: "Returned", align: "right" as const, render: (l: any) => formatQty(l.returned_quantity) }] : []),
            ]} />
            <div className="flex flex-col border-t border-line md:flex-row">
              <div className="flex-1 p-4 text-[13px] text-slate-600">
                {bill.notes && <><div className="kv-label mb-1">Notes</div><p className="whitespace-pre-line">{bill.notes}</p></>}
              </div>
              <DocumentTotals doc={bill}>
                {bill.status !== "DRAFT" && (
                  <div className="mt-2 space-y-0.5 border-t border-line pt-2">
                    <div className="flex justify-between text-slate-600"><span>Paid</span><span className="tabular-nums">{formatAmount(bill.amount_paid)}</span></div>
                    {Number(bill.amount_credited) > 0 && <div className="flex justify-between text-slate-600"><span>Debit notes</span><span className="tabular-nums">{formatAmount(bill.amount_credited)}</span></div>}
                    <div className="flex justify-between font-semibold text-slate-900"><span>Balance due</span><span className="tabular-nums">{formatAmount(bill.balance_due)}</span></div>
                  </div>
                )}
              </DocumentTotals>
            </div>
          </Panel>
        </TabPanel>
        <TabPanel value="payments">
          <Panel title="Payments and debit notes applied">
            {allocations.isLoading ? <LoadingBlock /> : allocations.error ? <ErrorState error={allocations.error} onRetry={() => allocations.refetch()} />
              : !allocations.data?.length ? <p className="p-4 text-xs text-slate-500">Nothing applied yet.</p> : (
                <table className="w-full text-[13px]">
                  <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                    <tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Document</th><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">State</th></tr>
                  </thead>
                  <tbody>
                    {allocations.data.map((a) => (
                      <tr key={a.id} className="border-b border-line">
                        <td className="px-4 py-2"><DateText value={a.date} /></td>
                        <td className="px-4 py-2"><Link className="link" to={linkFor(a.source_type === "voucher" ? "payment-voucher" : "purchase-return", a.source_id)!}>{a.source_number}</Link></td>
                        <td className="px-4 py-2">{a.source_type === "voucher" ? "Payment voucher" : "Debit note"}</td>
                        <td className="num px-4 py-2">{formatAmount(a.amount)}</td>
                        <td className="px-4 py-2">{a.is_active ? <Badge tone="green">Applied</Badge> : <Badge>Reversed</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>
        </TabPanel>
        <TabPanel value="activity"><DocumentTimeline resource="purchase-bills" id={bill.id} /></TabPanel>
        <TabPanel value="files"><Attachments entityType="supplierbill" entityId={bill.id} canUpload={can("purchases.bill")} canDelete={draft} /></TabPanel>
      </Tabs>
      {editing && <OrderBillEditDialog bill={bill} onClose={() => setEditing(false)} />}
    </>
  );
}
