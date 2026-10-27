import { PackageCheck, Pencil, Plus, Send, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useDetail, useDocumentAction, useList } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { DocumentLines } from "@/components/document/DocumentLines";
import { DocumentTimeline } from "@/components/document/Timeline";
import { BaseForm, CellInput, FormDialog, FormField, FormGrid, FormSection, useFieldArray, useFormContext, useWatch } from "@/components/form";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { BaseTable, ResourceList, col } from "@/components/table";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { BatchSelect, CellError, LineSerials, RemoveLineButton, parseSerials, useBalance, useBatches, useLineError, useLineProduct } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TRANSFER_STATUSES = [
  { value: "DRAFT", label: "Draft" }, { value: "IN_TRANSIT", label: "In transit" }, { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

export function TransferList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Stock transfers" subtitle="Goods moved between warehouses. Dispatch moves stock into transit; receiving books it into the destination."
        actions={can("inventory.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/transfers/new")}>New transfer</Button>
        )} />
      <ResourceList resource="stock-transfers" dated searchPlaceholder="Transfer no., notes…" detailPath={(r) => `/inventory/transfers/${r.id}`}
        filters={[
          { type: "select", name: "status", label: "Status", options: TRANSFER_STATUSES },
          { type: "entity", name: "source_warehouse", label: "From", resource: "warehouses" },
          { type: "entity", name: "destination_warehouse", label: "To", resource: "warehouses" },
        ]}
        columns={[
          col.doc("number", "Transfer"),
          col.date("date", "Date"),
          col.text("source_name", "From", { flex: 2, minWidth: 180 }),
          col.text("destination_name", "To", { flex: 2, minWidth: 180 }),
          col.number("line_count", "Lines", { value: (r: any) => r.lines?.length ?? 0, render: (r: any) => r.lines?.length ?? 0, width: 90 }),
          col.date("received_date", "Received"),
          col.status("status"),
        ]}
        empty={{ title: "No transfers", description: "Create a transfer to move stock between warehouses." }} />
    </>
  );
}

// --- Form ------------------------------------------------------------------------------------------

interface TransferLine { product: number | null; quantity: string; batch_number: string; serials: string }
interface TransferValues {
  source_warehouse: number | null;
  destination_warehouse: number | null;
  date: string;
  notes: string;
  lines: TransferLine[];
}
const emptyTransferLine = (): TransferLine => ({ product: null, quantity: "", batch_number: "", serials: "" });

