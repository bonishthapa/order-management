import { Plus, Send, Trash2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { BaseForm, CellInput, CellSelect, FormField, FormSection, useFormContext, useWatch } from "@/components/form";
import { useDetail, useDocumentAction } from "@/api/hooks";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { BaseTable, col, ResourceList } from "@/components/table";
import { AllocationTable, allocationPayload } from "@/components/document/AllocationTable";
import { DocumentLines, DocumentTotals } from "@/components/document/DocumentLines";
import { PrintButton } from "@/components/document/PrintButton";
import { DocumentTimeline } from "@/components/document/Timeline";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
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
        columns={[
          col.doc("number", "Credit note"), col.date("date", "Date", { sortable: true }), col.text("customer_name", "Customer", { flex: 2 }),
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
  const submit = async (values: Record<string, any>, _form: unknown, intent: string) => {
    const post = intent === "post";
    const lines = (values.lines as ReturnRow[]).filter((r) => toNumber(r.quantity) > 0)
      .map((r) => ({ invoice_line: r.invoice_line, quantity: r.quantity, inspection: r.inspection }));
    if (!lines.length) throw new Error("Enter at least one quantity to return.");
    const { data } = await api.post("/sales-returns/", { invoice: values.invoice, warehouse: values.warehouse, date: values.date, reason: values.reason, lines });
    if (post) await api.post(`/sales-returns/${data.id}/post/`);
    ["sales-returns", "sales-invoices", "customers", "inventory/balances"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    toast.success(post ? "Return posted and credit note issued" : "Draft saved");
    navigate(`/sales/returns/${data.id}`);
  };

  return (
    <>
      <PageHeader title="New sales return" back={{ to: "/sales/returns", label: "Sales returns" }}
        subtitle="Returns are raised against a posted invoice; prices and tax come from that invoice." />
      <BaseForm onSubmit={submit} onCancel={() => navigate(-1)}
        submitActions={[{ key: "draft", label: "Save draft" }, { key: "post", label: "Post return", primary: true }]}
        defaultValues={{ invoice: params.get("invoice") ? Number(params.get("invoice")) : null, warehouse: null,
          date: todayIn(session?.organization?.timezone), reason: "", lines: [] as ReturnRow[] }}>
        <ReturnFields />
      </BaseForm>
    </>
  );
}

function ReturnFields() {
  const { setValue } = useFormContext();
  const invoiceId = useWatch({ name: "invoice" }) as number | null;
  const invoice = useDetail<any>("sales-invoices", invoiceId ?? undefined);
  const rows = (useWatch({ name: "lines" }) ?? []) as ReturnRow[];
  useEffect(() => {
    const inv = invoice.data;
    if (!inv) return;
    setValue("warehouse", inv.warehouse ?? null);
    setValue("lines", inv.lines.map((l: any): ReturnRow => ({
      invoice_line: l.id, sku: l.sku, product_name: l.product_name, unit: l.unit, sold: l.quantity, unit_price: l.unit_price, is_stock: l.is_stock,
      returnable: toNumber(l.quantity) - toNumber(l.returned_quantity), quantity: "0", inspection: "RESTOCK",
    })));
  }, [invoice.data, setValue]);
  return (
    <>
      <FormSection title="Return">
        <FormField name="invoice" label="Original invoice" type="entity" resource="sales-invoices" params={{ status: "POSTED" }} required span={2}
          optionLabel={(i) => `${i.number} · ${i.customer_display}`} optionSublabel={(i) => `Total ${formatAmount(i.grand_total)}`} />
        <FormField name="date" label="Return date" type="date" required min={invoice.data?.invoice_date} />
        <FormField name="warehouse" label="Receive into warehouse" type="entity" resource="warehouses" required />
        <FormField name="reason" label="Reason" type="textarea" rows={2} required span={4} />
      </FormSection>
      <Panel title="Items returned">
        {!invoiceId ? <p className="p-4 text-xs text-slate-500">Choose the invoice first.</p> : invoice.isLoading ? <LoadingBlock /> : (
          <BaseTable rows={rows} rowKey={(r) => r.invoice_line} columns={[
            col.custom("product_name", "Item", (r: ReturnRow) => <><div className="font-medium">{r.product_name}</div><div className="text-2xs text-slate-500">{r.sku}</div></>),
            col.custom("sold", "Sold", (r: ReturnRow) => `${formatQty(r.sold)} ${r.unit}`, { align: "right" }),
            col.qty("returnable", "Returnable"),
            col.money("unit_price", "Rate"),
            col.custom("quantity", "Return qty", (r: ReturnRow) => {
              const i = rows.indexOf(r);
              return <CellInput number name={`lines.${i}.quantity`} label={`Return quantity for ${r.sku}`}
                invalid={toNumber(r.quantity) > r.returnable} disabled={r.returnable <= 0} />;
            }, { width: 120 }),
            col.custom("inspection", "Inspection", (r: ReturnRow) => {
              const i = rows.indexOf(r);
              return r.is_stock ? <CellSelect name={`lines.${i}.inspection`} label="Inspection" options={INSPECTION} />
                : <span className="text-2xs text-slate-400">Service</span>;
            }, { width: 230 }),
          ]} />
        )}
      </Panel>
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
          <DocumentLines lines={r.lines} extra={[col.status("inspection", "Inspection")]} />
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
