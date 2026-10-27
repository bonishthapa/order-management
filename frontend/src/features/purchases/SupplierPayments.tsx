import { CheckCircle2, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { AllocationTable, allocationPayload, type OpenDocument } from "@/components/document/AllocationTable";
import { Attachments } from "@/components/document/Attachments";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { AllocationField, BaseForm, FormDialog, FormField, FormGrid, FormSection, PaymentMethodFields, useFormContext, useWatch } from "@/components/form";
import { BaseTable, ResourceList, col, type TableColumn } from "@/components/table";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, toNumber } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useOpenBills(supplier: number | null) {
  return useGet<any>(["purchase-bills", "open", supplier], "/purchase-bills/", { supplier: supplier ?? "", open: "true", page_size: 200, ordering: "due_date" }, !!supplier);
}
export const toOpenBills = (data: any): OpenDocument[] => (data?.results ?? []).map((b: any) => ({
  id: b.id, number: b.number, date: b.bill_date, due_date: b.due_date, total: b.grand_total, balance_due: b.balance_due,
  reference: b.supplier_invoice_number ? `Inv. ${b.supplier_invoice_number}` : undefined,
}));

const VOUCHER_STATUSES = [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }];

export function PaymentVoucherList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Supplier payments" subtitle="Payment vouchers are prepared as drafts and take effect when approved and posted."
        actions={<>
          <Button onClick={() => navigate("/purchases/refunds")}>Refunds</Button>
          {can("purchases.payment") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/purchases/payments/new")}>New payment</Button>}
        </>} />
      <ResourceList resource="payment-vouchers" dated searchPlaceholder="Voucher no., supplier, reference…" detailPath={(r) => `/purchases/payments/${r.id}`}
        exportUrl="/payment-vouchers/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: VOUCHER_STATUSES },
          { type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" }]}
        columns={[
          col.doc("number", "Voucher", { sortable: true }),
          col.date("date", "Date", { sortable: true }),
          col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("payment_method_name", "Method"),
          col.text("reference", "Reference"),
          col.text("prepared_by_name", "Prepared by"),
          col.status("status"),
          col.money("amount", "Amount", { sortable: true }),
          col.money("unapplied_amount", "Unapplied"),
        ]}
        empty={{ title: "No supplier payments", description: "Prepare a payment voucher to pay a supplier's bills." }} />
    </>
  );
}

export function PaymentVoucherForm() {
  const { id } = useParams();
  const query = useDetail<any>("payment-vouchers", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const voucher = query.data;
  if (voucher && voucher.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={`Edit ${voucher.number}`} back={{ to: `/purchases/payments/${voucher.id}`, label: voucher.number }} />
        <Alert tone="warning" title="This voucher can no longer be edited">Posted vouchers are never edited; reverse the voucher instead.</Alert>
      </>
    );
  }
  return <VoucherEditor voucher={voucher} />;
}

interface VoucherValues {
  supplier: number | null; date: string; amount: string; payment_method: number | null; paid_from_account: number | null;
  reference: string; notes: string; allocations: Record<number, string>;
}

