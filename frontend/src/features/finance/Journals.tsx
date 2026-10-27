import { CheckCircle2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
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
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, round2, toNumber } from "@/utils/format";
import { linkFor } from "@/utils/links";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = "/finance/journals";

export const JOURNAL_SOURCES = [
  { value: "MANUAL", label: "Manual journal" }, { value: "OPENING", label: "Opening balance" },
  { value: "SALES_INVOICE", label: "Sales invoice" }, { value: "DELIVERY", label: "Delivery (cost of goods sold)" },
  { value: "CUSTOMER_RECEIPT", label: "Customer receipt" }, { value: "CUSTOMER_REFUND", label: "Customer refund" },
  { value: "SALES_RETURN", label: "Sales return" }, { value: "GOODS_RECEIPT", label: "Goods received" },
  { value: "PURCHASE_BILL", label: "Supplier bill" }, { value: "PAYMENT_VOUCHER", label: "Payment voucher" },
  { value: "SUPPLIER_REFUND", label: "Supplier refund" }, { value: "PURCHASE_RETURN", label: "Purchase return" },
  { value: "EXPENSE", label: "Expense" }, { value: "STOCK", label: "Stock movement" }, { value: "YEAR_END", label: "Year-end closing" },
  { value: "REVERSAL", label: "Reversal" },
];
const JOURNAL_STATUSES = [{ value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" }];
const EDITABLE_SOURCES = ["MANUAL", "OPENING"];

export function JournalList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Journals" subtitle="Every posting in the ledger. System journals come from documents; manual journals are entered here."
        actions={can("accounting.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/new`)}>New journal</Button>
        )} />
      <ResourceList resource="journals" dated searchPlaceholder="Voucher no., narration, document no.…" detailPath={(r) => `${BASE}/${r.id}`}
        exportUrl="/journals/export/"
        filters={[
          { type: "select", name: "source", label: "Source", options: JOURNAL_SOURCES },
          { type: "select", name: "status", label: "Status", options: JOURNAL_STATUSES },
          { type: "entity", name: "lines__account", label: "Account", resource: "accounts", params: { is_group: "false" } },
        ]}
        columns={(ctx) => [
          col.doc("number", "Voucher", { sortable: true }),
          col.date("date", "Date", ctx, { sortable: true }),
          col.text("source_label", "Source"),
          col.text("source_number", "Document"),
          col.text("narration", "Narration", { flex: 3, minWidth: 240, tooltipField: "narration" }),
          col.status("status"),
          col.money("total_debit", "Amount", { sortable: true }),
        ]}
        empty={{ title: "No journals", description: "Postings appear here as documents are posted." }} />
    </>
  );
}

interface AccountOption { id: number; code: string; name: string; system_key: string; is_active: boolean }
interface EditLine {
  key: number; account: number | null; customer: number | null; supplier: number | null; debit: string; credit: string; description: string;
  customer_name?: string | null; supplier_name?: string | null;
}

let lineKey = 0;
const newLine = (): EditLine => ({ key: ++lineKey, account: null, customer: null, supplier: null, debit: "", credit: "", description: "" });