export function TransferForm() {
  const { id } = useParams();
  const query = useDetail<any>("stock-transfers", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <TransferFormBody initial={query.data} />;
}

function TransferFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();

  if (initial && initial.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={initial.number || `Transfer #${initial.id}`} back={{ to: `/inventory/transfers/${initial.id}`, label: "Transfer" }} />
        <Alert tone="warning">Only draft transfers can be edited.</Alert>
      </>
    );
  }

  const defaultValues: TransferValues = initial ? {
    source_warehouse: initial.source_warehouse, destination_warehouse: initial.destination_warehouse, date: initial.date, notes: initial.notes ?? "",
    lines: initial.lines.map((l: any) => ({ product: l.product, quantity: String(Number(l.quantity)), batch_number: l.batch_number ?? "",
      serials: (l.serial_numbers ?? []).join("\n") })),
  } : { source_warehouse: null, destination_warehouse: null, date: todayIn(session?.organization?.timezone), notes: "", lines: [emptyTransferLine()] };

  return (
    <>
      <PageHeader title={initial ? `Edit draft transfer #${initial.id}` : "New stock transfer"}
        back={initial ? { to: `/inventory/transfers/${initial.id}`, label: "Transfer" } : { to: "/inventory/transfers", label: "Stock transfers" }}
        subtitle="Saved as a draft. Stock leaves the source warehouse only when the transfer is dispatched." />
      <BaseForm<TransferValues> defaultValues={defaultValues} submitLabel={initial ? "Save changes" : "Save draft"} onCancel={() => navigate(-1)}
        onSubmit={async (values, form) => {
          form.clearErrors("lines");
          let invalid = false;
          const fail = (name: string, message: string) => { form.setError(name as any, { type: "manual", message }); invalid = true; };
          if (values.source_warehouse && values.source_warehouse === values.destination_warehouse) {
            fail("destination_warehouse", "Choose a different destination warehouse.");
          }
          if (!values.lines.length) fail("lines", "Add at least one line.");
          const seen = new Set<number>();
          values.lines.forEach((l, i) => {
            if (!l.product) fail(`lines.${i}.product`, "Choose a product.");
            else if (seen.has(l.product)) fail(`lines.${i}.product`, "List each product once per transfer.");
            if (l.product) seen.add(l.product);
            if (!(toNumber(l.quantity) > 0)) fail(`lines.${i}.quantity`, "Enter a positive quantity.");
          });
          if (invalid) throw new Error("Correct the highlighted fields.");
          const payload = {
            source_warehouse: values.source_warehouse, destination_warehouse: values.destination_warehouse, date: values.date, notes: values.notes,
            lines: values.lines.map((l) => ({ product: l.product, quantity: l.quantity, batch_number: l.batch_number, serial_numbers: parseSerials(l.serials) })),
          };
          const { data } = initial ? await api.patch(`/stock-transfers/${initial.id}/`, payload) : await api.post("/stock-transfers/", payload);
          queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
          toast.success(initial ? "Transfer updated" : "Draft transfer saved");
          navigate(`/inventory/transfers/${data.id}`);
        }}>
        <FormSection title="Transfer" columns={4}>
          <FormField name="source_warehouse" label="From warehouse" type="entity" resource="warehouses" required />
          <FormField name="destination_warehouse" label="To warehouse" type="entity" resource="warehouses" required />
          <FormField name="date" label="Dispatch date" type="date" required />
          <FormField name="notes" label="Notes" type="textarea" rows={1} />
        </FormSection>
        <TransferLines />
      </BaseForm>
    </>
  );
}

function TransferLines() {
  const { control, formState } = useFormContext<TransferValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const source = useWatch({ control, name: "source_warehouse" });
  const linesError = (formState.errors as any).lines?.message ?? (formState.errors as any).lines?.root?.message;
  const rows = fields.map((f, index) => ({ id: f.id, index }));
  return (
    <Panel title="Items" actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyTransferLine())}>Add line</Button>}>
      {!source && <p className="px-4 pt-3 text-xs text-slate-500">Choose the source warehouse to see available stock.</p>}
      {linesError && <Alert tone="error" className="m-4">{linesError}</Alert>}
      <BaseTable rows={rows} rowKey={(r) => r.id} minWidth={860} density="compact" columns={[
        col.custom("n", "#", (r) => <span className="text-xs text-slate-400">{r.index + 1}</span>, { width: 32, className: "pt-3" }),
        col.custom("product", "Product", (r) => <TransferLineProduct index={r.index} source={source} />, { minWidth: 260 }),
        col.custom("available", "Available at source", (r) => <TransferLineAvailable index={r.index} source={source} />, { width: 144, align: "right", className: "pt-2.5" }),
        col.custom("quantity", "Quantity", (r) => <TransferLineQuantity index={r.index} source={source} />, { width: 128, align: "right" }),
        col.custom("batch_number", "Batch", (r) => <TransferLineBatch index={r.index} source={source} />, { width: 192 }),
        col.custom("serials", "Serial numbers", (r) => <LineSerials index={r.index} />, { minWidth: 180 }),
        col.custom("remove", "", (r) => (fields.length > 1 ? <RemoveLineButton onClick={() => remove(r.index)} /> : null), { width: 40 }),
      ]} />
    </Panel>
  );
}

function TransferLineProduct({ index, source }: { index: number; source: number | null }) {
  const { setValue, clearErrors } = useFormContext();
  const { productId } = useLineProduct(index);
  const error = useLineError(index, "product");
  return (
    <>
      <EntitySelect resource="products" params={{ product_type: "STOCK", is_active: "true", warehouse: source ?? "" }} value={productId} invalid={!!error}
        onChange={(v) => { setValue(`lines.${index}.product`, v, { shouldDirty: true }); clearErrors(`lines.${index}.product`); }}
        sublabel={(item) => (source ? `On hand ${formatQty(item.on_hand)} ${item.unit_code}` : item.unit_code)} />
      <CellError message={error} />
    </>
  );
}