function VoucherEditor({ voucher }: { voucher?: any }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const defaultValues: VoucherValues = {
    supplier: voucher?.supplier ?? (params.get("supplier") ? Number(params.get("supplier")) : null),
    date: voucher?.date ?? todayIn(session?.organization?.timezone),
    amount: voucher?.amount ?? "",
    payment_method: voucher?.payment_method ?? null,
    paid_from_account: voucher?.paid_from_account ?? null,
    reference: voucher?.reference ?? "",
    notes: voucher?.notes ?? "",
    allocations: Object.fromEntries((voucher?.requested_allocations ?? []).map((a: any) => [a.bill, String(a.amount)])),
  };

  const submit = async ({ allocations, ...values }: VoucherValues) => {
    const allocated = Object.values(allocations ?? {}).reduce((s, v) => s + toNumber(v), 0);
    if (allocated - toNumber(values.amount) > 0.001) throw new Error("Allocations exceed the amount paid.");
    const body = { ...values, reference: values.reference.trim(), allocate: allocationPayload(allocations ?? {}) };
    const { data } = voucher ? await api.patch(`/payment-vouchers/${voucher.id}/`, body) : await api.post("/payment-vouchers/", body);
    queryClient.invalidateQueries({ queryKey: ["payment-vouchers"] });
    toast.success(voucher ? "Draft voucher saved" : "Draft voucher prepared; it takes effect when approved and posted");
    navigate(`/purchases/payments/${data.id}`);
  };

  return (
    <>
      <PageHeader title={voucher ? "Edit draft payment voucher" : "New supplier payment"}
        back={voucher ? { to: `/purchases/payments/${voucher.id}`, label: `Draft voucher #${voucher.id}` } : { to: "/purchases/payments", label: "Supplier payments" }}
        subtitle="The voucher is saved as a draft. Posting it credits the cash/bank account and reduces the supplier's payable." />
      <BaseForm<VoucherValues> defaultValues={defaultValues} onSubmit={submit} onCancel={() => navigate(-1)} submitLabel="Save draft voucher"
        errorFieldMap={{ allocate: "allocations" }}>
        <VoucherFields presetBill={voucher ? null : params.get("bill")} />
      </BaseForm>
    </>
  );
}

function VoucherFields({ presetBill }: { presetBill: string | null }) {
  const { setValue } = useFormContext();
  const supplier = useWatch({ name: "supplier" }) as number | null;
  const amount = useWatch({ name: "amount" }) as string;
  const open = useOpenBills(supplier);
  useEffect(() => {
    const bill = presetBill && open.data?.results.find((b: any) => String(b.id) === presetBill);
    if (bill) { setValue("amount", bill.balance_due); setValue("allocations", { [bill.id]: bill.balance_due }); }
  }, [presetBill, open.data, setValue]);
  return (
    <>
      <FormSection title="Payment">
        <FormField name="supplier" label="Supplier" type="entity" resource="suppliers" required span={2}
          onValueChange={() => setValue("allocations", {})} />
        <FormField name="date" label="Payment date" type="date" required />
        <FormField name="amount" label="Amount" type="money" required
          rules={{ validate: (v: any) => (toNumber(v) > 0) || "Enter the amount paid." }} />
        <PaymentMethodFields accountField="paid_from_account" accountLabel="Paid from" />
        <FormField name="notes" label="Notes" />
      </FormSection>
      <Panel title="Apply to bills">
        {!supplier ? <p className="p-4 text-xs text-slate-500">Choose a supplier to see open bills.</p>
          : open.isLoading ? <LoadingBlock /> : open.error ? <ErrorState error={open.error} onRetry={() => open.refetch()} /> : (
            <AllocationField name="allocations" documents={toOpenBills(open.data)} available={toNumber(amount)} />
          )}
        {supplier && <p className="border-t border-line px-4 py-2 text-xs text-slate-500">Allocations are applied to the bills when the voucher is posted.</p>}
      </Panel>
    </>
  );
}

function ApplyVoucherDialog({ voucher, onClose }: { voucher: any; onClose: () => void }) {
  const open = useOpenBills(voucher.supplier);
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const action = useDocumentAction<any>("payment-vouchers", voucher.id, ["purchase-bills", "suppliers"]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Apply ${voucher.number}`} size="xl"
      description={`Unapplied amount: ${formatAmount(voucher.unapplied_amount)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={action.isPending}
        disabled={!allocationPayload(allocations).length}
        onClick={() => action.mutateAsync({ action: "allocate", body: { allocations: allocationPayload(allocations) }, success: "Payment applied" }).then(onClose, () => undefined)}>Apply</Button></>}>
      {open.isLoading ? <LoadingBlock /> : open.error ? <ErrorState error={open.error} onRetry={() => open.refetch()} />
        : <AllocationTable documents={toOpenBills(open.data)} allocations={allocations} onChange={setAllocations} available={toNumber(voucher.unapplied_amount)} />}
    </Dialog>
  );
}

