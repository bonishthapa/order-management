import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { DocumentLines } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { CellDate, CellInput, FormDialog, FormField, FormGrid, useWatch } from "@/components/form";
import { BaseTable, ResourceList, col, type TableColumn } from "@/components/table";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const GRN_STATUSES = [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }];

interface ReceiveLine {
  order_line: number; product: number; sku: string; product_name: string; unit: string; pending: string;
  track_batches: boolean; track_serials: boolean; track_expiry: boolean;
  received_quantity: string; rejected_quantity: string; rejection_reason: string; batch_number: string;
  manufacture_date: string; expiry_date: string; serials: string;
}
interface ReceiveValues { date: string; supplier_delivery_note: string; notes: string; lines: ReceiveLine[] }

const splitSerials = (value: string) => value.split(/[\s,]+/).filter(Boolean);

function lineProblem(r: ReceiveLine): string | null {
  const received = toNumber(r.received_quantity);
  const rejected = toNumber(r.rejected_quantity);
  if (received <= 0) return null;
  const accepted = received - rejected;
  if (rejected < 0 || accepted < 0) return `${r.sku}: rejected quantity cannot exceed the quantity received.`;
  if (accepted > toNumber(r.pending)) return `${r.sku}: accepting ${formatQty(accepted)} exceeds the pending quantity ${formatQty(r.pending)}.`;
  if (rejected > 0 && !r.rejection_reason.trim()) return `${r.sku}: give a reason for the rejected quantity.`;
  if (accepted > 0 && r.track_batches && !r.batch_number.trim()) return `${r.sku}: enter the batch number.`;
  if (accepted > 0 && r.track_expiry && !r.expiry_date) return `${r.sku}: enter the expiry date.`;
  if (accepted > 0 && r.track_serials && splitSerials(r.serials).length !== accepted) return `${r.sku}: enter exactly ${formatQty(accepted)} serial number(s).`;
  return null;
}

function ReceiveLinesTable() {
  const lines: ReceiveLine[] = useWatch({ name: "lines" }) ?? [];
  const date: string = useWatch({ name: "date" });
  const tracked = lines.some((r) => r.track_batches || r.track_expiry || r.track_serials);
  const columns: TableColumn<ReceiveLine>[] = [
    col.custom("product_name", "Item", (r) => <><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></>),
    col.custom("pending", "Pending", (r) => `${formatQty(r.pending)} ${r.unit}`, { align: "right" }),
    col.custom("received_quantity", "Received", (r) => (
      <CellInput number name={`lines.${lines.indexOf(r)}.received_quantity`} label={`Received quantity for ${r.sku}`} />
    ), { width: 104 }),
    col.custom("rejected_quantity", "Rejected", (r) => {
      const rejected = toNumber(r.rejected_quantity);
      return <CellInput number name={`lines.${lines.indexOf(r)}.rejected_quantity`} label={`Rejected quantity for ${r.sku}`}
        invalid={rejected < 0 || rejected > toNumber(r.received_quantity)} />;
    }, { width: 104 }),
    col.custom("rejection_reason", "Rejection reason", (r) => {
      const rejected = toNumber(r.rejected_quantity);
      const accepted = toNumber(r.received_quantity) - rejected;
      return (
        <>
          <CellInput name={`lines.${lines.indexOf(r)}.rejection_reason`} label={`Rejection reason for ${r.sku}`} disabled={rejected <= 0}
            invalid={rejected > 0 && !r.rejection_reason.trim()} placeholder={rejected > 0 ? "Damaged, wrong item…" : ""} />
          {accepted > 0 && rejected > 0 && <div className="mt-1 text-2xs text-slate-500">Accepting {formatQty(accepted)}</div>}
        </>
      );
    }),
    ...(tracked ? [col.custom<ReceiveLine>("batch_number", "Batch / serials", (r) => {
      const i = lines.indexOf(r);
      return (
        <div className="space-y-1.5">
          {(r.track_batches || r.track_expiry) && (
            <>
              <CellInput name={`lines.${i}.batch_number`} label={`Batch for ${r.sku}`} placeholder="Batch number" />
              <div className="grid grid-cols-2 gap-1.5">
                <div><div className="text-2xs text-slate-500">Manufactured</div><CellDate name={`lines.${i}.manufacture_date`} max={date} /></div>
                <div><div className="text-2xs text-slate-500">Expiry{r.track_expiry ? " (required)" : ""}</div>
                  <CellDate name={`lines.${i}.expiry_date`} min={r.manufacture_date} /></div>
              </div>
            </>
          )}
          {r.track_serials && <CellInput name={`lines.${i}.serials`} label={`Serial numbers for ${r.sku}`} placeholder="Serial numbers, comma separated" />}
          {!r.track_batches && !r.track_expiry && !r.track_serials && <span className="text-2xs text-slate-400">–</span>}
        </div>
      );
    }, { width: 256 })] : []),
  ];
  return <BaseTable columns={columns} rows={lines} rowKey={(r) => r.order_line} density="compact" minWidth={760} />;
}