/** True when the line asks for more than is available at the source. */
function useShortage(index: number, source: number | null) {
  const quantity = useWatch({ name: `lines.${index}.quantity` }) as string;
  const { productId, product } = useLineProduct(index);
  const balance = useBalance(source, productId);
  const short = !!productId && !!source && !balance.loading && toNumber(quantity) > toNumber(balance.available);
  return { productId, product, balance, short };
}

function TransferLineAvailable({ index, source }: { index: number; source: number | null }) {
  const { productId, product, balance, short } = useShortage(index, source);
  if (!productId || !source) return <span className="text-slate-400">–</span>;
  if (balance.loading) return <span className="text-slate-400">…</span>;
  return (
    <span className={cn(short && "font-medium text-red-700")}>
      {formatQty(balance.available)} <span className="text-2xs text-slate-400">{product?.unit_code}</span>
      {toNumber(balance.reserved) > 0 && <span className="block text-2xs text-slate-400">{formatQty(balance.reserved)} reserved</span>}
    </span>
  );
}

function TransferLineQuantity({ index, source }: { index: number; source: number | null }) {
  const { short } = useShortage(index, source);
  const error = useLineError(index, "quantity");
  return (
    <>
      <CellInput number name={`lines.${index}.quantity`} label="Quantity" invalid={short} />
      {!error && short && <CellError message="More than available." />}
    </>
  );
}

function TransferLineBatch({ index, source }: { index: number; source: number | null }) {
  const { productId, product: p } = useLineProduct(index);
  const batches = useBatches(productId, source, !!p?.track_batches);
  if (!p?.track_batches) return <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>;
  return <BatchSelect name={`lines.${index}.batch_number`} batches={batches.data?.results ?? []} />;
}

// --- Detail ----------------------------------------------------------------------------------------

const STEPS = [{ key: "DRAFT", label: "Draft" }, { key: "IN_TRANSIT", label: "In transit" }, { key: "RECEIVED", label: "Received" }];

