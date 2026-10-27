import { Plus, Wallet } from "lucide-react";
import { BaseTable, col, ResourceList } from "@/components/table";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useDetail, useDocumentAction, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { AllocationTable, allocationPayload, type OpenDocument } from "@/components/document/AllocationTable";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { BaseForm, FormDialog, FormField, FormGrid, FormSection, PaymentMethodFields, useFormContext, useWatch } from "@/components/form";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, toNumber } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useOpenInvoices(customer: number | null) {
  return useGet<any>(["sales-invoices", "open", customer], "/sales-invoices/", { customer: customer ?? "", open: "true", page_size: 200, ordering: "due_date" }, !!customer);
}
export const toOpenInvoices = (data: any): OpenDocument[] => (data?.results ?? []).map((i: any) => ({
  id: i.id, number: i.number, date: i.invoice_date, due_date: i.due_date, total: i.grand_total, balance_due: i.balance_due,
}));

export function ReceiptList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Customer receipts" subtitle="Money received. Receipts are posted when recorded; corrections are made by reversal."
        actions={<>
          <Button onClick={() => navigate("/sales/refunds")}>Refunds</Button>
          {can("sales.receipt") && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/sales/receipts/new")}>Record receipt</Button>}
        </>} />
      <ResourceList resource="sales-receipts" dated searchPlaceholder="Receipt no., customer, reference…" detailPath={(r) => `/sales/receipts/${r.id}`}
        exportUrl="/sales-receipts/export/"
        filters={[{ type: "select", name: "status", label: "Status", options: [{ value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }] },
          { type: "entity", name: "customer", label: "Customer", resource: "customers" }, { type: "boolean", name: "unapplied", label: "With unapplied amount" }]}
        columns={[
          col.doc("number", "Receipt", { sortable: true }),
          col.date("date", "Date", { sortable: true }),
          col.text("customer_name", "Customer", { flex: 2 }),
          col.text("payment_method_name", "Method"),
          col.text("reference", "Reference"),
          col.status("status"),
          col.money("amount", "Amount", { sortable: true }),
          col.money("unapplied_amount", "Unapplied"),
        ]} />
    </>
  );
}

export function ReceiptForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const submit = async (values: Record<string, any>) => {
    const allocated = Object.values(values.allocate as Record<number, string>).reduce((s, v) => s + toNumber(v), 0);
    if (allocated - toNumber(values.amount) > 0.001) throw new Error("Allocations exceed the amount received.");
    const { data } = await api.post("/sales-receipts/", { ...values, allocate: allocationPayload(values.allocate) });
    ["sales-receipts", "sales-invoices", "customers", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    toast.success(`Receipt ${data.number} posted`);
    navigate(`/sales/receipts/${data.id}`);
  };
  return (
    <>
      <PageHeader title="Record customer receipt" back={{ to: "/sales/receipts", label: "Receipts" }}
        subtitle="Posting debits the cash/bank account and credits the customer's receivable." />
      <BaseForm submitLabel="Post receipt" onCancel={() => navigate(-1)} onSubmit={submit}
        defaultValues={{
          customer: params.get("customer") ? Number(params.get("customer")) : null, date: todayIn(session?.organization?.timezone),
          amount: "", payment_method: null, deposit_account: null, reference: "", notes: "", allocate: {} as Record<number, string>,
        }}>
        <FormSection title="Receipt">
          <FormField name="customer" label="Customer" type="entity" resource="customers" required span={2} />
          <FormField name="date" label="Date received" type="date" required />
          <FormField name="amount" label="Amount" type="money" required />
          <PaymentMethodFields accountField="deposit_account" accountLabel="Deposited to" />
          <FormField name="notes" label="Notes" />
        </FormSection>
        <Panel title="Apply to invoices"><ReceiptAllocations presetInvoice={params.get("invoice")} /></Panel>
      </BaseForm>
    </>
  );
}