/** Records and posts a goods received note (accepted stock enters the warehouse at the order's net cost). */
export function GoodsReceiptDialog({ order, onClose }: { order: any; onClose: () => void }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["purchase-orders", order.id, "receivable"],
    queryFn: async () => (await api.get(`/purchase-orders/${order.id}/receivable/`)).data,
  });
  const title = `Receive goods for ${order.number}`;
  const description = "Quantities default to what is still pending. Accepted quantities enter stock at the order's net unit cost.";

  if (query.isLoading || query.error || !query.data?.length) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title={title} size="xl" description={description}
        footer={<Button onClick={onClose}>Close</Button>}>
        {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} />
          : <p className="py-4 text-[13px] text-slate-600">Every stock item on this order has been received.</p>}
      </Dialog>
    );
  }

  const defaultValues: ReceiveValues = {
    date: todayIn(session?.organization?.timezone), supplier_delivery_note: "", notes: "",
    lines: query.data.map((r: any) => ({
      ...r, pending: String(r.pending), received_quantity: String(r.pending), rejected_quantity: "0", rejection_reason: "",
      batch_number: "", manufacture_date: "", expiry_date: "", serials: "",
    })),
  };

  const submit = async (values: ReceiveValues) => {
    const chosen = values.lines.filter((r) => toNumber(r.received_quantity) > 0);
    if (!chosen.length) throw new Error("Enter a quantity received.");
    const problem = chosen.map(lineProblem).find(Boolean);
    if (problem) throw new Error(problem);
    const { data: created } = await api.post("/goods-received-notes/", {
      purchase_order: order.id, date: values.date, supplier_delivery_note: values.supplier_delivery_note, notes: values.notes,
      lines: chosen.map((r) => ({
        order_line: r.order_line, received_quantity: r.received_quantity, rejected_quantity: r.rejected_quantity || "0",
        rejection_reason: toNumber(r.rejected_quantity) > 0 ? r.rejection_reason.trim() : "",
        batch_number: r.batch_number.trim(), manufacture_date: r.manufacture_date || null, expiry_date: r.expiry_date || null,
        serial_numbers: r.track_serials ? splitSerials(r.serials) : [],
      })),
    });
    try {
      await api.post(`/goods-received-notes/${created.id}/post/`);
      toast.success("Goods receipt posted; stock received");
    } catch (e) {
      toast.error(errorMessage(e));
      toast.message("The goods receipt was saved as a draft so you can correct it.");
    }
    ["purchase-orders", "goods-received-notes", "inventory/balances", "products", "dashboard"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    navigate(`/purchases/grns/${created.id}`);
  };

  return (
    <FormDialog<ReceiveValues> open onOpenChange={(o) => !o && onClose()} title={title} size="xl" description={description}
      defaultValues={defaultValues} onSubmit={submit} submitLabel="Post goods receipt">
      <div className="space-y-3">
        <FormGrid columns={3}>
          <FormField name="date" label="Receipt date" type="date" required min={order.order_date} />
          <FormField name="supplier_delivery_note" label="Supplier delivery note" placeholder="Challan / delivery note no." />
          <FormField name="notes" label="Notes" />
        </FormGrid>
        <ReceiveLinesTable />
      </div>
    </FormDialog>
  );
}