export function TransferDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const queryClient = useQueryClient();
  const query = useDetail<any>("stock-transfers", id);
  const action = useDocumentAction<any>("stock-transfers", id, ["stock-movements", "inventory/ledger"]);
  const movements = useList<any>("stock-movements", { reference_type: "stock_transfer", reference_id: id, ordering: "created_at", page_size: 50 });
  const [dialog, setDialog] = useState<null | "dispatch" | "receive" | "cancel">(null);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const t = query.data;
  const stepIndex = STEPS.findIndex((s) => s.key === t.status);

  return (
    <>
      <PageHeader back={{ to: "/inventory/transfers", label: "Stock transfers" }} title={t.number || `Draft transfer #${t.id}`}
        meta={<StatusBadge status={t.status} />}
        subtitle={<>{t.source_name} → {t.destination_name} · <DateText value={t.date} bs={t.date_bs} /></>}
        actions={<>
          {t.status === "DRAFT" && can("inventory.manage") && (
            <>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/inventory/transfers/${t.id}/edit`)}>Edit</Button>
              <Button variant="danger" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("cancel")}>Cancel draft</Button>
            </>
          )}
          {t.status === "DRAFT" && can("inventory.post") && (
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setDialog("dispatch")}>Dispatch</Button>
          )}
          {t.status === "IN_TRANSIT" && can("inventory.post") && (
            <Button variant="primary" icon={<PackageCheck className="h-3.5 w-3.5" />} onClick={() => setDialog("receive")}>Receive</Button>
          )}
        </>} />

      {t.status === "CANCELLED" ? <Alert tone="info" className="mb-4">This transfer was cancelled before dispatch. No stock moved.</Alert> : (
        <ol className="mb-4 flex items-center gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border text-2xs font-semibold",
                i < stepIndex ? "border-emerald-500 bg-emerald-500 text-white" : i === stepIndex ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong text-slate-400")}>
                {i + 1}
              </span>
              <span className={cn(i <= stepIndex ? "font-medium text-slate-700" : "text-slate-400")}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="mx-1 h-px w-10 bg-line-strong" />}
            </li>
          ))}
        </ol>
      )}

      <div className="space-y-4">
        <Panel title="Transfer">
          <KeyValues items={[
            { label: "From", value: t.source_name },
            { label: "To", value: t.destination_name },
            { label: "Dispatch date", value: <DateText value={t.date} bs={t.date_bs} /> },
            { label: "Received date", value: <DateText value={t.received_date} bs={t.received_date_bs} /> },
            { label: "Dispatched by", value: t.dispatched_by_name ? `${t.dispatched_by_name} · ${formatDateTime(t.dispatched_at)}` : "–" },
            { label: "Received by", value: t.received_by_name ?? "–" },
            { label: "Notes", value: t.notes ? <span className="whitespace-pre-line">{t.notes}</span> : "–", wide: true },
          ]} />
        </Panel>
        <Panel title="Items">
          <DocumentLines showPricing={false} lines={t.lines} />
        </Panel>
        <Panel title="Stock movements">
          {movements.isLoading ? <LoadingBlock /> : !movements.data?.results.length ? (
            <p className="p-4 text-xs text-slate-500">{t.status === "DRAFT" ? "Movements are created when the transfer is dispatched." : "No movements recorded."}</p>
          ) : (
            <ol className="relative space-y-3 p-4 before:absolute before:bottom-4 before:left-[21px] before:top-4 before:w-px before:bg-line">
              {movements.data.results.map((m: any) => (
                <li key={m.id} className="relative flex flex-wrap items-baseline gap-x-3 pl-6 text-[13px]">
                  <span className="absolute left-[3px] top-1.5 h-2 w-2 rounded-full border-2 border-white bg-brand-400 ring-1 ring-brand-200" />
                  <Link className="link font-medium" to={`/inventory/movements/${m.id}`}>{m.number}</Link>
                  <span className="text-slate-700">{m.movement_type_label}</span>
                  <span className="text-xs text-slate-500">{m.warehouse_name}</span>
                  <DateText value={m.date} bs={m.date_bs} className="text-xs text-slate-500" />
                  {m.total_value !== null && <span className="ml-auto tabular-nums text-xs">{formatAmount(m.total_value)}</span>}
                </li>
              ))}
            </ol>
          )}
        </Panel>
        {id && <DocumentTimeline resource="stock-transfers" id={Number(id)} />}
      </div>

      <ConfirmDialog open={dialog === "dispatch"} onOpenChange={(o) => setDialog(o ? "dispatch" : null)} title="Dispatch transfer" confirmLabel="Dispatch"
        loading={action.isPending}
        description={<>Stock leaves {t.source_name} at FIFO cost and is held in the transit warehouse until received at {t.destination_name}. The transfer is numbered on dispatch and can no longer be edited.</>}
        onConfirm={() => action.mutateAsync({ action: "dispatch", success: "Transfer dispatched" }).then(() => { setDialog(null); movements.refetch(); }).catch(() => undefined)} />
      <ConfirmDialog open={dialog === "cancel"} onOpenChange={(o) => setDialog(o ? "cancel" : null)} title="Cancel draft transfer" tone="danger"
        confirmLabel="Cancel transfer" loading={action.isPending} description="The draft is marked cancelled. No stock has moved."
        onConfirm={() => action.mutateAsync({ action: "cancel", success: "Transfer cancelled" }).then(() => setDialog(null)).catch(() => undefined)} />
      <FormDialog<{ date: string }> open={dialog === "receive"} onOpenChange={(o) => setDialog(o ? "receive" : null)} title={`Receive ${t.number}`} size="sm"
        description={`Books the goods into ${t.destination_name} at the cost they left ${t.source_name}.`} submitLabel="Receive goods"
        defaultValues={{ date: todayIn(session?.organization?.timezone) }}
        onSubmit={async (values) => {
          const { data } = await api.post(`/stock-transfers/${t.id}/receive/`, { date: values.date });
          queryClient.setQueryData(["stock-transfers", "detail", String(t.id)], data);
          ["stock-transfers", "stock-movements", "inventory/ledger", "inventory/balances", "products", "dashboard"]
            .forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          toast.success("Transfer received");
        }}>
        <FormGrid columns={1}>
          <FormField name="date" label="Received on" type="date" required min={t.date} hint="Cannot be before the dispatch date." />
        </FormGrid>
      </FormDialog>
    </>
  );
}
