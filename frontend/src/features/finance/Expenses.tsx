import { CheckCircle2, Pencil, Plus, Send, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useOptions } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { Attachments } from "@/components/document/Attachments";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { PaymentFields, useMethodRequiresReference } from "@/components/forms/PaymentFields";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, formatPercent, toNumber } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "/finance/expenses";

export const EXPENSE_STATUSES = [
  { value: "DRAFT", label: "Draft" }, { value: "SUBMITTED", label: "Awaiting approval" }, { value: "POSTED", label: "Approved and posted" },
  { value: "REJECTED", label: "Rejected" }, { value: "REVERSED", label: "Reversed" },
];

interface ExpenseCategory { id: number; name: string; account: number; account_name: string; is_active: boolean }
interface TaxRate { id: number; name: string; rate: string; is_default: boolean; is_active: boolean }

export function ExpenseList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const categories = useOptions<ExpenseCategory>("expense-categories");
  return (
    <>
      <PageHeader title="Expenses" subtitle="Expenses are posted to the ledger when approved; posted expenses are corrected by reversal."
        actions={can("expenses.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/new`)}>New expense</Button>
        )} />
      <ResourceList resource="expenses" dated searchPlaceholder="Number, payee, description, reference…" detailPath={(r) => `${BASE}/${r.id}`}
        exportUrl="/expenses/export/"
        filters={[
          { type: "select", name: "status", label: "Status", options: EXPENSE_STATUSES },
          { type: "select", name: "category", label: "Category", options: (categories.data ?? []).map((c) => ({ value: String(c.id), label: c.name })) },
        ]}
        columns={(ctx) => [
          col.doc("number", "Expense", { sortable: true }),
          col.date("date", "Date", ctx, { sortable: true }),
          col.text("category_name", "Category"),
          col.text("payee", "Payee", { flex: 2 }),
          col.text("paid_from_account_name", "Paid from", { flex: 2 }),
          col.text("reference", "Reference"),
          col.status("status", "Status", "status_label"),
          col.money("total", "Total", { sortable: true }),
        ]}
        empty={{ title: "No expenses", description: "Record office, travel, utility and other operating expenses here." }} />
    </>
  );
}