/** Records money the supplier pays back from an unapplied payment or an unapplied debit note. */
export function SupplierRefundDialog({ supplier, source, sourceField, max, onClose }: {
  supplier: number; source: number; sourceField: "voucher" | "debit_note"; max: string; onClose: () => void;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  type Values = { date: string; amount: string; payment_method: number | null; deposit_account: number | null; reference: string; notes: string };
  return (
    <FormDialog<Values> open onOpenChange={(o) => !o && onClose()} title="Refund from supplier"
      description={`Up to ${formatAmount(max)} can be refunded. The refund is posted immediately.`} submitLabel="Post refund"
      defaultValues={{ date: todayIn(session?.organization?.timezone), amount: max, payment_method: null, deposit_account: null, reference: "", notes: "" }}
      onSubmit={async (values) => {
        const { data } = await api.post("/supplier-refunds/", { ...values, supplier, [sourceField]: source, reference: values.reference.trim() });
        ["payment-vouchers", "purchase-returns", "supplier-refunds", "suppliers"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(`Refund ${data.number} posted`);
        navigate(`/purchases/refunds/${data.id}`);
      }}>
      <FormGrid columns={2}>
        <FormField name="date" label="Date received" type="date" required />
        <FormField name="amount" label="Amount" type="money" required rules={{
          validate: (v: any) => (toNumber(v) <= 0 ? "Enter the amount refunded."
            : toNumber(v) - toNumber(max) > 0.001 ? `At most ${formatAmount(max)} can be refunded.` : true),
        }} />
        <PaymentMethodFields accountField="deposit_account" accountLabel="Deposited to" />
        <FormField name="notes" label="Notes" />
      </FormGrid>
    </FormDialog>
  );
}

function RequestedAllocations({ voucher }: { voucher: any }) {
  const open = useOpenBills(voucher.supplier);
  const requested: any[] = voucher.requested_allocations ?? [];
  if (!requested.length) return <p className="p-4 text-xs text-slate-500">No bills selected. The full amount will be recorded as an advance.</p>;
  if (open.isLoading) return <LoadingBlock />;
  const bills: Record<number, any> = Object.fromEntries((open.data?.results ?? []).map((b: any) => [b.id, b]));
  const rows = requested.map((a) => ({ ...a, open: bills[a.bill] as any }));
  return (
    <BaseTable rows={rows} rowKey={(r) => r.bill} columns={[
      col.custom("bill", "Bill", (r) => <Link className="link" to={`/purchases/bills/${r.bill}`}>{r.open?.number ?? `Bill #${r.bill}`}</Link>),
      col.custom("supplier_invoice_number", "Supplier invoice", (r) => r.open?.supplier_invoice_number ?? "–"),
      col.custom("due_date", "Due", (r) => (r.open ? <DateText value={r.open.due_date} /> : "–")),
      col.custom("balance_due", "Outstanding now", (r) => (r.open ? formatAmount(r.open.balance_due) : "–"), { align: "right" }),
      col.money("amount", "To apply"),
      col.custom("state", "", (r) => (!r.open ? <Badge tone="amber">No longer open</Badge>
        : toNumber(r.amount) > toNumber(r.open.balance_due) ? <Badge tone="amber">Exceeds balance</Badge> : null)),
    ]} />
  );
}

const appliedColumns: TableColumn<any>[] = [
  col.custom("bill_number", "Bill", (a) => <Link className="link" to={`/purchases/bills/${a.bill}`}>{a.bill_number}</Link>),
  col.custom("supplier_invoice_number", "Supplier invoice", (a) => a.supplier_invoice_number || "–"),
  col.date("bill_date", "Bill date"),
  col.money("bill_total", "Bill total"),
  col.money("amount", "Applied"),
  col.custom("is_active", "", (a) => (!a.is_active ? <Badge>Reversed</Badge> : null)),
];

export function PaymentVoucherDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const query = useDetail<any>("payment-vouchers", id);
  const action = useDocumentAction<any>("payment-vouchers", id, ["purchase-bills", "suppliers"]);
  const [dialog, setDialog] = useState<null | "post" | "delete" | "apply" | "refund">(null);
  const [deleting, setDeleting] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const v = query.data;
  const draft = v.status === "DRAFT";
  const posted = v.status === "POSTED";
  const unapplied = Number(v.unapplied_amount);
  const canPost = can("purchases.payment") || can("accounting.post");
  const timeZone = session?.organization?.timezone;
  const removeDraft = async () => {
    setDeleting(true);
    try { await api.delete(`/payment-vouchers/${v.id}/`); toast.success("Draft deleted"); navigate("/purchases/payments"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDeleting(false); }
  };
  return (
    <>
      <PageHeader back={{ to: "/purchases/payments", label: "Supplier payments" }} title={v.number || `Draft voucher #${v.id}`} meta={<StatusBadge status={v.status} />}
        subtitle={<>{v.supplier_name} · <DateText value={v.date} bs={v.date_bs} /></>}
        actions={<>
          {draft && can("purchases.payment") && <>
            <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDialog("delete")}>Delete</Button>
            <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/purchases/payments/${v.id}/edit`)}>Edit</Button>
          </>}
          {draft && canPost && (
            <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog("post")}>Approve and post</Button>
          )}
          {posted && unapplied > 0 && can("purchases.payment") && <>
            <Button variant="primary" onClick={() => setDialog("apply")}>Apply to bills</Button>
            <Button icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setDialog("refund")}>Supplier refund</Button>
          </>}
          {posted && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${v.number}`} loading={action.isPending}
              description="Use this for a stopped cheque or a payment recorded in error. Bill allocations are released and the supplier's payable restored. Refunds against this voucher must be removed first."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Payment voucher reversed" })} />
          )}
          <PrintButton url={`/payment-vouchers/${v.id}/pdf/`} filename={v.number || "payment-voucher"} label="Print voucher" />
        </>} />
      {draft && <Alert tone="info" className="mb-4">Draft – awaiting approval. No money has been recorded as paid; the voucher number is assigned when it is posted.</Alert>}
      {v.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">{v.reversal_reason}</Alert>}
      <div className="space-y-4">
        <Panel title="Payment voucher">
          <KeyValues items={[
            { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${v.supplier}`}>{v.supplier_name}</Link> },
            { label: "Date", value: <DateText value={v.date} bs={v.date_bs} /> },
            { label: "Amount", value: <strong>{formatAmount(v.amount)}</strong> },
            { label: "Fiscal year", value: v.fiscal_year_name ?? "Assigned on posting" },
            { label: "Method", value: v.payment_method_name },
            { label: "Paid from", value: v.paid_from_account_name },
            { label: "Reference", value: v.reference || "–" },
            { label: "Journal", value: v.journal ? <Link className="link" to={`/finance/journals/${v.journal}`}>{v.journal_number}</Link> : "–" },
            { label: "Prepared by", value: v.prepared_by_name ?? "–" },
            { label: "Approved by", value: v.approved_by_name ? <>{v.approved_by_name}<span className="block text-2xs text-slate-500">{formatDateTime(v.approved_at, timeZone)}</span></> : "–" },
            ...(posted || v.status === "REVERSED" ? [
              { label: "Applied", value: formatAmount(v.allocated_amount) },
              { label: "Refunded", value: formatAmount(v.refunded_amount) },
              { label: "Unapplied (advance)", value: formatAmount(v.unapplied_amount) },
            ] : []),
          ]} />
        </Panel>
        {draft ? (
          <Panel title="Bills to pay on posting"><RequestedAllocations voucher={v} /></Panel>
        ) : (
          <Panel title="Applied to">
            <BaseTable columns={appliedColumns} rows={v.allocations} empty={<p className="p-4 text-xs text-slate-500">Not applied to any bill.</p>} />
          </Panel>
        )}
        {v.notes && <Panel title="Notes"><p className="whitespace-pre-line p-4 text-[13px]">{v.notes}</p></Panel>}
        <Attachments entityType="paymentvoucher" entityId={v.id} canUpload={can("purchases.payment")} canDelete={draft} />
        <DocumentTimeline resource="payment-vouchers" id={v.id} />
      </div>
      <ConfirmDialog open={dialog === "post"} onOpenChange={(o) => !o && setDialog(null)} title={`Approve and post payment of ${formatAmount(v.amount)}`}
        description={<>The payment to {v.supplier_name} is posted from {v.paid_from_account_name} and applied to the selected bills. Posted vouchers can only be corrected by reversal.</>}
        confirmLabel="Approve and post" loading={action.isPending}
        onConfirm={() => action.mutateAsync({ action: "post", success: "Payment voucher posted" }).then(() => setDialog(null), () => undefined)} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} title="Delete draft voucher" tone="danger"
        description="The draft is removed. Nothing has been posted, so no balances change." confirmLabel="Delete draft" loading={deleting} onConfirm={removeDraft} />
      {dialog === "apply" && <ApplyVoucherDialog voucher={v} onClose={() => setDialog(null)} />}
      {dialog === "refund" && <SupplierRefundDialog supplier={v.supplier} source={v.id} sourceField="voucher" max={v.unapplied_amount} onClose={() => setDialog(null)} />}
    </>
  );
}

export function SupplierRefundList() {
  return (
    <>
      <PageHeader title="Supplier refunds" back={{ to: "/purchases/payments", label: "Supplier payments" }}
        subtitle="Money received back from suppliers against unapplied payments or debit notes. Start a refund from the voucher or debit note." />
      <ResourceList resource="supplier-refunds" dated detailPath={(r) => `/purchases/refunds/${r.id}`} searchPlaceholder="Refund no., supplier, reference…"
        filters={[{ type: "entity", name: "supplier", label: "Supplier", resource: "suppliers" }]}
        columns={[col.doc("number", "Refund"), col.date("date", "Date"), col.text("supplier_name", "Supplier", { flex: 2 }),
          col.text("source_number", "Against"), col.text("payment_method_name", "Method"), col.text("reference", "Reference"), col.status("status"),
          col.money("amount", "Amount")]}
        empty={{ title: "No supplier refunds", description: "Refunds are recorded from a payment voucher or debit note with an unapplied amount." }} />
    </>
  );
}

export function SupplierRefundDetail() {
  const { id } = useParams();
  const query = useDetail<any>("supplier-refunds", id);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const r = query.data;
  return (
    <>
      <PageHeader back={{ to: "/purchases/refunds", label: "Supplier refunds" }} title={r.number} meta={<StatusBadge status={r.status} />}
        subtitle={<>{r.supplier_name} · <DateText value={r.date} bs={r.date_bs} /></>}
        actions={<PrintButton url={`/supplier-refunds/${r.id}/pdf/`} filename={r.number} />} />
      <div className="space-y-4">
        <Panel title="Refund">
          <KeyValues items={[
            { label: "Supplier", value: <Link className="link" to={`/contacts/suppliers/${r.supplier}`}>{r.supplier_name}</Link> },
            { label: "Date", value: <DateText value={r.date} bs={r.date_bs} /> },
            { label: "Amount", value: <strong>{formatAmount(r.amount)}</strong> },
            { label: "Against", value: r.voucher ? <Link className="link" to={`/purchases/payments/${r.voucher}`}>{r.source_number}</Link>
              : r.debit_note ? <Link className="link" to={`/purchases/returns/${r.debit_note}`}>{r.source_number}</Link> : "–" },
            { label: "Method", value: r.payment_method_name },
            { label: "Deposited to", value: r.deposit_account_name },
            { label: "Reference", value: r.reference || "–" },
            { label: "Journal", value: r.journal ? <Link className="link" to={`/finance/journals/${r.journal}`}>{r.journal_number ?? "View journal"}</Link> : "–" },
            ...(r.notes ? [{ label: "Notes", value: <span className="whitespace-pre-line">{r.notes}</span>, wide: true }] : []),
          ]} />
        </Panel>
        <DocumentTimeline resource="supplier-refunds" id={r.id} />
      </div>
    </>
  );
}
