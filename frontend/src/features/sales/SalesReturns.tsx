import { Plus, Send, Trash2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { AllocationTable, allocationPayload } from "@/components/document/AllocationTable";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { DocumentTimeline } from "@/components/document/Timeline";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { NumberInput, Select, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";
import { RefundDialog, toOpenInvoices, useOpenInvoices } from "./Receipts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const INSPECTION = [{ value: "RESTOCK", label: "Good – restock" }, { value: "DAMAGED", label: "Damaged – do not restock" }, { value: "PENDING", label: "Pending inspection" }];

export function SalesReturnList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Sales returns" subtitle="Each posted return issues a credit note, applied first to the original invoice."
        actions={can("sales.return") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/sales/returns/new")}>New return</Button>} />
      <ResourceList resource="sales-returns" dated searchPlaceholder="Credit note, invoice, customer…" detailPath={(r) => `/sales/returns/${r.id}`}
        exportUrl="/sales-returns/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }] },
          { type: "entity", name: "customer", label: "Customer", resource: "customers" }]}
        columns={(ctx) => [
          col.doc("number", "Credit note"), col.date("date", "Date", ctx, { sortable: true }), col.text("customer_name", "Customer", { flex: 2 }),
          col.text("invoice_number", "Invoice"), col.text("reason", "Reason", { flex: 2 }), col.status("status", "Status", "status_label"),
          col.money("grand_total", "Credit"), col.money("unapplied_credit", "Unapplied"),
        ]} />
    </>
  );
}

interface ReturnRow { invoice_line: number; sku: string; product_name: string; unit: string; sold: string; returnable: number; quantity: string; inspection: string; unit_price: string; is_stock: boolean }