export function ExpenseForm() {
  const { id } = useParams();
  const query = useDetail<any>("expenses", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const doc = query.data;
  if (doc && !["DRAFT", "REJECTED"].includes(doc.status)) {
    return (
      <>
        <PageHeader title={`Edit ${doc.number || `draft #${doc.id}`}`} back={{ to: `${BASE}/${doc.id}`, label: doc.number || "Expense" }} />
        <Alert tone="warning" title="This expense can no longer be edited">Only draft or rejected expenses can be changed. Reverse a posted expense instead.</Alert>
      </>
    );
  }
  return <ExpenseFormBody key={id ?? "new"} initial={doc} />;
}

function ExpenseFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const categories = useOptions<ExpenseCategory>("expense-categories");
  const taxes = useOptions<TaxRate>("tax-rates");
  const [category, setCategory] = useState<number | null>(initial?.category ?? null);
  const [date, setDate] = useState<string>(initial?.date ?? todayIn(session?.organization?.timezone));
  const [payee, setPayee] = useState<string>(initial?.payee ?? "");
  const [supplier, setSupplier] = useState<number | null>(initial?.supplier ?? null);
  const [amount, setAmount] = useState<string>(initial?.amount ?? "");
  const [taxRate, setTaxRate] = useState<number | null>(initial?.tax_rate ?? null);
  const [method, setMethod] = useState<number | null>(initial?.payment_method ?? null);
  const [account, setAccount] = useState<number | null>(initial?.paid_from_account ?? null);
  const [reference, setReference] = useState<string>(initial?.reference ?? "");
  const [description, setDescription] = useState<string>(initial?.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<null | "save" | "submit">(null);
  const requiresRef = useMethodRequiresReference(method);
  const activeTaxes = (taxes.data ?? []).filter((t) => t.is_active || t.id === taxRate);
  const activeCategories = (categories.data ?? []).filter((c) => c.is_active || c.id === category);
  const selectedCategory = categories.data?.find((c) => c.id === category);

  const save = async (then: "save" | "submit") => {
    const e: Record<string, string> = {};
    if (!category) e.category = "Choose a category.";
    if (!date) e.date = "Enter the expense date.";
    if (!payee.trim()) e.payee = "Enter who was paid.";
    if (!(toNumber(amount) > 0)) e.amount = "Enter an amount greater than zero.";
    if (!method) e.method = "Choose a payment method.";
    if (!account) e.account = "Choose the cash or bank account the money was paid from.";
    if (requiresRef && !reference.trim()) e.reference = "This payment method needs a transaction reference.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(then);
    const body = { category, date, payee: payee.trim(), supplier, amount, tax_rate: taxRate, payment_method: method, paid_from_account: account,
      reference, description };
    try {
      let { data } = initial ? await api.patch(`/expenses/${initial.id}/`, body) : await api.post("/expenses/", body);
      if (then === "submit") data = (await api.post(`/expenses/${data.id}/submit/`)).data;
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      toast.success(then === "submit" ? "Expense submitted for approval" : `Expense saved · total ${formatAmount(data.total)}`);
      navigate(`${BASE}/${data.id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors({ ...fe, method: fe.payment_method, account: fe.paid_from_account });
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <PageHeader title={initial ? `Edit expense ${initial.number || `draft #${initial.id}`}` : "New expense"}
        back={{ to: initial ? `${BASE}/${initial.id}` : BASE, label: initial ? initial.number || "Expense" : "Expenses" }}
        subtitle="Approval posts the expense: debit the category's expense account (and input VAT), credit the cash/bank account." />
      {initial?.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{initial.rejection_reason} Saving returns the expense to draft.</Alert>}
      <div className="space-y-4">
        <Panel title="Expense">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Category" required error={errors.category} hint={selectedCategory ? `Posts to ${selectedCategory.account_name}` : undefined}>
              <Select value={category ?? ""} onChange={(e) => setCategory(e.target.value ? Number(e.target.value) : null)} invalid={!!errors.category}>
                <option value="">Choose…</option>
                {activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Date" required error={errors.date}><DatePicker value={date} onChange={setDate} invalid={!!errors.date} /></Field>
            <Field label="Payee" required error={errors.payee} className="lg:col-span-2">
              <Input value={payee} onChange={(e) => setPayee(e.target.value)} invalid={!!errors.payee} />
            </Field>
            <Field label="Supplier (optional)" error={errors.supplier} className="lg:col-span-2" hint="Link the expense to a supplier for reporting. It does not create a payable.">
              <EntitySelect resource="suppliers" params={{ is_active: "true" }} value={supplier} initialLabel={initial?.supplier_name}
                onChange={(sid, item) => { setSupplier(sid); if (item && !payee.trim()) setPayee(item.name); }} placeholder="No supplier" />
            </Field>
            <Field label="Amount before tax" required error={errors.amount}>
              <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amount} />
            </Field>
            <Field label="Tax" error={errors.tax_rate}>
              <Select value={taxRate ?? ""} onChange={(e) => setTaxRate(e.target.value ? Number(e.target.value) : null)}>
                <option value="">No tax</option>
                {activeTaxes.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatPercent(t.rate)})</option>)}
              </Select>
            </Field>
          </div>
        </Panel>
        <Panel title="Payment">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <PaymentFields method={method} account={account} onMethod={setMethod} onAccount={setAccount} accountLabel="Paid from" errors={errors} />
            <Field label="Reference" required={requiresRef} error={errors.reference} hint="Bill, cheque or transfer reference.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} invalid={!!errors.reference} />
            </Field>
            <Field label="Description" error={errors.description} className="sm:col-span-2 lg:col-span-4">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </Panel>
        {initial && (
          <Panel title="Saved totals">
            <KeyValues columns={3} items={[
              { label: "Amount", value: formatAmount(initial.amount) },
              { label: `Tax (${formatPercent(initial.tax_percent)})`, value: formatAmount(initial.tax_amount) },
              { label: "Total", value: <strong>{formatAmount(initial.total)}</strong> },
            ]} />
            <p className="px-4 pb-3 text-xs text-slate-500">Tax and total are recalculated by the server when you save.</p>
          </Panel>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button loading={saving === "save"} disabled={!!saving} onClick={() => save("save")}>Save draft</Button>
          <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={saving === "submit"} disabled={!!saving}
            onClick={() => save("submit")}>Save and submit</Button>
        </div>
      </div>
    </>
  );
}

export function ExpenseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const query = useDetail<any>("expenses", id);
  const action = useDocumentAction<any>("expenses", id, ["journals", "accounts"]);
  const [dialog, setDialog] = useState<null | "approve" | "reject" | "delete">(null);
  const [deleting, setDeleting] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const x = query.data;
  const editable = ["DRAFT", "REJECTED"].includes(x.status);
  const title = x.number || `Draft expense #${x.id}`;

  const remove = async () => {
    setDeleting(true);
    try {
      await api.delete(`/expenses/${x.id}/`);
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      toast.success("Draft expense deleted");
      navigate(BASE);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader back={{ to: BASE, label: "Expenses" }} title={title} meta={<StatusBadge status={x.status} label={x.status_label} />}
        subtitle={<>{x.payee} · {x.category_name} · <DateText value={x.date} bs={x.date_bs} /></>}
        actions={<>
          {editable && can("expenses.manage") && <>
            {x.status === "DRAFT" && <Button variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDialog("delete")}>Delete</Button>}
            <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/${x.id}/edit`)}>Edit</Button>
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={action.isPending}
              onClick={() => action.mutate({ action: "submit", success: "Submitted for approval" })}>Submit for approval</Button>
          </>}
          {x.status === "SUBMITTED" && can("expenses.approve") && <>
            <Button icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("reject")}>Reject</Button>
            <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setDialog("approve")}>Approve and post</Button>
          </>}
          {x.status === "POSTED" && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${x.number}`} loading={action.isPending}
              description="A reversing journal is posted and the expense is marked reversed. The original stays on record."
              onReverse={(reason) => action.mutateAsync({ action: "reverse", body: { reason }, success: "Expense reversed" })} />
          )}
          <PrintButton url={`/expenses/${x.id}/pdf/`} filename={x.number || `expense-draft-${x.id}`} label="Expense voucher" />
        </>} />
      {x.status === "REJECTED" && <Alert tone="warning" className="mb-4" title="Rejected">{x.rejection_reason}</Alert>}
      {x.status === "REVERSED" && <Alert tone="warning" className="mb-4" title="Reversed">{x.reversal_reason}</Alert>}
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Expense" className="lg:col-span-2">
            <KeyValues items={[
              { label: "Category", value: x.category_name },
              { label: "Date", value: <DateText value={x.date} bs={x.date_bs} /> },
              { label: "Payee", value: x.payee },
              { label: "Supplier", value: x.supplier ? <Link className="link" to={`/contacts/suppliers/${x.supplier}`}>{x.supplier_name}</Link> : "–" },
              { label: "Payment method", value: x.payment_method_name },
              { label: "Paid from", value: <Link className="link" to={`/finance/accounts/${x.paid_from_account}`}>{x.paid_from_account_name}</Link> },
              { label: "Reference", value: x.reference || "–" },
              { label: "Journal", value: x.journal ? <Link className="link" to={`/finance/journals/${x.journal}`}>{x.journal_number}</Link> : "Not posted" },
              { label: "Created by", value: x.created_by_name ?? "–" },
              { label: "Submitted", value: x.submitted_at ? formatDateTime(x.submitted_at) : "–" },
              { label: "Approved by", value: x.approved_by_name ? <>{x.approved_by_name} · {formatDateTime(x.approved_at)}</> : "–" },
              { label: "Fiscal year", value: x.fiscal_year_name ?? "Assigned on posting" },
              ...(x.description ? [{ label: "Description", value: <span className="whitespace-pre-line">{x.description}</span>, wide: true }] : []),
            ]} />
          </Panel>
          <Panel title="Amount">
            <dl className="space-y-2 p-4 text-[13px]">
              <div className="flex justify-between"><dt className="text-slate-600">Amount before tax</dt><dd className="tabular-nums">{formatAmount(x.amount)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-600">Tax ({formatPercent(x.tax_percent)})</dt><dd className="tabular-nums">{formatAmount(x.tax_amount)}</dd></div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total paid</dt><dd className="tabular-nums">{formatAmount(x.total)}</dd></div>
            </dl>
          </Panel>
        </div>
        <Attachments entityType="expense" entityId={x.id} canUpload={can("expenses.manage")} canDelete={can("expenses.manage") && editable} />
        <DocumentTimeline resource="expenses" id={x.id} />
      </div>

      <ConfirmDialog open={dialog === "approve"} onOpenChange={(o) => !o && setDialog(null)} title={`Approve ${title}`}
        description={<>Posts {formatAmount(x.total)} paid from {x.paid_from_account_name} to the ledger. Corrections afterwards need a reversal.</>}
        confirmLabel="Approve and post" loading={action.isPending}
        onConfirm={() => action.mutateAsync({ action: "approve", success: "Expense approved and posted" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "reject"} onOpenChange={(o) => !o && setDialog(null)} title={`Reject ${title}`} requireReason tone="danger"
        description="The expense goes back to the preparer, who can correct and resubmit it." confirmLabel="Reject expense" loading={action.isPending}
        onConfirm={(reason) => action.mutateAsync({ action: "reject", body: { reason }, success: "Expense rejected" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} title="Delete draft expense" tone="danger"
        description="The draft and its details are removed. This is recorded in the audit trail." confirmLabel="Delete draft" loading={deleting}
        onConfirm={remove} />
    </>
  );
}
