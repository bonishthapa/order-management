import { CheckCircle2, FileText, Pencil, Plus, Send, Truck, XCircle } from "lucide-react";
import { col, ResourceList } from "@/components/table";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { todayIn } from "@/calendar/bs";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { DocumentTimeline } from "@/components/document/Timeline";
import { TradeDocumentForm } from "@/components/document/TradeDocumentForm";
import { Attachments } from "@/components/document/Attachments";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatAmount, formatQty } from "@/utils/format";
import { DeliveryDialog } from "./DeliveryDialog";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const SO_STATUSES = [
  { value: "DRAFT", label: "Draft" }, { value: "SUBMITTED", label: "Awaiting approval" }, { value: "APPROVED", label: "Approved" },
  { value: "PARTIAL", label: "Partially delivered" }, { value: "COMPLETED", label: "Completed" }, { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
];

export function SalesOrderList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Sales orders" subtitle="Orders reserve stock when approved; revenue is recognised only on invoicing."
        actions={can("sales.manage") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/sales/orders/new")}>New order</Button>} />
      <ResourceList
        resource="sales-orders"
        dated
        searchPlaceholder="Order no., customer…"
        detailPath={(r) => `/sales/orders/${r.id}`}
        exportUrl="/sales-orders/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: SO_STATUSES }, { type: "entity", name: "customer", label: "Customer", resource: "customers" }]}
        columns={[
          col.doc("number", "Order", { sortable: true }),
          col.date("order_date", "Date", { sortable: true }),
          col.text("customer_name", "Customer", { flex: 2, sortable: true, sortField: "customer__name" }),
          col.text("warehouse_code", "Warehouse", { maxWidth: 120 }),
          col.date("expected_delivery_date", "Expected", { sortable: true }),
          col.status("status", "Status", "status_label"),
          col.money("grand_total", "Amount", { sortable: true }),
        ]}
        empty={{ title: "No sales orders", description: "Create an order to reserve stock for a customer." }}
      />
    </>
  );
}

const orderFormProps = {
  resource: "sales-orders",
  detailPath: (id: number) => `/sales/orders/${id}`,
  party: { field: "customer" as const, resource: "customers", label: "Customer" },
  dateField: "order_date",
  dateLabel: "Order date",
  secondaryDate: { field: "expected_delivery_date", label: "Expected delivery" },
  referenceField: { field: "customer_reference", label: "Customer PO / reference" },
  warehouse: { required: true, label: "Fulfil from warehouse" },
  priceMode: "sales" as const,
};

export function SalesOrderForm() {
  const { id } = useParams();
  const query = useDetail<any>("sales-orders", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && query.error) return <ErrorState error={query.error} />;
  const doc = query.data;
  return (
    <>
      <PageHeader title={doc ? `Edit ${doc.number}` : "New sales order"} back={{ to: doc ? `/sales/orders/${doc.id}` : "/sales/orders", label: doc ? doc.number : "Sales orders" }} />
      {doc && doc.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{doc.rejection_reason} Saving returns the order to draft.</Alert>}
      <TradeDocumentForm {...orderFormProps} initial={doc} />
    </>
  );
}

