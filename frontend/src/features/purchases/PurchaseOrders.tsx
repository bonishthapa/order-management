import { CheckCircle2, FileText, PackageCheck, Pencil, Plus, Send, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { Attachments } from "@/components/document/Attachments";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { DocumentTimeline } from "@/components/document/Timeline";
import { TradeDocumentForm } from "@/components/document/TradeDocumentForm";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatQty } from "@/utils/format";
import { GoodsReceiptDialog } from "./GoodsReceipts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const PO_STATUSES = [
  { value: "DRAFT", label: "Draft" }, { value: "SUBMITTED", label: "Awaiting approval" }, { value: "APPROVED", label: "Approved" },
  { value: "PARTIAL", label: "Partially received" }, { value: "COMPLETED", label: "Completed" }, { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

export function PurchaseOrderList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Purchase orders" subtitle="Approved orders are received through goods received notes and billed from what was received."
        actions={can("purchases.manage") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/purchases/orders/new")}>New order</Button>} />
      <ResourceList
        resource="purchase-orders"
        dated
        searchPlaceholder="Order no., supplier, reference…"
        detailPath={(r) => `/purchases/orders/${r.id}`}
        exportUrl="/purchase-orders/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: PO_STATUSES },
          { type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" },
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" }]}
        columns={(ctx) => [
          col.doc("number", "Order", { sortable: true }),
          col.date("order_date", "Date", ctx, { sortable: true }),
          col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("warehouse_code", "Warehouse", { maxWidth: 120 }),
          col.date("expected_delivery_date", "Expected", ctx, { sortable: true }),
          col.status("status", "Status", "status_label"),
          col.money("grand_total", "Amount", { sortable: true }),
        ]}
        empty={{ title: "No purchase orders", description: "Create an order to buy stock or services from a supplier." }}
      />
    </>
  );
}

const orderFormProps = {
  resource: "purchase-orders",
  detailPath: (id: number) => `/purchases/orders/${id}`,
  party: { field: "supplier" as const, resource: "suppliers", label: "Supplier" },
  dateField: "order_date",
  dateLabel: "Order date",
  secondaryDate: { field: "expected_delivery_date", label: "Expected delivery" },
  referenceField: { field: "supplier_reference", label: "Supplier quotation / reference" },
  warehouse: { required: true, label: "Receive into warehouse" },
  priceMode: "purchase" as const,
};

export function PurchaseOrderForm() {
  const { id } = useParams();
  const query = useDetail<any>("purchase-orders", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const doc = query.data;
  if (doc && !["DRAFT", "REJECTED"].includes(doc.status)) {
    return (
      <>
        <PageHeader title={`Edit ${doc.number}`} back={{ to: `/purchases/orders/${doc.id}`, label: doc.number }} />
        <Alert tone="warning" title="This order can no longer be edited">Only draft or rejected purchase orders can be changed.</Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader title={doc ? `Edit ${doc.number}` : "New purchase order"}
        back={{ to: doc ? `/purchases/orders/${doc.id}` : "/purchases/orders", label: doc ? doc.number : "Purchase orders" }} />
      {doc && doc.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{doc.rejection_reason} Saving returns the order to draft.</Alert>}
      <TradeDocumentForm {...orderFormProps} initial={doc} />
    </>
  );
}

/** Asks for the supplier's invoice number, then drafts a bill from the received-but-unbilled quantities of the order. */
function CreateBillDialog({ order, onClose }: { order: any; onClose: () => void }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [billDate, setBillDate] = useState(todayIn(session?.organization?.timezone));
  const [invoiceNo, setInvoiceNo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!invoiceNo.trim()) return setErrors({ supplier_invoice_number: "Enter the supplier's invoice number." });
    setErrors({});
    setSaving(true);
    try {
      const { data: lines } = await api.get(`/purchase-orders/${order.id}/billable/`);
      if (!lines.length) throw new Error("Nothing to bill yet: receive the goods first.");
      const { data } = await api.post("/purchase-bills/", {
        supplier: order.supplier, purchase_order: order.id, bill_date: billDate, supplier_invoice_number: invoiceNo.trim(),
        lines: lines.map((l: any) => ({
          receipt_line: l.receipt_line, order_line: l.order_line, product: l.product, quantity: l.quantity, unit_price: l.unit_price,
          discount_percent: l.discount_percent, tax_rate: l.tax_rate, description: "",
        })),
      });
      ["purchase-bills", "purchase-orders"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      toast.success("Draft bill created");
      onClose();
      navigate(`/purchases/bills/${data.id}`);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Create bill for ${order.number}`}
      description="The draft bill includes every received but unbilled quantity and unbilled service lines. Review it before posting."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={submit}>Create draft bill</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier invoice number" required error={errors.supplier_invoice_number}>
          <Input autoFocus value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} invalid={!!errors.supplier_invoice_number} />
        </Field>
        <Field label="Bill date" required error={errors.bill_date}><DatePicker value={billDate} onChange={setBillDate} min={order.order_date} /></Field>
      </div>
    </Dialog>
  );
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("purchase-orders", id);
  const action = useDocumentAction<any>("purchase-orders", id, ["goods-received-notes", "purchase-bills"]);
  const [dialog, setDialog] = useState<null | "reject" | "cancel" | "close" | "receive" | "bill">(null);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const po = query.data;
  const open = ["APPROVED", "PARTIAL"].includes(po.status);
  const p = po.progress;
  const lines: any[] = po.lines;
  const receivable = lines.some((l) => l.is_stock && Number(l.quantity) > Number(l.received_quantity));
  const billable = lines.some((l) => (l.is_stock ? Number(l.received_quantity) : Number(l.quantity)) > Number(l.billed_quantity));
  const untouched = Number(p.received) === 0 && Number(p.rejected) === 0 && Number(p.billed) === 0;
  const canCancel = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(po.status) && untouched
    && (can("purchases.manage") || can("purchases.approve"));
  const canClose = open && can("purchases.approve");
  const pending = lines.reduce((s, l) => s + (l.is_stock ? Math.max(Number(l.quantity) - Number(l.received_quantity), 0) : 0), 0);

  return (
    <>
      <PageHeader
        back={{ to: "/purchases/orders", label: "Purchase orders" }}
        title={po.number}
        meta={<StatusBadge status={po.status} label={po.status_label} />}
        subtitle={<>{po.supplier_name} · <DateText value={po.order_date} bs={po.order_date_bs} /></>}
        actions={<>
          {["DRAFT", "REJECTED"].includes(po.status) && can("purchases.manage") && (
            <>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/purchases/orders/${po.id}/edit`)}>Edit</Button>
              {po.status === "DRAFT" && (
                <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                  onClick={() => action.mutate({ action: "submit", success: "Submitted for approval" })}>Submit</Button>
              )}
            </>
          )}
          {po.status === "SUBMITTED" && can("purchases.approve") && (
            <>
              <Button icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("reject")}>Reject</Button>
              <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "approve", success: "Order approved" })}>Approve</Button>
            </>
          )}
          {open && receivable && can("purchases.receive") && (
            <Button variant="primary" icon={<PackageCheck className="h-3.5 w-3.5" />} onClick={() => setDialog("receive")}>Receive goods</Button>
          )}
          {["APPROVED", "PARTIAL", "COMPLETED"].includes(po.status) && billable && can("purchases.bill") && (
            <Button icon={<FileText className="h-3.5 w-3.5" />} onClick={() => setDialog("bill")}>Create bill</Button>
          )}
          <PrintButton url={`/purchase-orders/${po.id}/pdf/`} filename={po.number} />
          {(canCancel || canClose) && (
            <Menu>
              <MenuTrigger asChild><Button>More</Button></MenuTrigger>
              <MenuContent>
                {canClose && <MenuItem onSelect={() => setDialog("close")}>Close and cancel the balance</MenuItem>}
                {canCancel && <MenuItem danger onSelect={() => setDialog("cancel")}>Cancel order</MenuItem>}
              </MenuContent>
            </Menu>
          )}
        </>}
      />
      {po.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{po.rejection_reason}</Alert>}
      {po.status === "CANCELLED" && <Alert tone="info" className="mb-4" title="Cancelled">{po.cancellation_reason}</Alert>}
      {po.status === "COMPLETED" && po.cancellation_reason && <Alert tone="info" className="mb-4" title="Closed">{po.cancellation_reason}</Alert>}

      <Tabs defaultValue="overview">
        <TabList className="mb-4" tabs={[{ value: "overview", label: "Overview" }, { value: "activity", label: "Activity and documents" },
          { value: "files", label: "Attachments" }]} />
        <TabPanel value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Order" className="lg:col-span-2">
              <KeyValues items={[
                { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${po.supplier}`}>{po.supplier_name}</Link> },
                { label: "Order date", value: <DateText value={po.order_date} bs={po.order_date_bs} /> },
                { label: "Expected delivery", value: <DateText value={po.expected_delivery_date} bs={po.expected_delivery_date_bs} /> },
                { label: "Warehouse", value: po.warehouse_name },
                { label: "Supplier reference", value: po.supplier_reference || "–" },
                { label: "Payment terms", value: `${po.payment_terms_days} days` },
                { label: "Created by", value: po.created_by_name ?? "–" },
                { label: "Submitted by", value: po.submitted_by_name ?? "–" },
                { label: "Approved by", value: po.approved_by_name ?? "–" },
              ]} />
            </Panel>
            <Panel title="Progress">
              <dl className="grid grid-cols-2 gap-3 p-4 text-[13px]">
                {[["Ordered", p.ordered], ["Received", p.received], ["Rejected", p.rejected], ["Billed", p.billed]].map(([label, value]) => (
                  <div key={label}><dt className="kv-label">{label}</dt><dd className="mt-0.5 tabular-nums">{formatQty(value)}</dd></div>
                ))}
              </dl>
              {open && pending > 0 && <p className="px-4 pb-4 text-xs text-slate-500">{formatQty(pending)} units still to be received.</p>}
            </Panel>
          </div>
          <Panel title="Items">
            <DocumentLines lines={lines} extra={[
              { key: "received_quantity", label: "Received", align: "right", render: (l) => (l.is_stock ? formatQty(l.received_quantity) : "–") },
              { key: "rejected_quantity", label: "Rejected", align: "right", render: (l) => (l.is_stock ? formatQty(l.rejected_quantity) : "–") },
              { key: "billed_quantity", label: "Billed", align: "right", render: (l) => formatQty(l.billed_quantity) },
            ]} />
            <div className="flex flex-col border-t border-line md:flex-row">
              <div className="flex-1 space-y-3 p-4 text-[13px] text-slate-600">
                {po.notes && <div><div className="kv-label mb-1">Notes</div><p className="whitespace-pre-line">{po.notes}</p></div>}
                {po.terms && <div><div className="kv-label mb-1">Terms</div><p className="whitespace-pre-line text-xs">{po.terms}</p></div>}
              </div>
              <DocumentTotals doc={po} />
            </div>
          </Panel>
        </TabPanel>
        <TabPanel value="activity"><DocumentTimeline resource="purchase-orders" id={po.id} /></TabPanel>
        <TabPanel value="files"><Attachments entityType="purchaseorder" entityId={po.id} canUpload={can("purchases.manage")} /></TabPanel>
      </Tabs>

      <ConfirmDialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)} title={`Reject ${po.number}`} requireReason
        confirmLabel="Reject order" tone="danger" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "reject", body: { reason }, success: "Order rejected" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "cancel"} onOpenChange={(o) => !o && setDialog(null)} title={`Cancel ${po.number}`} requireReason
        description="The order number is kept for the audit trail. Orders with posted receipts or bills are closed instead." confirmLabel="Cancel order"
        tone="danger" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "cancel", body: { reason }, success: "Order cancelled" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "close"} onOpenChange={(o) => !o && setDialog(null)} title="Close the remaining balance" requireReason
        description="Quantities not yet received are cancelled. Received goods can still be billed." confirmLabel="Close order" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "close", body: { reason }, success: "Order closed" }).then(() => setDialog(null))} />
      {dialog === "receive" && <GoodsReceiptDialog order={po} onClose={() => setDialog(null)} />}
      {dialog === "bill" && <CreateBillDialog order={po} onClose={() => setDialog(null)} />}
    </>
  );
}
