import { Plus, Send, Trash2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { AllocationTable, allocationPayload } from "@/components/document/AllocationTable";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { DocumentTimeline } from "@/components/document/Timeline";
import { BaseForm, CellInput, FormField, FormSection, useFormContext, useWatch } from "@/components/form";
import { BaseTable, ResourceList, col, type TableColumn } from "@/components/table";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";
import { SupplierRefundDialog, toOpenBills, useOpenBills } from "./SupplierPayments";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function PurchaseReturnList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Purchase returns" subtitle="Each posted return raises a debit note, applied first to the original bill."
        actions={can("purchases.return") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/purchases/returns/new")}>New return</Button>} />
      <ResourceList resource="purchase-returns" dated searchPlaceholder="Debit note, bill, supplier, reason…" detailPath={(r) => `/purchases/returns/${r.id}`}
        exportUrl="/purchase-returns/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }] },
          { type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" }]}
        columns={[
          col.doc("number", "Debit note"), col.date("date", "Date"), col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("bill_number", "Bill"), col.text("reason", "Reason", { flex: 2 }), col.status("status", "Status", "status_label"),
          col.money("grand_total", "Debit"), col.money("unapplied_credit", "Unapplied"),
        ]}
        empty={{ title: "No purchase returns", description: "Raise a return from a posted supplier bill to send goods back." }} />
    </>
  );
}

interface ReturnRow {
  bill_line: number; sku: string; product_name: string; unit: string; billed: string; returnable: number; quantity: string; unit_price: string;
  is_stock: boolean; track_batches: boolean; track_serials: boolean; batch_number: string; serials: string;
}
interface ReturnValues { bill: number | null; warehouse: number | null; date: string; reason: string; lines: ReturnRow[] }

const splitSerials = (value: string) => value.split(/[\s,]+/).filter(Boolean);

export function PurchaseReturnForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();

  const submit = async (values: ReturnValues, _form: unknown, intent: string) => {
    const post = intent === "post";
    const chosen = values.lines.filter((r) => toNumber(r.quantity) > 0);
    if (!chosen.length) throw new Error("Enter at least one quantity to return.");
    const over = chosen.find((r) => toNumber(r.quantity) > r.returnable);
    if (over) throw new Error(`${over.sku}: at most ${formatQty(over.returnable)} can be returned.`);
    const missingBatch = chosen.find((r) => r.is_stock && r.track_batches && !r.batch_number.trim());
    if (missingBatch) throw new Error(`${missingBatch.sku}: enter the batch being returned.`);
    const serialMismatch = chosen.find((r) => r.is_stock && r.track_serials && splitSerials(r.serials).length !== toNumber(r.quantity));
    if (serialMismatch) throw new Error(`${serialMismatch.sku}: enter exactly ${formatQty(serialMismatch.quantity)} serial number(s).`);
    const lines = chosen.map((r) => ({
      bill_line: r.bill_line, quantity: r.quantity,
      ...(r.is_stock && r.track_batches ? { batch_number: r.batch_number.trim() } : {}),
      ...(r.is_stock && r.track_serials ? { serial_numbers: splitSerials(r.serials) } : {}),
    }));
    const { data } = await api.post("/purchase-returns/", { bill: values.bill, warehouse: values.warehouse, date: values.date, reason: values.reason.trim(), lines });
    let posted = false;
    if (post) {
      try {
        await api.post(`/purchase-returns/${data.id}/post/`);
        posted = true;
      } catch (e) {
        toast.error(errorMessage(e));
        toast.message("The return was saved as a draft so you can correct it.");
      }
    }
    ["purchase-returns", "purchase-bills", "suppliers", "inventory/balances", "products"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    if (posted) toast.success("Return posted and debit note raised");
    else if (!post) toast.success("Draft saved");
    navigate(`/purchases/returns/${data.id}`);
  };

  return (
    <>
      <PageHeader title="New purchase return" back={{ to: "/purchases/returns", label: "Purchase returns" }}
        subtitle="Returns are raised against a posted supplier bill; prices and tax come from that bill." />
      <BaseForm<ReturnValues> onSubmit={submit} onCancel={() => navigate(-1)}
        submitActions={[{ key: "draft", label: "Save draft" }, { key: "post", label: "Post return", primary: true }]}
        defaultValues={{ bill: params.get("bill") ? Number(params.get("bill")) : null, warehouse: null,
          date: todayIn(session?.organization?.timezone), reason: "", lines: [] }}>
        <ReturnFields />
      </BaseForm>
    </>
  );
}

function ReturnFields() {
  const { setValue } = useFormContext();
  const billId = useWatch({ name: "bill" }) as number | null;
  const bill = useDetail<any>("purchase-bills", billId ?? undefined);
  const rows = (useWatch({ name: "lines" }) ?? []) as ReturnRow[];
  useEffect(() => {
    if (!billId) setValue("lines", []);
  }, [billId, setValue]);
  useEffect(() => {
    const b = bill.data;
    if (!b) return;
    setValue("warehouse", b.warehouse ?? null);
    setValue("lines", b.status !== "POSTED" ? [] : b.lines.map((l: any): ReturnRow => ({
      bill_line: l.id, sku: l.sku, product_name: l.product_name, unit: l.unit, billed: l.quantity, unit_price: l.unit_price, is_stock: l.is_stock,
      track_batches: !!l.track_batches, track_serials: !!l.track_serials, batch_number: l.batch_number ?? "", serials: "",
      returnable: toNumber(l.quantity) - toNumber(l.returned_quantity), quantity: "0",
    })));
  }, [bill.data, setValue]);
  const tracked = rows.some((r) => r.is_stock && (r.track_batches || r.track_serials));
  const columns: TableColumn<ReturnRow>[] = [
    col.custom("product_name", "Item", (r) => <><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}{!r.is_stock && " · service"}</div></>),
    col.custom("billed", "Billed", (r) => `${formatQty(r.billed)} ${r.unit}`, { align: "right" }),
    col.qty("returnable", "Returnable"),
    col.money("unit_price", "Rate"),
    col.custom("quantity", "Return qty", (r) => (
      <CellInput number name={`lines.${rows.indexOf(r)}.quantity`} label={`Return quantity for ${r.sku}`}
        invalid={toNumber(r.quantity) > r.returnable} disabled={r.returnable <= 0} />
    ), { width: 120 }),
    ...(tracked ? [col.custom<ReturnRow>("batch_number", "Batch / serials", (r) => {
      const i = rows.indexOf(r);
      return (
        <div className="space-y-1.5">
          {r.is_stock && r.track_batches && <CellInput name={`lines.${i}.batch_number`} label={`Batch for ${r.sku}`} placeholder="Batch number" />}
          {r.is_stock && r.track_serials && <CellInput name={`lines.${i}.serials`} label={`Serial numbers for ${r.sku}`} placeholder="Serial numbers, comma separated" />}
          {!(r.is_stock && (r.track_batches || r.track_serials)) && <span className="text-2xs text-slate-400">–</span>}
        </div>
      );
    }, { width: 230 })] : []),
  ];
  return (
    <>
      <FormSection title="Return">
        <FormField name="bill" label="Original bill" type="entity" resource="purchase-bills" params={{ status: "POSTED" }} required span={2}
          optionLabel={(b) => `${b.number} · ${b.supplier_name}`} optionSublabel={(b) => `Supplier inv. ${b.supplier_invoice_number} · Total ${formatAmount(b.grand_total)}`} />
        <FormField name="date" label="Return date" type="date" required min={bill.data?.bill_date} />
        <FormField name="warehouse" label="Return from warehouse" type="entity" resource="warehouses" required />
        <FormField name="reason" label="Reason" type="textarea" rows={2} required span={4} />
      </FormSection>
      <Panel title="Items returned">
        {!billId ? <p className="p-4 text-xs text-slate-500">Choose the bill first.</p> : bill.isLoading ? <LoadingBlock />
          : bill.error ? <ErrorState error={bill.error} onRetry={() => bill.refetch()} /> : bill.data && bill.data.status !== "POSTED" ? (
            <Alert tone="warning" className="m-4">Only posted bills can be returned against. {bill.data.number || `Draft bill #${bill.data.id}`} is {bill.data.status_label.toLowerCase()}.</Alert>
          ) : <BaseTable rows={rows} rowKey={(r) => r.bill_line} columns={columns} minWidth={720} />}
      </Panel>
    </>
  );
}