export function GoodsReceiptList() {
  return (
    <>
      <PageHeader title="Goods received notes" subtitle="Stock received against approved purchase orders. Receive goods from the order." />
      <ResourceList resource="goods-received-notes" dated searchPlaceholder="GRN no., order, supplier, delivery note…" detailPath={(r) => `/purchases/grns/${r.id}`}
        exportUrl="/goods-received-notes/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: GRN_STATUSES },
          { type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" },
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" }]}
        columns={[
          col.doc("number", "GRN"),
          col.date("date", "Date"),
          col.text("order_number", "Purchase order"),
          col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("warehouse_name", "Warehouse"),
          col.text("supplier_delivery_note", "Delivery note"),
          col.status("status", "Status", "status_label"),
          col.money("total_value", "Stock value"),
        ]}
        empty={{ title: "No goods receipts", description: "Open an approved purchase order and use “Receive goods”." }} />
    </>
  );
}

export function GoodsReceiptDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("goods-received-notes", id);
  const action = useDocumentAction<any>("goods-received-notes", id, ["purchase-orders"]);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const g = query.data;
  const draft = g.status === "DRAFT";
  const dated = g.lines.some((l: any) => l.manufacture_date || l.expiry_date);
  const anyRejected = g.lines.some((l: any) => Number(l.rejected_quantity) > 0);
  return (
    <>
      <PageHeader back={{ to: "/purchases/grns", label: "Goods received notes" }} title={g.number || `Draft goods receipt #${g.id}`}
        meta={<StatusBadge status={g.status} label={g.status_label} />}
        subtitle={<>{g.supplier_name} · <DateText value={g.date} bs={g.date_bs} /></>}
        actions={<>
          {draft && can("purchases.receive") && (
            <>
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
                try { await api.delete(`/goods-received-notes/${g.id}/`); toast.success("Draft deleted"); navigate(`/purchases/orders/${g.purchase_order}`); }
                catch (e) { toast.error(errorMessage(e)); }
              }}>Delete draft</Button>
              <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
                onClick={() => action.mutate({ action: "post", success: "Goods receipt posted" })}>Post goods receipt</Button>
            </>
          )}
          {g.status === "POSTED" && can("purchases.receive") && (
            <ReverseAction title={`Reverse ${g.number}`} loading={action.isPending}
              description="The received stock is removed from the warehouse at its receipt cost and the inventory journal is reversed. Billed receipts cannot be reversed; raise a purchase return instead."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Goods receipt reversed" })} />
          )}
          <PrintButton url={`/goods-received-notes/${g.id}/pdf/`} filename={g.number || "goods-receipt"} label="GRN" />
        </>} />
      {draft && <Alert tone="info" className="mb-4">This goods receipt has not been posted. Stock has not moved yet.</Alert>}
      {g.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">Stock received on this note has been taken back out of the warehouse.</Alert>}
      <div className="space-y-4">
        <Panel title="Goods receipt">
          <KeyValues items={[
            { label: "Purchase order", value: <Link className="link" to={`/purchases/orders/${g.purchase_order}`}>{g.order_number}</Link> },
            { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${g.supplier}`}>{g.supplier_name}</Link> },
            { label: "Date", value: <DateText value={g.date} bs={g.date_bs} /> },
            { label: "Warehouse", value: g.warehouse_name },
            { label: "Supplier delivery note", value: g.supplier_delivery_note || "–" },
            { label: "Received by", value: g.received_by_name ?? "–" },
            { label: "Stock value", value: draft ? "Calculated on posting" : formatAmount(g.total_value) },
            { label: "Journal", value: g.journal ? <Link className="link" to={`/finance/journals/${g.journal}`}>View journal</Link> : "–" },
            ...(g.notes ? [{ label: "Notes", value: <span className="whitespace-pre-line">{g.notes}</span>, wide: true }] : []),
          ]} />
        </Panel>
        <Panel title="Items">
          <DocumentLines showPricing={false} lines={g.lines.map((l: any) => ({ ...l, quantity: l.received_quantity }))} extra={[
            col.qty("ordered_quantity", "Ordered"),
            col.qty("accepted_quantity", "Accepted"),
            ...(anyRejected ? [col.custom("rejected_quantity", "Rejected", (l: any) => (Number(l.rejected_quantity) > 0
              ? <span>{formatQty(l.rejected_quantity)}<span className="block text-2xs text-slate-500">{l.rejection_reason}</span></span> : "–"))] : []),
            ...(dated ? [col.custom("expiry_date", "Mfg / expiry", (l: any) => (
              <span className="text-xs">
                {l.manufacture_date ? <span className="block">Mfg <DateText value={l.manufacture_date} /></span> : null}
                {l.expiry_date ? <span className="block">Exp <DateText value={l.expiry_date} /></span> : null}
                {!l.manufacture_date && !l.expiry_date && "–"}
              </span>
            ))] : []),
            col.custom("unit_cost", "Unit cost", (l: any) => (draft ? "–" : formatAmount(l.unit_cost)), { align: "right" }),
            col.qty("billed_quantity", "Billed"),
          ]} />
        </Panel>
        <DocumentTimeline resource="goods-received-notes" id={g.id} />
      </div>
    </>
  );
}
