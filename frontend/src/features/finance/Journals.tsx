import { CheckCircle2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction, useOptions } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { PrintButton } from "@/components/document/PrintButton";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { BaseForm, CellInput, FormField, FormSection, useFieldArray, useFormContext, useWatch } from "@/components/form";
import { BaseTable, ResourceList, col, type TableColumn } from "@/components/table";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
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
        columns={[
          col.doc("number", "Voucher", { sortable: true }),
          col.date("date", "Date", { sortable: true }),
          col.text("source_label", "Source"),
          col.text("source_number", "Document"),
          col.text("narration", "Narration", { flex: 3, minWidth: 240 }),
          col.status("status"),
          col.money("total_debit", "Amount", { sortable: true }),
        ]}
        empty={{ title: "No journals", description: "Postings appear here as documents are posted." }} />
    </>
  );
}

interface AccountOption { id: number; code: string; name: string; system_key: string; is_active: boolean }
interface EditLine {
  account: number | null; customer: number | null; supplier: number | null; debit: string; credit: string; description: string;
  customer_name?: string | null; supplier_name?: string | null;
}
interface JournalValues { date: string; narration: string; source: string; lines: EditLine[] }

const newLine = (): EditLine => ({ account: null, customer: null, supplier: null, debit: "", credit: "", description: "" });

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

/** Editable journal lines (field array "lines") with live debit/credit totals. */
function JournalLinesEditor({ systemKey }: { systemKey: Map<number, string> }) {
  const { control, setValue, formState } = useFormContext<JournalValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = (useWatch<JournalValues, "lines">({ name: "lines" }) ?? []) as EditLine[];
  const disabled = formState.isSubmitting;
  const errOf = (i: number, f: string) => ((formState.errors.lines as any)?.[i]?.[f]?.message as string | undefined);

  // A line carries either a debit or a credit: typing on one side clears the other.
  const previous = useRef<EditLine[]>(lines);
  useEffect(() => {
    lines.forEach((l, i) => {
      const before = previous.current[i];
      if (!before) return;
      if (l.debit && l.debit !== before.debit && l.credit) setValue(`lines.${i}.credit`, "");
      if (l.credit && l.credit !== before.credit && l.debit) setValue(`lines.${i}.debit`, "");
    });
    previous.current = lines;
  }, [lines, setValue]);

  const totalDebit = round2(lines.reduce((s, l) => s + toNumber(l.debit), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + toNumber(l.credit), 0));
  const difference = round2(totalDebit - totalCredit);
  const rows = fields.map((f, index) => ({ id: f.id, index }));
  type Row = (typeof rows)[number];

  const columns: TableColumn<Row>[] = [
    col.custom("n", "#", (r) => <span className="text-xs text-slate-400">{r.index + 1}</span>, { width: 32 }),
    col.custom("account", "Account", (r) => (
      <>
        <EntitySelect resource="accounts" params={{ is_group: "false", is_active: "true" }} value={lines[r.index]?.account ?? null}
          disabled={disabled} invalid={!!errOf(r.index, "account")} placeholder="Account…"
          onChange={(account) => {
            setValue(`lines.${r.index}.account`, account, { shouldDirty: true });
            setValue(`lines.${r.index}.customer`, null);
            setValue(`lines.${r.index}.supplier`, null);
          }} />
        {errOf(r.index, "account") && <p className="mt-0.5 text-2xs text-red-600">{errOf(r.index, "account")}</p>}
      </>
    ), { width: 260 }),
    col.custom("party", "Party", (r) => {
      const line = lines[r.index];
      const key = line?.account ? systemKey.get(line.account) : "";
      const field = key === "RECEIVABLE" ? "customer" : key === "PAYABLE" ? "supplier" : null;
      if (!field) return <span className="block pt-1.5 text-xs text-slate-400">Not required</span>;
      const error = errOf(r.index, field);
      return (
        <>
          <EntitySelect resource={field === "customer" ? "customers" : "suppliers"} value={line[field]} disabled={disabled} invalid={!!error}
            initialLabel={(field === "customer" ? line.customer_name : line.supplier_name) ?? undefined}
            placeholder={field === "customer" ? "Customer…" : "Supplier…"}
            onChange={(v) => setValue(`lines.${r.index}.${field}`, v, { shouldDirty: true })} />
          {error && <p className="mt-0.5 text-2xs text-red-600">{error}</p>}
        </>
      );
    }, { width: 220 }),
    col.custom("debit", "Debit", (r) => <CellInput name={`lines.${r.index}.debit`} label={`Debit line ${r.index + 1}`} number disabled={disabled} />,
      { width: 128, align: "right", footer: formatAmount(totalDebit) }),
    col.custom("credit", "Credit", (r) => <CellInput name={`lines.${r.index}.credit`} label={`Credit line ${r.index + 1}`} number disabled={disabled} />,
      { width: 128, align: "right", footer: formatAmount(totalCredit) }),
    col.custom("description", "Description", (r) => (
      <CellInput name={`lines.${r.index}.description`} label={`Description line ${r.index + 1}`} disabled={disabled} />
    ), {
      footer: <span className={cn(difference === 0 ? "text-emerald-700" : "text-red-700")}>
        {difference === 0 ? (totalDebit ? "Balanced" : "") : `Difference ${formatAmount(Math.abs(difference))} (${difference > 0 ? "debit" : "credit"} side higher)`}
      </span>,
    }),
    col.custom("remove", "", (r) => (
      <Button size="sm" variant="ghost" aria-label={`Remove line ${r.index + 1}`} disabled={disabled || fields.length <= 2}
        onClick={() => remove(r.index)}><X className="h-3.5 w-3.5" /></Button>
    ), { width: 40 }),
  ];

  return (
    <FormSection title="Lines" bodyClassName="p-0"
      actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={disabled} onClick={() => append(newLine())}>Add line</Button>}>
      <div className="col-span-full">
        <BaseTable rows={rows} rowKey={(r) => r.id} columns={columns} footer density="compact" minWidth={980} />
        <p className="px-4 py-2 text-xs text-slate-500">Lines on accounts receivable or payable must name the customer or supplier. A draft may be unbalanced; posting requires debits to equal credits.</p>
      </div>
    </FormSection>
  );
}

function JournalFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const accounts = useOptions<AccountOption>("accounts", { is_group: "false" });
  const systemKey = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a.system_key])), [accounts.data]);
  const defaults: JournalValues = {
    date: initial?.date ?? todayIn(session?.organization?.timezone), narration: initial?.narration ?? "", source: initial?.source ?? "MANUAL",
    lines: initial?.lines?.length ? initial.lines.map((l: any): EditLine => ({
      account: l.account, customer: l.customer, supplier: l.supplier, description: l.description ?? "",
      debit: toNumber(l.debit) ? l.debit : "", credit: toNumber(l.credit) ? l.credit : "", customer_name: l.customer_name, supplier_name: l.supplier_name,
    })) : [newLine(), newLine()],
  };

  const submit = async (v: JournalValues, form: any) => {
    form.clearErrors();
    const used = v.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.account || toNumber(l.debit) || toNumber(l.credit));
    let invalid = false;
    const fail = (name: string, message: string) => { form.setError(name, { type: "manual", message }); invalid = true; };
    if (used.length < 2) throw new Error("Add at least two lines.");
    used.forEach(({ l, i }) => {
      const dr = toNumber(l.debit), cr = toNumber(l.credit);
      if (!l.account) fail(`lines.${i}.account`, "Choose an account.");
      if (dr < 0 || cr < 0) fail(`lines.${i}.credit`, "Amounts cannot be negative.");
      else if ((dr > 0) === (cr > 0)) fail(`lines.${i}.credit`, "Enter either a debit or a credit.");
      const key = l.account ? systemKey.get(l.account) : "";
      if (key === "RECEIVABLE" && !l.customer) fail(`lines.${i}.customer`, "Choose the customer.");
      if (key === "PAYABLE" && !l.supplier) fail(`lines.${i}.supplier`, "Choose the supplier.");
    });
    if (invalid) throw new Error("Fix the highlighted lines.");
    const body = {
      date: v.date, narration: v.narration, source: v.source,
      lines: used.map(({ l }) => {
        const key = l.account ? systemKey.get(l.account) : "";
        return {
          account: l.account, debit: toNumber(l.debit) ? l.debit : "0", credit: toNumber(l.credit) ? l.credit : "0", description: l.description,
          customer: key === "RECEIVABLE" ? l.customer : null, supplier: key === "PAYABLE" ? l.supplier : null,
        };
      }),
    };
    const { data } = initial ? await api.patch(`/journals/${initial.id}/`, body) : await api.post("/journals/", body);
    queryClient.invalidateQueries({ queryKey: ["journals"] });
    toast.success("Draft journal saved");
    navigate(`${BASE}/${data.id}`);
  };

  return (
    <>
      <PageHeader title={initial ? `Edit draft journal #${initial.id}` : "New journal"}
        back={{ to: initial ? `${BASE}/${initial.id}` : BASE, label: initial ? "Journal" : "Journals" }}
        subtitle="Saved as a draft. Posting checks that debits equal credits and that the period is open." />
      <BaseForm<JournalValues> defaultValues={defaults} onSubmit={submit} submitLabel="Save draft" onCancel={() => navigate(-1)}>
        <FormSection title="Journal">
          <FormField name="date" label="Date" type="date" required />
          <FormField name="source" label="Type" type="select" required emptyOption={false}
            options={[{ value: "MANUAL", label: "Manual journal" }, { value: "OPENING", label: "Opening balance" }]} />
          <FormField name="narration" label="Narration" type="textarea" rows={2} span={2} />
        </FormSection>
        <JournalLinesEditor systemKey={systemKey} />
      </BaseForm>
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
          <BaseTable rows={j.lines} minWidth={760} footer columns={[
            col.custom<any>("line_no", "#", (l) => <span className="text-slate-400">{l.line_no}</span>, { width: 32 }),
            col.custom<any>("account", "Account", (l) => (can("accounting.view")
              ? <Link className="link" to={`/finance/accounts/${l.account}`}>{l.account_code} {l.account_name}</Link>
              : <>{l.account_code} {l.account_name}</>)),
            col.custom<any>("party", "Party", (l) => (l.customer ? <Link className="link" to={`/contacts/customers/${l.customer}`}>{l.customer_name}</Link>
              : l.supplier ? <Link className="link" to={`/contacts/suppliers/${l.supplier}`}>{l.supplier_name}</Link> : <span className="text-slate-300">–</span>)),
            col.custom<any>("description", "Description", (l) => l.description || <span className="text-slate-300">–</span>, { footer: <span className="block text-right">Total</span> }),
            col.money<any>("debit", "Debit", { render: (l) => (toNumber(l.debit) ? formatAmount(l.debit) : ""), footer: formatAmount(j.total_debit) }),
            col.money<any>("credit", "Credit", { render: (l) => (toNumber(l.credit) ? formatAmount(l.credit) : ""), footer: formatAmount(j.total_credit) }),
            col.date<any>("cleared_date", "Cleared"),
          ]} />
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