function ApplyDebitNoteDialog({ ret, onClose }: { ret: any; onClose: () => void }) {
  const open = useOpenBills(ret.supplier);
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const action = useDocumentAction<any>("purchase-returns", ret.id, ["purchase-bills", "suppliers"]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Apply debit note ${ret.number}`} size="xl" description={`Unapplied debit: ${formatAmount(ret.unapplied_credit)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={action.isPending} disabled={!allocationPayload(allocations).length}
        onClick={() => action.mutateAsync({ action: "apply", body: { allocations: allocationPayload(allocations) }, success: "Debit note applied" }).then(onClose, () => undefined)}>Apply</Button></>}>
      {open.isLoading ? <LoadingBlock /> : open.error ? <ErrorState error={open.error} onRetry={() => open.refetch()} />
        : <AllocationTable documents={toOpenBills(open.data)} allocations={allocations} onChange={setAllocations} available={toNumber(ret.unapplied_credit)} />}
    </Dialog>
  );
}

export function PurchaseReturnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("purchase-returns", id);
  const action = useDocumentAction<any>("purchase-returns", id, ["purchase-bills", "suppliers"]);
  const [dialog, setDialog] = useState<null | "post" | "delete" | "apply" | "refund">(null);
  const [deleting, setDeleting] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const r = query.data;
  const draft = r.status === "DRAFT";
  const unapplied = Number(r.unapplied_credit);
  const removeDraft = async () => {
    setDeleting(true);
    try { await api.delete(`/purchase-returns/${r.id}/`); toast.success("Draft deleted"); navigate("/purchases/returns"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDeleting(false); }
  };
  return (
    <>
      <PageHeader back={{ to: "/purchases/returns", label: "Purchase returns" }} title={r.number || `Draft return #${r.id}`}
        meta={<StatusBadge status={r.status} label={r.status_label} />}
        subtitle={<>{r.supplier_name} · <DateText value={r.date} bs={r.date_bs} /></>}
        actions={<>
          {draft && can("purchases.return") && <>
            <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDialog("delete")}>Delete</Button>
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setDialog("post")}>Post return</Button>
          </>}
          {r.status === "POSTED" && unapplied > 0 && can("purchases.payment") && <>
            <Button variant="primary" onClick={() => setDialog("apply")}>Apply to bills</Button>
            <Button icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setDialog("refund")}>Supplier refund</Button>
          </>}
          <PrintButton url={`/purchase-returns/${r.id}/pdf/`} filename={r.number || "debit-note"} label="Debit note" />
        </>} />
      {draft && <Alert tone="info" className="mb-4">Draft – stock and the supplier balance change when the return is posted.</Alert>}
      <div className="space-y-4">
        <Panel title="Return">
          <KeyValues items={[
            { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${r.supplier}`}>{r.supplier_name}</Link> },
            { label: "Original bill", value: <Link className="link" to={`/purchases/bills/${r.bill}`}>{r.bill_number}</Link> },
            { label: "Supplier invoice no.", value: r.supplier_invoice_number || "–" },
            { label: "Date", value: <DateText value={r.date} bs={r.date_bs} /> },
            { label: "Warehouse", value: r.warehouse_name },
            { label: "Posted by", value: r.posted_by_name ?? "–" },
            { label: "Debit applied", value: formatAmount(r.credit_applied) },
            { label: "Refunded", value: formatAmount(r.refunded_amount) },
            { label: "Journal", value: r.journal ? <Link className="link" to={`/finance/journals/${r.journal}`}>{r.journal_number ?? "View journal"}</Link> : "–" },
            { label: "Reason", value: <span className="whitespace-pre-line">{r.reason}</span>, wide: true },
          ]} />
        </Panel>
        <Panel title="Items">
          <DocumentLines lines={r.lines} extra={r.status === "POSTED" ? [col.custom("cost_amount", "Stock cost", (l: any) => (l.is_stock ? formatAmount(l.cost_amount) : "–"), { align: "right" })] : []} />
          <DocumentTotals doc={r}>
            {r.status === "POSTED" && <div className="mt-2 flex justify-between border-t border-line pt-2 font-medium"><span>Unapplied debit</span><span className="tabular-nums">{formatAmount(r.unapplied_credit)}</span></div>}
          </DocumentTotals>
        </Panel>
        <DocumentTimeline resource="purchase-returns" id={r.id} />
      </div>
      <ConfirmDialog open={dialog === "post"} onOpenChange={(o) => !o && setDialog(null)} title={`Post return against ${r.bill_number}`}
        description="Returned stock leaves the warehouse and a debit note is raised against the supplier, applied first to the original bill. Posted returns cannot be edited."
        confirmLabel="Post return" loading={action.isPending}
        onConfirm={() => action.mutateAsync({ action: "post", success: "Return posted and debit note raised" }).then(() => setDialog(null), () => undefined)} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} title="Delete draft return" tone="danger"
        description="The draft is removed. Nothing has been posted, so stock and balances do not change." confirmLabel="Delete draft" loading={deleting} onConfirm={removeDraft} />
      {dialog === "apply" && <ApplyDebitNoteDialog ret={r} onClose={() => setDialog(null)} />}
      {dialog === "refund" && <SupplierRefundDialog supplier={r.supplier} source={r.id} sourceField="debit_note" max={r.unapplied_credit} onClose={() => setDialog(null)} />}
    </>
  );
}
