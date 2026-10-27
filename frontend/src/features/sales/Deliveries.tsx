import { Send, Trash2 } from "lucide-react";
import { col, ResourceList } from "@/components/table";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { DocumentLines } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function DeliveryList() {
  return (
    <>
      <PageHeader title="Deliveries" subtitle="Goods dispatched against approved sales orders. Create deliveries from the order." />
      <ResourceList resource="deliveries" dated searchPlaceholder="Delivery no., order, customer…" detailPath={(r) => `/sales/deliveries/${r.id}`}
        exportUrl="/deliveries/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Dispatched" }, { value: "REVERSED", label: "Reversed" }] },
          { type: "entity", name: "customer", label: "Customer", resource: "customers" }]}
        columns={[
          col.doc("number", "Delivery", { sortable: true }),
          col.date("date", "Date", { sortable: true }),
          col.text("order_number", "Sales order"),
          col.text("customer_name", "Customer", { flex: 2 }),
          col.text("warehouse_name", "Warehouse"),
          col.text("vehicle_number", "Vehicle"),
          col.status("status", "Status", "status_label"),
        ]} />
    </>
  );
}

export function DeliveryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("deliveries", id);
  const action = useDocumentAction<any>("deliveries", id, ["sales-orders"]);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  const d = query.data;
  const totalCost = d.lines.reduce((a: number, l: any) => a + Number(l.cost_amount), 0);
  return (
    <>
      <PageHeader back={{ to: "/sales/deliveries", label: "Deliveries" }} title={d.number || `Draft delivery #${d.id}`}
        meta={<StatusBadge status={d.status} label={d.status_label} />}
        subtitle={<>{d.customer_name} · <DateText value={d.date} bs={d.date_bs} /></>}
        actions={<>
          {d.status === "DRAFT" && can("sales.deliver") && (
            <>
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
                try { await api.delete(`/deliveries/${d.id}/`); toast.success("Draft deleted"); navigate(`/sales/orders/${d.sales_order}`); }
                catch (e) { toast.error(errorMessage(e)); }
              }}>Delete draft</Button>
              <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "post", success: "Delivery posted" })}>Post delivery</Button>
            </>
          )}
          {d.status === "POSTED" && can("sales.deliver") && (
            <ReverseAction title={`Reverse ${d.number}`} loading={action.isPending}
              description="Stock is returned to the warehouse at its original cost and the cost-of-sales journal is reversed. Invoiced quantities must be reversed first."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Delivery reversed" })} />
          )}
          <PrintButton url={`/deliveries/${d.id}/pdf/`} filename={d.number || "delivery"} label="Delivery note" />
        </>} />
      {d.status === "DRAFT" && <Alert tone="info" className="mb-4">This delivery has not been posted. Stock has not moved yet.</Alert>}
      <div className="space-y-4">
        <Panel title="Delivery">
          <KeyValues items={[
            { label: "Sales order", value: <Link className="link" to={`/sales/orders/${d.sales_order}`}>{d.order_number}</Link> },
            { label: "Customer", value: <Link className="link" to={`/contacts/customers/${d.customer}`}>{d.customer_name}</Link> },
            { label: "Date", value: <DateText value={d.date} bs={d.date_bs} /> },
            { label: "Warehouse", value: d.warehouse_name },
            { label: "Vehicle", value: d.vehicle_number || "–" },
            { label: "Posted by", value: d.posted_by_name ?? "–" },
            { label: "Cost of goods", value: d.status === "DRAFT" ? "Calculated on posting" : formatAmount(totalCost) },
            { label: "Ship to", value: <span className="whitespace-pre-line">{d.shipping_address || "–"}</span> },
          ]} />
        </Panel>
        <Panel title="Items">
          <DocumentLines showPricing={false} lines={d.lines.map((l: any) => ({ ...l, product_name: l.product_name, sku: l.sku }))} extra={[
            col.qty("ordered_quantity", "Ordered"),
            col.custom("unit_cost", "Unit cost (FIFO)", (l) => (d.status === "DRAFT" ? "–" : formatAmount(l.unit_cost)), { align: "right" }),
            col.custom("cost_amount", "Cost", (l) => (d.status === "DRAFT" ? "–" : formatAmount(l.cost_amount)), { align: "right" }),
          ]} />
        </Panel>
        <DocumentTimeline resource="deliveries" id={d.id} />
      </div>
    </>
  );
}
