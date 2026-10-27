import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { DocumentLines } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const GRN_STATUSES = [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }];

interface ReceiveRow {
  order_line: number; product: number; sku: string; product_name: string; unit: string; ordered: string; received: string; pending: string;
  track_batches: boolean; track_serials: boolean; track_expiry: boolean;
  quantity: string; rejected: string; rejection_reason: string; batch_number: string; manufacture_date: string; expiry_date: string; serials: string;
}

const splitSerials = (value: string) => value.split(/[\s,]+/).filter(Boolean);

/** Records and posts a goods received note (accepted stock enters the warehouse at the order's net cost). */
export function GoodsReceiptDialog({ order, onClose }: { order: any; onClose: () => void }) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [deliveryNote, setDeliveryNote] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<ReceiveRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const query = useQuery({
    queryKey: ["purchase-orders", order.id, "receivable"],
    queryFn: async () => (await api.get(`/purchase-orders/${order.id}/receivable/`)).data,
  });
  const data: ReceiveRow[] = rows ?? (query.data ?? []).map((r: any) => ({
    ...r, ordered: String(r.ordered), received: String(r.received), pending: String(r.pending),
    quantity: String(r.pending), rejected: "0", rejection_reason: "", batch_number: "", manufacture_date: "", expiry_date: "", serials: "",
  }));
  const update = (i: number, patch: Partial<ReceiveRow>) => setRows(data.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const tracked = data.some((r) => r.track_batches || r.track_expiry || r.track_serials);

  const validate = (): string | null => {
    for (const r of data) {
      const received = toNumber(r.quantity);
      const rejected = toNumber(r.rejected);
      if (received <= 0) continue;
      const accepted = received - rejected;
      if (rejected < 0 || accepted < 0) return `${r.sku}: rejected quantity cannot exceed the quantity received.`;
      if (accepted > toNumber(r.pending)) return `${r.sku}: accepting ${formatQty(accepted)} exceeds the pending quantity ${formatQty(r.pending)}.`;
      if (rejected > 0 && !r.rejection_reason.trim()) return `${r.sku}: give a reason for the rejected quantity.`;
      if (accepted > 0 && r.track_batches && !r.batch_number.trim()) return `${r.sku}: enter the batch number.`;
      if (accepted > 0 && r.track_expiry && !r.expiry_date) return `${r.sku}: enter the expiry date.`;
      if (accepted > 0 && r.track_serials && splitSerials(r.serials).length !== accepted) return `${r.sku}: enter exactly ${formatQty(accepted)} serial number(s).`;
    }
    return null;
  };

  const submit = async () => {
    const lines = data.filter((r) => toNumber(r.quantity) > 0).map((r) => ({
      order_line: r.order_line, received_quantity: r.quantity, rejected_quantity: r.rejected || "0",
      rejection_reason: toNumber(r.rejected) > 0 ? r.rejection_reason.trim() : "",
      batch_number: r.batch_number.trim(), manufacture_date: r.manufacture_date || null, expiry_date: r.expiry_date || null,
      serial_numbers: r.track_serials ? splitSerials(r.serials) : [],
    }));
    if (!lines.length) return toast.error("Enter a quantity received.");
    const problem = validate();
    if (problem) return toast.error(problem);
    setSaving(true);
    let grnId: number | null = null;
    try {
      const { data: created } = await api.post("/goods-received-notes/", {
        purchase_order: order.id, date, supplier_delivery_note: deliveryNote, notes, lines,
      });
      grnId = created.id;
      await api.post(`/goods-received-notes/${created.id}/post/`);
      toast.success("Goods receipt posted; stock received");
      ["purchase-orders", "goods-received-notes", "inventory/balances", "products", "dashboard"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onClose();
      navigate(`/purchases/grns/${created.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      if (grnId) {
        qc.invalidateQueries({ queryKey: ["goods-received-notes"] });
        toast.message("The goods receipt was saved as a draft so you can correct it.");
        onClose();
        navigate(`/purchases/grns/${grnId}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Receive goods for ${order.number}`} size="xl"
      description="Quantities default to what is still pending. Accepted quantities enter stock at the order's net unit cost."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={query.isLoading || !data.length} onClick={submit}>Post goods receipt</Button></>}>
      {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !data.length ? (
        <p className="py-4 text-[13px] text-slate-600">Every stock item on this order has been received.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Receipt date" required><DatePicker value={date} onChange={setDate} min={order.order_date} /></Field>
            <Field label="Supplier delivery note"><Input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} placeholder="Challan / delivery note no." /></Field>
            <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="border-b border-line text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1.5">Item</th><th className="text-right">Pending</th><th className="w-24 pl-3 text-right">Received</th>
                  <th className="w-24 pl-3 text-right">Rejected</th><th className="pl-3">Rejection reason</th>
                  {tracked && <th className="w-64 pl-3">Batch / serials</th>}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => {
                  const rejected = toNumber(r.rejected);
                  const accepted = toNumber(r.quantity) - rejected;
                  return (
                    <tr key={r.order_line} className="border-b border-line align-top">
                      <td className="py-2"><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></td>
                      <td className="num py-2">{formatQty(r.pending)} {r.unit}</td>
                      <td className="py-1.5 pl-3"><NumberInput aria-label={`Received quantity for ${r.sku}`} value={r.quantity}
                        onChange={(e) => update(i, { quantity: e.target.value })} /></td>
                      <td className="py-1.5 pl-3"><NumberInput aria-label={`Rejected quantity for ${r.sku}`} value={r.rejected}
                        invalid={rejected < 0 || accepted < 0} onChange={(e) => update(i, { rejected: e.target.value })} /></td>
                      <td className="py-1.5 pl-3">
                        <Input aria-label={`Rejection reason for ${r.sku}`} value={r.rejection_reason} disabled={rejected <= 0}
                          invalid={rejected > 0 && !r.rejection_reason.trim()} placeholder={rejected > 0 ? "Damaged, wrong item…" : ""}
                          onChange={(e) => update(i, { rejection_reason: e.target.value })} />
                        {accepted > 0 && rejected > 0 && <div className="mt-1 text-2xs text-slate-500">Accepting {formatQty(accepted)}</div>}
                      </td>
                      {tracked && (
                        <td className="space-y-1.5 py-1.5 pl-3">
                          {(r.track_batches || r.track_expiry) && (
                            <>
                              <Input aria-label={`Batch for ${r.sku}`} placeholder="Batch number" value={r.batch_number}
                                onChange={(e) => update(i, { batch_number: e.target.value })} />
                              <div className="grid grid-cols-2 gap-1.5">
                                <div><div className="text-2xs text-slate-500">Manufactured</div>
                                  <DatePicker value={r.manufacture_date} onChange={(v) => update(i, { manufacture_date: v })} max={date} compact /></div>
                                <div><div className="text-2xs text-slate-500">Expiry{r.track_expiry ? " (required)" : ""}</div>
                                  <DatePicker value={r.expiry_date} onChange={(v) => update(i, { expiry_date: v })} min={r.manufacture_date || undefined} compact /></div>
                              </div>
                            </>
                          )}
                          {r.track_serials && <Input aria-label={`Serial numbers for ${r.sku}`} placeholder="Serial numbers, comma separated"
                            value={r.serials} onChange={(e) => update(i, { serials: e.target.value })} />}
                          {!r.track_batches && !r.track_expiry && !r.track_serials && <span className="text-2xs text-slate-400">–</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
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
        columns={(ctx) => [
          col.doc("number", "GRN"),
          col.date("date", "Date", ctx),
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
            { key: "ordered_quantity", label: "Ordered", align: "right", render: (l) => formatQty(l.ordered_quantity) },
            { key: "accepted_quantity", label: "Accepted", align: "right", render: (l) => formatQty(l.accepted_quantity) },
            ...(anyRejected ? [{ key: "rejected_quantity", label: "Rejected", render: (l: any) => (Number(l.rejected_quantity) > 0
              ? <span>{formatQty(l.rejected_quantity)}<span className="block text-2xs text-slate-500">{l.rejection_reason}</span></span> : "–") }] : []),
            ...(dated ? [{ key: "expiry_date", label: "Mfg / expiry", render: (l: any) => (
              <span className="text-xs">
                {l.manufacture_date ? <span className="block">Mfg <DateText value={l.manufacture_date} /></span> : null}
                {l.expiry_date ? <span className="block">Exp <DateText value={l.expiry_date} /></span> : null}
                {!l.manufacture_date && !l.expiry_date && "–"}
              </span>
            ) }] : []),
            { key: "unit_cost", label: "Unit cost", align: "right", render: (l) => (draft ? "–" : formatAmount(l.unit_cost)) },
            { key: "billed_quantity", label: "Billed", align: "right", render: (l) => formatQty(l.billed_quantity) },
          ]} />
        </Panel>
        <DocumentTimeline resource="goods-received-notes" id={g.id} />
      </div>
    </>
  );
}
