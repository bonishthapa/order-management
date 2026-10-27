import { Plus, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useGet } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { AllocationTable, allocationPayload, type OpenDocument } from "@/components/document/AllocationTable";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { PaymentFields, useMethodRequiresReference } from "@/components/forms/PaymentFields";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput } from "@/components/ui/Input";
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
        columns={(ctx) => [
          col.doc("number", "Receipt", { sortable: true }),
          col.date("date", "Date", ctx, { sortable: true }),
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
  const [customer, setCustomer] = useState<number | null>(params.get("customer") ? Number(params.get("customer")) : null);
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<number | null>(null);
  const [account, setAccount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const open = useOpenInvoices(customer);
  const requiresRef = useMethodRequiresReference(method);
  const presetInvoice = params.get("invoice");
  useEffect(() => {
    const inv = presetInvoice && open.data?.results.find((i: any) => String(i.id) === presetInvoice);
    if (inv) { setAmount(inv.balance_due); setAllocations({ [inv.id]: inv.balance_due }); }
  }, [presetInvoice, open.data]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!customer) e.customer = "Choose the customer.";
    if (!(toNumber(amount) > 0)) e.amount = "Enter the amount received.";
    if (!method) e.method = "Choose a payment method.";
    if (!account) e.account = "Choose where the money was deposited.";
    if (requiresRef && !reference.trim()) e.reference = "This payment method needs a transaction reference.";
    const allocated = Object.values(allocations).reduce((s, v) => s + toNumber(v), 0);
    if (allocated - toNumber(amount) > 0.001) e.allocate = "Allocations exceed the amount received.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const { data } = await api.post("/sales-receipts/", {
        customer, date, amount, payment_method: method, deposit_account: account, reference, notes, allocate: allocationPayload(allocations),
      });
      ["sales-receipts", "sales-invoices", "customers", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      toast.success(`Receipt ${data.number} posted`);
      navigate(`/sales/receipts/${data.id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors({ ...fe, method: fe.payment_method, account: fe.deposit_account });
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Record customer receipt" back={{ to: "/sales/receipts", label: "Receipts" }}
        subtitle="Posting debits the cash/bank account and credits the customer's receivable." />
      <div className="space-y-4">
        <Panel title="Receipt">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Customer" required error={errors.customer} className="lg:col-span-2">
              <EntitySelect resource="customers" value={customer} onChange={(id) => { setCustomer(id); setAllocations({}); }} invalid={!!errors.customer} />
            </Field>
            <Field label="Date received" required error={errors.date}><DatePicker value={date} onChange={setDate} /></Field>
            <Field label="Amount" required error={errors.amount}><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amount} /></Field>
            <PaymentFields method={method} account={account} onMethod={setMethod} onAccount={setAccount} accountLabel="Deposited to" errors={errors} />
            <Field label="Transaction reference" required={requiresRef} error={errors.reference} hint="Cheque, transfer or wallet reference.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} invalid={!!errors.reference} />
            </Field>
            <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
        </Panel>
        <Panel title="Apply to invoices">
          {errors.allocate && <Alert tone="error" className="m-4">{errors.allocate}</Alert>}
          {!customer ? <p className="p-4 text-xs text-slate-500">Choose a customer to see open invoices.</p>
            : open.isLoading ? <LoadingBlock /> : (
              <AllocationTable documents={toOpenInvoices(open.data)} allocations={allocations} onChange={setAllocations} available={toNumber(amount)} />
            )}
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={submit}>Post receipt</Button>
        </div>
      </div>
    </>
  );
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
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [amount, setAmount] = useState(max);
  const [method, setMethod] = useState<number | null>(null);
  const [account, setAccount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Refund to customer" description={`Up to ${formatAmount(max)} can be refunded.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={async () => {
        setSaving(true);
        try {
          const { data } = await api.post("/customer-refunds/", { customer, [sourceField]: source, date, amount, payment_method: method, paid_from_account: account, reference });
          ["sales-receipts", "sales-returns", "customer-refunds", "customers"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          toast.success(`Refund ${data.number} posted`);
          onClose();
          navigate(`/sales/refunds/${data.id}`);
        } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
      }}>Post refund</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date" required><DatePicker value={date} onChange={setDate} /></Field>
        <Field label="Amount" required><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <PaymentFields method={method} account={account} onMethod={setMethod} onAccount={setAccount} accountLabel="Paid from" />
        <Field label="Reference" className="sm:col-span-2"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
    </Dialog>
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
          {!r.allocations.length ? <p className="p-4 text-xs text-slate-500">Not applied to any invoice.</p> : (
            <table className="w-full text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Invoice date</th><th className="px-4 py-2 text-right">Invoice total</th><th className="px-4 py-2 text-right">Applied</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody>{r.allocations.map((a: any) => (
                <tr key={a.id} className="border-b border-line">
                  <td className="px-4 py-2"><Link className="link" to={`/sales/invoices/${a.invoice}`}>{a.invoice_number}</Link></td>
                  <td className="px-4 py-2"><DateText value={a.invoice_date} /></td>
                  <td className="num px-4 py-2">{formatAmount(a.invoice_total)}</td>
                  <td className="num px-4 py-2">{formatAmount(a.amount)}</td>
                  <td className="px-4 py-2">{!a.is_active && <Badge>Reversed</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
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
        columns={(ctx) => [col.doc("number", "Refund"), col.date("date", "Date", ctx, { sortable: true }), col.text("customer_name", "Customer", { flex: 2 }),
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