/** Allocation table bound to the form's "allocate" value for the chosen customer. */
function ReceiptAllocations({ presetInvoice }: { presetInvoice: string | null }) {
  const { setValue } = useFormContext();
  const customer = useWatch({ name: "customer" }) as number | null;
  const amount = useWatch({ name: "amount" }) as string;
  const allocations = (useWatch({ name: "allocate" }) ?? {}) as Record<number, string>;
  const open = useOpenInvoices(customer);
  useEffect(() => {
    const inv = presetInvoice && open.data?.results.find((i: any) => String(i.id) === presetInvoice);
    if (inv) {
      setValue("amount", inv.balance_due);
      setValue("allocate", { [inv.id]: inv.balance_due });
    }
  }, [presetInvoice, open.data, setValue]);
  useEffect(() => setValue("allocate", {}), [customer, setValue]);
  if (!customer) return <p className="p-4 text-xs text-slate-500">Choose a customer to see open invoices.</p>;
  if (open.isLoading) return <LoadingBlock />;
  return <AllocationTable documents={toOpenInvoices(open.data)} allocations={allocations} available={toNumber(amount)}
    onChange={(a) => setValue("allocate", a, { shouldDirty: true })} />;
}

function ApplyDialog({ receipt, onClose }: { receipt: any; onClose: () => void }) {
  const open = useOpenInvoices(receipt.customer);
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const action = useDocumentAction<any>("sales-receipts", receipt.id, ["sales-invoices"]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Apply ${receipt.number}`} size="xl"
      description={`Unapplied amount: ${formatAmount(receipt.unapplied_amount)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={action.isPending}
        onClick={() => action.mutateAsync({ action: "allocate", body: { allocations: allocationPayload(allocations) }, success: "Receipt applied" }).then(onClose)}>Apply</Button></>}>
      {open.isLoading ? <LoadingBlock /> : <AllocationTable documents={toOpenInvoices(open.data)} allocations={allocations} onChange={setAllocations}
        available={toNumber(receipt.unapplied_amount)} />}
    </Dialog>
  );
}