export function JournalForm() {
  const { id } = useParams();
  const query = useDetail<any>("journals", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const doc = query.data;
  if (doc && (doc.status !== "DRAFT" || !EDITABLE_SOURCES.includes(doc.source))) {
    return (
      <>
        <PageHeader title={`Edit ${doc.number || `draft #${doc.id}`}`} back={{ to: `${BASE}/${doc.id}`, label: doc.number || "Journal" }} />
        <Alert tone="warning" title="This journal cannot be edited">Only draft manual or opening-balance journals can be changed. Posted journals are corrected by reversal.</Alert>
      </>
    );
  }
  return <JournalFormBody key={id ?? "new"} initial={doc} />;
}

function JournalFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const accounts = useOptions<AccountOption>("accounts", { is_group: "false" });
  const systemKey = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a.system_key])), [accounts.data]);
  const [date, setDate] = useState<string>(initial?.date ?? todayIn(session?.organization?.timezone));
  const [narration, setNarration] = useState<string>(initial?.narration ?? "");
  const [source, setSource] = useState<string>(initial?.source ?? "MANUAL");
  const [lines, setLines] = useState<EditLine[]>(initial?.lines?.length ? initial.lines.map((l: any) => ({
    key: ++lineKey, account: l.account, customer: l.customer, supplier: l.supplier, description: l.description ?? "",
    debit: toNumber(l.debit) ? l.debit : "", credit: toNumber(l.credit) ? l.credit : "", customer_name: l.customer_name, supplier_name: l.supplier_name,
  })) : [newLine(), newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const update = (key: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const totalDebit = round2(lines.reduce((s, l) => s + toNumber(l.debit), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + toNumber(l.credit), 0));
  const difference = round2(totalDebit - totalCredit);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!date) e.date = "Enter the journal date.";
    const used = lines.filter((l) => l.account || toNumber(l.debit) || toNumber(l.credit));
    if (used.length < 2) e.lines = "Add at least two lines.";
    used.forEach((l) => {
      const i = lines.indexOf(l);
      const dr = toNumber(l.debit), cr = toNumber(l.credit);
      if (!l.account) e[`lines.${i}.account`] = "Choose an account.";
      if (dr < 0 || cr < 0) e[`lines.${i}.amount`] = "Amounts cannot be negative.";
      else if ((dr > 0) === (cr > 0)) e[`lines.${i}.amount`] = "Enter either a debit or a credit.";
      const key = l.account ? systemKey.get(l.account) : "";
      if (key === "RECEIVABLE" && !l.customer) e[`lines.${i}.party`] = "Choose the customer.";
      if (key === "PAYABLE" && !l.supplier) e[`lines.${i}.party`] = "Choose the supplier.";
    });
    setErrors(e);
    if (Object.keys(e).length) { toast.error(e.lines ?? "Fix the highlighted lines."); return; }
    setSaving(true);
    const body = {
      date, narration, source,
      lines: used.map((l) => {
        const key = l.account ? systemKey.get(l.account) : "";
        return {
          account: l.account, debit: toNumber(l.debit) ? l.debit : "0", credit: toNumber(l.credit) ? l.credit : "0", description: l.description,
          customer: key === "RECEIVABLE" ? l.customer : null, supplier: key === "PAYABLE" ? l.supplier : null,
        };
      }),
    };
    try {
      const { data } = initial ? await api.patch(`/journals/${initial.id}/`, body) : await api.post("/journals/", body);
      queryClient.invalidateQueries({ queryKey: ["journals"] });
      toast.success("Draft journal saved");
      navigate(`${BASE}/${data.id}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={initial ? `Edit draft journal #${initial.id}` : "New journal"}
        back={{ to: initial ? `${BASE}/${initial.id}` : BASE, label: initial ? "Journal" : "Journals" }}
        subtitle="Saved as a draft. Posting checks that debits equal credits and that the period is open." />
      <div className="space-y-4">
        <Panel title="Journal">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date" required error={errors.date}><DatePicker value={date} onChange={setDate} invalid={!!errors.date} /></Field>
            <Field label="Type" required error={errors.source}>
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="MANUAL">Manual journal</option>
                <option value="OPENING">Opening balance</option>
              </Select>
            </Field>
            <Field label="Narration" error={errors.narration} className="sm:col-span-2">
              <Textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={2} />
            </Field>
          </div>
        </Panel>
        <Panel title="Lines" actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setLines((ls) => [...ls, newLine()])}>Add line</Button>}>
          {errors.lines && <Alert tone="error" className="m-4">{errors.lines}</Alert>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2">#</th><th className="w-[260px] px-3 py-2">Account</th><th className="w-[220px] px-3 py-2">Party</th>
                  <th className="w-32 px-3 py-2 text-right">Debit</th><th className="w-32 px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2">Description</th><th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const key = l.account ? systemKey.get(l.account) : "";
                  const lineErr = errors[`lines.${i}.amount`] ?? errors[`lines.${i}.debit`] ?? errors[`lines.${i}.credit`] ?? errors[`lines.${i}.non_field_errors`] ?? errors[`lines.${i}`];
                  return (
                    <tr key={l.key} className="border-b border-line align-top">
                      <td className="px-3 py-1.5 pt-3 text-slate-400">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <EntitySelect resource="accounts" params={{ is_group: "false", is_active: "true" }} value={l.account}
                          invalid={!!errors[`lines.${i}.account`]}
                          onChange={(account) => update(l.key, { account, customer: null, supplier: null })} placeholder="Account…" />
                        {errors[`lines.${i}.account`] && <p className="mt-0.5 text-xs text-red-600">{errors[`lines.${i}.account`]}</p>}
                      </td>
                      <td className="px-3 py-1.5">
                        {key === "RECEIVABLE" ? (
                          <EntitySelect resource="customers" value={l.customer} initialLabel={l.customer_name ?? undefined} placeholder="Customer…"
                            invalid={!!errors[`lines.${i}.party`] || !!errors[`lines.${i}.customer`]} onChange={(customer) => update(l.key, { customer })} />
                        ) : key === "PAYABLE" ? (
                          <EntitySelect resource="suppliers" value={l.supplier} initialLabel={l.supplier_name ?? undefined} placeholder="Supplier…"
                            invalid={!!errors[`lines.${i}.party`] || !!errors[`lines.${i}.supplier`]} onChange={(supplier) => update(l.key, { supplier })} />
                        ) : <span className="block pt-1.5 text-xs text-slate-400">Not required</span>}
                        {(errors[`lines.${i}.party`] ?? errors[`lines.${i}.customer`] ?? errors[`lines.${i}.supplier`]) &&
                          <p className="mt-0.5 text-xs text-red-600">{errors[`lines.${i}.party`] ?? errors[`lines.${i}.customer`] ?? errors[`lines.${i}.supplier`]}</p>}
                      </td>
                      <td className="px-3 py-1.5">
                        <NumberInput aria-label={`Debit line ${i + 1}`} value={l.debit} invalid={!!lineErr}
                          onChange={(e) => update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })} />
                      </td>
                      <td className="px-3 py-1.5">
                        <NumberInput aria-label={`Credit line ${i + 1}`} value={l.credit} invalid={!!lineErr}
                          onChange={(e) => update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })} />
                        {lineErr && <p className="mt-0.5 text-xs text-red-600">{lineErr}</p>}
                      </td>
                      <td className="px-3 py-1.5">
                        <Input aria-label={`Description line ${i + 1}`} value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                      </td>
                      <td className="px-3 py-1.5">
                        <Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2}
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X className="h-3.5 w-3.5" /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="text-[13px]">
                <tr className="font-semibold">
                  <td colSpan={3} className="px-3 py-2 text-right">Total</td>
                  <td className="num px-3 py-2">{formatAmount(totalDebit)}</td>
                  <td className="num px-3 py-2">{formatAmount(totalCredit)}</td>
                  <td colSpan={2} className={cn("px-3 py-2", difference === 0 ? "text-emerald-700" : "text-red-700")}>
                    {difference === 0 ? (totalDebit ? "Balanced" : "") : `Difference ${formatAmount(Math.abs(difference))} (${difference > 0 ? "debit" : "credit"} side higher)`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="px-4 py-2 text-xs text-slate-500">Lines on accounts receivable or payable must name the customer or supplier. A draft may be unbalanced; posting requires debits to equal credits.</p>
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={submit}>Save draft</Button>
        </div>
      </div>
    </>
  );
}