export function SalesReturnForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [invoiceId, setInvoiceId] = useState<number | null>(params.get("invoice") ? Number(params.get("invoice")) : null);
  const invoice = useDetail<any>("sales-invoices", invoiceId ?? undefined);
  const [warehouse, setWarehouse] = useState<number | null>(null);
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const inv = invoice.data;
    if (!inv) return;
    setWarehouse(inv.warehouse ?? null);
    setRows(inv.lines.map((l: any) => ({
      invoice_line: l.id, sku: l.sku, product_name: l.product_name, unit: l.unit, sold: l.quantity, unit_price: l.unit_price, is_stock: l.is_stock,
      returnable: toNumber(l.quantity) - toNumber(l.returned_quantity), quantity: "0", inspection: "RESTOCK",
    })));
  }, [invoice.data]);

  const save = async (post: boolean) => {
    const lines = rows.filter((r) => toNumber(r.quantity) > 0).map((r) => ({ invoice_line: r.invoice_line, quantity: r.quantity, inspection: r.inspection }));
    if (!invoiceId || !warehouse) return toast.error("Choose the invoice and the receiving warehouse.");
    if (!lines.length) return toast.error("Enter at least one quantity to return.");
    if (!reason.trim()) return toast.error("Give the reason for the return.");
    setSaving(true);
    try {
      const { data } = await api.post("/sales-returns/", { invoice: invoiceId, warehouse, date, reason, lines });
      if (post) await api.post(`/sales-returns/${data.id}/post/`);
      ["sales-returns", "sales-invoices", "customers", "inventory/balances"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      toast.success(post ? "Return posted and credit note issued" : "Draft saved");
      navigate(`/sales/returns/${data.id}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title="New sales return" back={{ to: "/sales/returns", label: "Sales returns" }}
        subtitle="Returns are raised against a posted invoice; prices and tax come from that invoice." />
      <div className="space-y-4">
        <Panel title="Return">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Original invoice" required className="lg:col-span-2">
              <EntitySelect resource="sales-invoices" value={invoiceId} params={{ status: "POSTED" }} onChange={(id) => setInvoiceId(id)}
                label={(i) => `${i.number} · ${i.customer_display}`} sublabel={(i) => `Total ${formatAmount(i.grand_total)}`} />
            </Field>
            <Field label="Return date" required><DatePicker value={date} onChange={setDate} min={invoice.data?.invoice_date} /></Field>
            <Field label="Receive into warehouse" required>
              <EntitySelect resource="warehouses" value={warehouse} onChange={(id) => setWarehouse(id)} clearable={false} />
            </Field>
            <Field label="Reason" required className="sm:col-span-2 lg:col-span-4"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
        </Panel>
        <Panel title="Items returned">
          {!invoiceId ? <p className="p-4 text-xs text-slate-500">Choose the invoice first.</p> : invoice.isLoading ? <LoadingBlock /> : (
            <table className="w-full text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2">Item</th><th className="px-4 py-2 text-right">Sold</th><th className="px-4 py-2 text-right">Returnable</th>
                  <th className="px-4 py-2 text-right">Rate</th><th className="w-28 px-4 py-2">Return qty</th><th className="w-56 px-4 py-2">Inspection</th></tr>
              </thead>
              <tbody>{rows.map((r, i) => (
                <tr key={r.invoice_line} className="border-b border-line">
                  <td className="px-4 py-1.5"><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></td>
                  <td className="num px-4 py-1.5">{formatQty(r.sold)} {r.unit}</td>
                  <td className="num px-4 py-1.5">{formatQty(r.returnable)}</td>
                  <td className="num px-4 py-1.5">{formatAmount(r.unit_price)}</td>
                  <td className="px-4 py-1.5"><NumberInput aria-label={`Return quantity for ${r.sku}`} value={r.quantity} invalid={toNumber(r.quantity) > r.returnable}
                    disabled={r.returnable <= 0} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></td>
                  <td className="px-4 py-1.5">{r.is_stock ? (
                    <Select value={r.inspection} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, inspection: e.target.value } : x)))}>
                      {INSPECTION.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>) : <span className="text-2xs text-slate-400">Service</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button loading={saving} onClick={() => save(false)}>Save draft</Button>
          <Button variant="primary" loading={saving} onClick={() => save(true)}>Post return</Button>
        </div>
      </div>
    </>
  );
}

function ApplyCreditDialog({ ret, onClose }: { ret: any; onClose: () => void }) {
  const open = useOpenInvoices(ret.customer);
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const action = useDocumentAction<any>("sales-returns", ret.id, ["sales-invoices"]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Apply credit ${ret.number}`} size="xl" description={`Unapplied credit: ${formatAmount(ret.unapplied_credit)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={action.isPending}
        onClick={() => action.mutateAsync({ action: "apply", body: { allocations: allocationPayload(allocations) }, success: "Credit applied" }).then(onClose)}>Apply</Button></>}>
      {open.isLoading ? <LoadingBlock /> : <AllocationTable documents={toOpenInvoices(open.data)} allocations={allocations} onChange={setAllocations} available={toNumber(ret.unapplied_credit)} />}
    </Dialog>
  );
}

export function SalesReturnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("sales-returns", id);
  const action = useDocumentAction<any>("sales-returns", id, ["sales-invoices", "customers"]);
  const [dialog, setDialog] = useState<null | "apply" | "refund">(null);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  const r = query.data;
  const unapplied = Number(r.unapplied_credit);
  return (
    <>
      <PageHeader back={{ to: "/sales/returns", label: "Sales returns" }} title={r.number || `Draft return #${r.id}`} meta={<StatusBadge status={r.status} label={r.status_label} />}
        subtitle={<>{r.customer_name} · <DateText value={r.date} bs={r.date_bs} /></>}
        actions={<>
          {r.status === "DRAFT" && can("sales.return") && <>
            <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => {
              try { await api.delete(`/sales-returns/${r.id}/`); navigate("/sales/returns"); } catch (e) { toast.error(errorMessage(e)); }
            }}>Delete</Button>
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending} onClick={() => action.mutate({ action: "post", success: "Return posted" })}>Post return</Button>
          </>}
          {r.status === "POSTED" && unapplied > 0 && can("sales.receipt") && <>
            <Button variant="primary" onClick={() => setDialog("apply")}>Apply credit</Button>
            <Button icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setDialog("refund")}>Refund</Button>
          </>}
          <PrintButton url={`/sales-returns/${r.id}/pdf/`} filename={r.number || "credit-note"} label="Credit note" />
        </>} />
      {r.status === "DRAFT" && <Alert tone="info" className="mb-4">Draft – stock and the customer balance change when the return is posted.</Alert>}
      <div className="space-y-4">
        <Panel title="Return">
          <KeyValues items={[
            { label: "Customer", value: <Link className="link" to={`/contacts/customers/${r.customer}`}>{r.customer_name}</Link> },
            { label: "Original invoice", value: <Link className="link" to={`/sales/invoices/${r.invoice}`}>{r.invoice_number}</Link> },
            { label: "Date", value: <DateText value={r.date} bs={r.date_bs} /> },
            { label: "Warehouse", value: r.warehouse_name },
            { label: "Reason", value: r.reason, wide: true },
            { label: "Credit applied", value: formatAmount(r.credit_applied) },
            { label: "Refunded", value: formatAmount(r.refunded_amount) },
          ]} />
        </Panel>
        <Panel title="Items">
          <DocumentLines lines={r.lines} extra={[{ key: "inspection", label: "Inspection", render: (l) => <StatusBadge status={l.inspection} /> }]} />
          <DocumentTotals doc={r}>
            {r.status === "POSTED" && <div className="mt-2 flex justify-between border-t border-line pt-2 font-medium"><span>Unapplied credit</span><span className="tabular-nums">{formatAmount(r.unapplied_credit)}</span></div>}
          </DocumentTotals>
        </Panel>
        <DocumentTimeline resource="sales-returns" id={r.id} />
      </div>
      {dialog === "apply" && <ApplyCreditDialog ret={r} onClose={() => setDialog(null)} />}
      {dialog === "refund" && <RefundDialog customer={r.customer} source={r.id} sourceField="credit_note" max={r.unapplied_credit} onClose={() => setDialog(null)} />}
    </>
  );
}