export function RefundDialog({ customer, source, sourceField, max, onClose }: {
  customer: number; source: number; sourceField: "receipt" | "credit_note"; max: string; onClose: () => void;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Refund to customer" description={`Up to ${formatAmount(max)} can be refunded.`}
      submitLabel="Post refund"
      defaultValues={{ date: todayIn(session?.organization?.timezone), amount: max, payment_method: null, paid_from_account: null, reference: "" }}
      onSubmit={async (values) => {
        const { data } = await api.post("/customer-refunds/", { customer, [sourceField]: source, ...values });
        ["sales-receipts", "sales-returns", "customer-refunds", "customers"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(`Refund ${data.number} posted`);
        navigate(`/sales/refunds/${data.id}`);
      }}>
      <FormGrid>
        <FormField name="date" label="Date" type="date" required />
        <FormField name="amount" label="Amount" type="money" required />
        <PaymentMethodFields accountField="paid_from_account" accountLabel="Paid from" />
      </FormGrid>
    </FormDialog>
  );
}

export function ReceiptDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const query = useDetail<any>("sales-receipts", id);
  const action = useDocumentAction<any>("sales-receipts", id, ["sales-invoices", "customers"]);
  const [dialog, setDialog] = useState<null | "apply" | "refund">(null);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  const r = query.data;
  const posted = r.status === "POSTED";
  const unapplied = Number(r.unapplied_amount);
  return (
    <>
      <PageHeader back={{ to: "/sales/receipts", label: "Receipts" }} title={r.number} meta={<StatusBadge status={r.status} />}
        subtitle={<>{r.customer_name} · <DateText value={r.date} bs={r.date_bs} /></>}
        actions={<>
          {posted && unapplied > 0 && can("sales.receipt") && <Button variant="primary" onClick={() => setDialog("apply")}>Apply to invoices</Button>}
          {posted && unapplied > 0 && can("sales.receipt") && <Button icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setDialog("refund")}>Refund</Button>}
          {posted && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${r.number}`} loading={action.isPending}
              description="Use this for a bounced cheque or a receipt recorded in error. Invoice allocations are released and the customer's balance restored."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Receipt reversed" })} />
          )}
          <PrintButton url={`/sales-receipts/${r.id}/pdf/`} filename={r.number} label="Print receipt" compact />
        </>} />
      {r.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">{r.reversal_reason}</Alert>}
      <div className="space-y-4">
        <Panel title="Receipt">
          <KeyValues items={[
            { label: "Customer", value: <Link className="link" to={`/contacts/customers/${r.customer}`}>{r.customer_name}</Link> },
            { label: "Date", value: <DateText value={r.date} bs={r.date_bs} /> },
            { label: "Amount", value: <strong>{formatAmount(r.amount)}</strong> },
            { label: "Fiscal year", value: r.fiscal_year_name ?? "–" },
            { label: "Method", value: r.payment_method_name },
            { label: "Deposited to", value: r.deposit_account_name },
            { label: "Reference", value: r.reference || "–" },
            { label: "Received by", value: r.received_by_name ?? "–" },
            { label: "Applied", value: formatAmount(r.allocated_amount) },
            { label: "Refunded", value: formatAmount(r.refunded_amount) },
            { label: "Unapplied (advance)", value: formatAmount(r.unapplied_amount) },
            { label: "Journal", value: r.journal ? <Link className="link" to={`/finance/journals/${r.journal}`}>{r.journal_number}</Link> : "–" },
          ]} />
        </Panel>
        <Panel title="Applied to">
          <BaseTable rows={r.allocations} empty={<p className="p-4 text-xs text-slate-500">Not applied to any invoice.</p>} columns={[
            col.custom("invoice_number", "Invoice", (a: any) => <Link className="link" to={`/sales/invoices/${a.invoice}`}>{a.invoice_number}</Link>),
            col.date("invoice_date", "Invoice date"),
            col.money("invoice_total", "Invoice total"),
            col.money("amount", "Applied"),
            col.custom("state", "", (a: any) => (!a.is_active ? <Badge>Reversed</Badge> : null)),
          ]} />
        </Panel>
        {r.notes && <Panel title="Notes"><p className="p-4 text-[13px]">{r.notes}</p></Panel>}
        <DocumentTimeline resource="sales-receipts" id={r.id} />
      </div>
      {dialog === "apply" && <ApplyDialog receipt={r} onClose={() => setDialog(null)} />}
      {dialog === "refund" && <RefundDialog customer={r.customer} source={r.id} sourceField="receipt" max={r.unapplied_amount} onClose={() => setDialog(null)} />}
    </>
  );
}

export function RefundList() {
  return (
    <>
      <PageHeader title="Customer refunds" back={{ to: "/sales/receipts", label: "Receipts" }}
        subtitle="Money paid back from unapplied receipts or credit notes. Start a refund from the receipt or credit note." />
      <ResourceList resource="customer-refunds" dated detailPath={(r) => `/sales/refunds/${r.id}`} searchPlaceholder="Refund no., customer…"
        filters={[{ type: "entity", name: "customer", label: "Customer", resource: "customers" }]}
        columns={[col.doc("number", "Refund"), col.date("date", "Date", { sortable: true }), col.text("customer_name", "Customer", { flex: 2 }),
          col.text("source_number", "Against"), col.text("reference", "Reference"), col.status("status"), col.money("amount", "Amount")]} />
    </>
  );
}

export function RefundDetail() {
  const { id } = useParams();
  const query = useDetail<any>("customer-refunds", id);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} />;
  const r = query.data;
  return (
    <>
      <PageHeader back={{ to: "/sales/refunds", label: "Refunds" }} title={r.number} meta={<StatusBadge status={r.status} />}
        actions={<PrintButton url={`/customer-refunds/${r.id}/pdf/`} filename={r.number} />} />
      <Panel title="Refund">
        <KeyValues items={[
          { label: "Customer", value: <Link className="link" to={`/contacts/customers/${r.customer}`}>{r.customer_name}</Link> },
          { label: "Date", value: <DateText value={r.date} bs={r.date_bs} /> },
          { label: "Amount", value: formatAmount(r.amount) },
          { label: "Against", value: r.receipt ? <Link className="link" to={`/sales/receipts/${r.receipt}`}>{r.source_number}</Link>
            : <Link className="link" to={`/sales/returns/${r.credit_note}`}>{r.source_number}</Link> },
          { label: "Reference", value: r.reference || "–" },
          { label: "Journal", value: r.journal ? <Link className="link" to={`/finance/journals/${r.journal}`}>View journal</Link> : "–" },
        ]} />
      </Panel>
    </>
  );
}