export function JournalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const query = useDetail<any>("journals", id);
  const action = useDocumentAction<any>("journals", id, ["accounts", "customers", "suppliers"]);
  const [dialog, setDialog] = useState<null | "post" | "delete">(null);
  const [busy, setBusy] = useState(false);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const j = query.data;
  const title = j.number || `Draft journal #${j.id}`;
  const manual = EDITABLE_SOURCES.includes(j.source);
  const sourceTo = linkFor(j.source_link, j.source_id);
  const difference = round2(toNumber(j.total_debit) - toNumber(j.total_credit));

  // Reverse returns the new reversing journal, so it is handled here rather than through useDocumentAction (which caches the response as this record).
  const reverse = async (reason: string) => {
    try {
      const { data } = await api.post(`/journals/${j.id}/reverse/`, { reason });
      ["journals", "accounts", "customers", "suppliers", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      toast.success(`Reversed by ${data.number}`);
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/journals/${j.id}/`);
      queryClient.invalidateQueries({ queryKey: ["journals"] });
      toast.success("Draft journal deleted");
      navigate(BASE);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader back={{ to: BASE, label: "Journals" }} title={title} meta={<StatusBadge status={j.status} label={j.status_label} />}
        subtitle={<>{j.source_label} · <DateText value={j.date} bs={j.date_bs} /></>}
        actions={<>
          {j.status === "DRAFT" && manual && can("accounting.manage") && <>
            <Button variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDialog("delete")}>Delete</Button>
            <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`${BASE}/${j.id}/edit`)}>Edit</Button>
          </>}
          {j.status === "DRAFT" && can("accounting.post") && (
            <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} disabled={difference !== 0} onClick={() => setDialog("post")}
              title={difference !== 0 ? "Debits and credits must be equal before posting" : undefined}>Post journal</Button>
          )}
          {j.status === "POSTED" && manual && !j.reversed_by && can("accounting.reverse") && (
            <ReverseAction title={`Reverse ${j.number}`} onReverse={reverse}
              description="An equal and opposite journal is posted today (or on the journal date if later). The original stays on record." />
          )}
          <PrintButton url={`/journals/${j.id}/pdf/`} filename={j.number || `journal-draft-${j.id}`} label="Print voucher" />
        </>} />
      {j.status === "DRAFT" && difference !== 0 && <Alert tone="warning" className="mb-4">Not balanced: debits exceed credits by {formatAmount(difference)}. Edit the draft before posting.</Alert>}
      {j.reversed_by && <Alert tone="warning" className="mb-4" title="Reversed">
        Reversed by <Link className="link" to={`${BASE}/${j.reversed_by.id}`}>{j.reversed_by.number}</Link>.
      </Alert>}
      {j.reversal_of && <Alert tone="info" className="mb-4" title="Reversing entry">
        Reverses <Link className="link" to={`${BASE}/${j.reversal_of}`}>{j.reversal_of_number}</Link>{j.reversal_reason && <>. Reason: {j.reversal_reason}</>}
      </Alert>}
      {!manual && j.status === "POSTED" && <Alert tone="info" className="mb-4">System journal. To correct it, reverse the source document{sourceTo ? <> (<Link className="link" to={sourceTo}>{j.source_number}</Link>)</> : ""}.</Alert>}
      <div className="space-y-4">
        <Panel title="Journal">
          <KeyValues items={[
            { label: "Voucher", value: j.number || "Assigned on posting" },
            { label: "Date", value: <DateText value={j.date} bs={j.date_bs} /> },
            { label: "Fiscal year / period", value: [j.fiscal_year_name, j.period_name].filter(Boolean).join(" · ") || "–" },
            { label: "Source", value: j.source_label },
            { label: "Document", value: j.source_number ? (sourceTo ? <Link className="link" to={sourceTo}>{j.source_number}</Link> : j.source_number) : "–" },
            { label: "Created by", value: j.created_by_name ?? "–" },
            { label: "Posted by", value: j.posted_by_name ? <>{j.posted_by_name} · {formatDateTime(j.posted_at)}</> : "–" },
            { label: "Amount", value: <strong>{formatAmount(j.total_debit)}</strong> },
            ...(j.narration ? [{ label: "Narration", value: <span className="whitespace-pre-line">{j.narration}</span>, wide: true }] : []),
          ]} />
        </Panel>
        <Panel title="Lines">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2">#</th><th className="px-3 py-2">Account</th><th className="px-3 py-2">Party</th>
                  <th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2">Cleared</th>
                </tr>
              </thead>
              <tbody>
                {j.lines.map((l: any) => (
                  <tr key={l.id} className="border-b border-line">
                    <td className="px-3 py-1.5 text-slate-400">{l.line_no}</td>
                    <td className="px-3 py-1.5">
                      {can("accounting.view") ? <Link className="link" to={`/finance/accounts/${l.account}`}>{l.account_code} {l.account_name}</Link>
                        : <>{l.account_code} {l.account_name}</>}
                    </td>
                    <td className="px-3 py-1.5">
                      {l.customer ? <Link className="link" to={`/contacts/customers/${l.customer}`}>{l.customer_name}</Link>
                        : l.supplier ? <Link className="link" to={`/contacts/suppliers/${l.supplier}`}>{l.supplier_name}</Link> : <span className="text-slate-300">–</span>}
                    </td>
                    <td className="px-3 py-1.5">{l.description || <span className="text-slate-300">–</span>}</td>
                    <td className="num px-3 py-1.5">{toNumber(l.debit) ? formatAmount(l.debit) : ""}</td>
                    <td className="num px-3 py-1.5">{toNumber(l.credit) ? formatAmount(l.credit) : ""}</td>
                    <td className="px-3 py-1.5">{l.cleared_date ? <DateText value={l.cleared_date} /> : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={4} className="px-3 py-2 text-right">Total</td>
                  <td className="num px-3 py-2">{formatAmount(j.total_debit)}</td>
                  <td className="num px-3 py-2">{formatAmount(j.total_credit)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
        <DocumentTimeline resource="journals" id={j.id} />
      </div>
      <ConfirmDialog open={dialog === "post"} onOpenChange={(o) => !o && setDialog(null)} title={`Post ${title}`} loading={action.isPending}
        description={<>Posts {formatAmount(j.total_debit)} to the ledger and assigns a voucher number. Posted journals cannot be edited, only reversed.</>}
        confirmLabel="Post journal"
        onConfirm={() => action.mutateAsync({ action: "post", success: "Journal posted" }).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} title="Delete draft journal" tone="danger" loading={busy}
        description="The draft is removed. This is recorded in the audit trail." confirmLabel="Delete draft" onConfirm={remove} />
    </>
  );
}