export function SalesOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const query = useDetail<any>("sales-orders", id);
  const action = useDocumentAction<any>("sales-orders", id, ["deliveries", "sales-invoices"]);
  const [dialog, setDialog] = useState<null | "reject" | "cancel" | "close" | "deliver" | "override">(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const so = query.data;
  const open = ["APPROVED", "PARTIAL"].includes(so.status);
  const f = so.fulfilment;

  const approve = async (override = false) => {
    try {
      await action.mutateAsync({ action: "approve", body: { override_credit_limit: override }, success: "Order approved; stock reserved" });
      setDialog(null);
    } catch (e: any) {
      if (e?.response?.data?.code === "credit_limit") setDialog("override");
    }
  };
  const createInvoice = async () => {
    setCreatingInvoice(true);
    try {
      const { data: lines } = await api.get(`/sales-orders/${so.id}/invoiceable/`);
      if (!lines.length) throw new Error("Nothing to invoice yet: deliver the goods first.");
      const { data } = await api.post("/sales-invoices/", {
        customer: so.customer, sales_order: so.id, invoice_date: todayIn(session?.organization?.timezone), customer_reference: so.customer_reference,
        lines: lines.map((l: any) => ({ order_line: l.order_line, product: l.product, quantity: l.quantity, unit_price: l.unit_price, description: l.description })),
      });
      navigate(`/sales/invoices/${data.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCreatingInvoice(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: "/sales/orders", label: "Sales orders" }}
        title={so.number}
        meta={<StatusBadge status={so.status} label={so.status_label} />}
        subtitle={<>{so.customer_name} · <DateText value={so.order_date} bs={so.order_date_bs} /></>}
        actions={<>
          {["DRAFT", "REJECTED"].includes(so.status) && can("sales.manage") && (
            <>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/sales/orders/${so.id}/edit`)}>Edit</Button>
              <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "submit", success: "Submitted for approval" })}>Submit</Button>
            </>
          )}
          {so.status === "SUBMITTED" && can("sales.approve") && (
            <>
              <Button icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("reject")}>Reject</Button>
              <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={action.isPending} onClick={() => approve()}>Approve</Button>
            </>
          )}
          {open && can("sales.deliver") && <Button variant="primary" icon={<Truck className="h-3.5 w-3.5" />} onClick={() => setDialog("deliver")}>Deliver</Button>}
          {["APPROVED", "PARTIAL", "COMPLETED"].includes(so.status) && can("sales.invoice") && Number(f.delivered) > Number(f.invoiced) && (
            <Button icon={<FileText className="h-3.5 w-3.5" />} loading={creatingInvoice} onClick={createInvoice}>Create invoice</Button>
          )}
          <PrintButton url={`/sales-orders/${so.id}/pdf/`} filename={so.number} />
          {(open || ["DRAFT", "SUBMITTED"].includes(so.status)) && (
            <Menu>
              <MenuTrigger asChild><Button>More</Button></MenuTrigger>
              <MenuContent>
                {open && can("sales.approve") && <MenuItem onSelect={() => action.mutate({ action: "reserve", success: "Reservation updated" })}>Reserve available stock</MenuItem>}
                {so.status === "PARTIAL" && can("sales.approve") && <MenuItem onSelect={() => setDialog("close")}>Close and cancel backorder</MenuItem>}
                {Number(f.delivered) === 0 && <MenuItem danger onSelect={() => setDialog("cancel")}>Cancel order</MenuItem>}
              </MenuContent>
            </Menu>
          )}
        </>}
      />
      {so.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{so.rejection_reason}</Alert>}
      {so.status === "CANCELLED" && <Alert tone="info" className="mb-4" title="Cancelled">{so.cancellation_reason}</Alert>}

      <Tabs defaultValue="overview">
        <TabList className="mb-4" tabs={[{ value: "overview", label: "Overview" }, { value: "activity", label: "Activity and documents" },
          { value: "files", label: "Attachments" }]} />
        <TabPanel value="overview" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Order" className="lg:col-span-2">
              <KeyValues items={[
                { label: "Customer", value: <Link className="link" to={`/contacts/customers/${so.customer}`}>{so.customer_name}</Link> },
                { label: "Order date", value: <DateText value={so.order_date} bs={so.order_date_bs} /> },
                { label: "Expected delivery", value: <DateText value={so.expected_delivery_date} bs={so.expected_delivery_date_bs} /> },
                { label: "Warehouse", value: so.warehouse_name },
                { label: "Customer reference", value: so.customer_reference || "–" },
                { label: "Payment terms", value: `${so.payment_terms_days} days` },
                { label: "Ship to", value: <span className="whitespace-pre-line">{so.shipping_address || "–"}</span>, wide: true },
                { label: "Created by", value: so.created_by_name },
                { label: "Approved by", value: so.approved_by_name ?? "–" },
              ]} />
            </Panel>
            <Panel title="Fulfilment">
              <dl className="grid grid-cols-2 gap-3 p-4 text-[13px]">
                {[["Ordered", f.ordered], ["Reserved", f.reserved], ["Delivered", f.delivered], ["Invoiced", f.invoiced], ["Backorder", f.backorder]].map(([label, value]) => (
                  <div key={label}><dt className="kv-label">{label}</dt><dd className="mt-0.5 tabular-nums">{formatQty(value)}</dd></div>
                ))}
              </dl>
              {Number(f.backorder) > 0 && <p className="px-4 pb-4 text-xs text-amber-700">Short of stock for {formatQty(f.backorder)} units. Use “Reserve available stock” after goods arrive.</p>}
            </Panel>
          </div>
          <Panel title="Items">
            <DocumentLines lines={so.lines} extra={[
              col.qty("reserved_quantity", "Reserved"),
              col.qty("delivered_quantity", "Delivered"),
              col.qty("invoiced_quantity", "Invoiced"),
            ]} />
            <div className="flex flex-col border-t border-line md:flex-row">
              <div className="flex-1 p-4 text-[13px] text-slate-600">
                {so.notes && <><div className="kv-label mb-1">Notes</div><p className="whitespace-pre-line">{so.notes}</p></>}
              </div>
              <DocumentTotals doc={so} />
            </div>
          </Panel>
        </TabPanel>
        <TabPanel value="activity"><DocumentTimeline resource="sales-orders" id={so.id} /></TabPanel>
        <TabPanel value="files"><Attachments entityType="salesorder" entityId={so.id} canUpload={can("sales.manage")} /></TabPanel>
      </Tabs>

      <ConfirmDialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)} title={`Reject ${so.number}`} requireReason
        confirmLabel="Reject order" tone="danger" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "reject", body: { reason }, success: "Order rejected" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "cancel"} onOpenChange={(o) => !o && setDialog(null)} title={`Cancel ${so.number}`} requireReason
        description="Reserved stock is released. The order number is kept for the audit trail." confirmLabel="Cancel order" tone="danger"
        loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "cancel", body: { reason }, success: "Order cancelled" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "close"} onOpenChange={(o) => !o && setDialog(null)} title="Close the remaining backorder" requireReason
        description="Undelivered quantities are cancelled and their reservations released." confirmLabel="Close order" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "close", body: { reason }, success: "Order closed" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "override"} onOpenChange={(o) => !o && setDialog(null)} title="Credit limit exceeded"
        description={<>This order takes {so.customer_name} over the credit limit ({formatAmount(so.grand_total)} order value). Approve anyway? The override is recorded in the audit trail.</>}
        confirmLabel="Approve with override" loading={action.isPending} onConfirm={() => approve(true)} />
      {dialog === "deliver" && <DeliveryDialog order={so} onClose={() => setDialog(null)} />}
    </>
  );
}
