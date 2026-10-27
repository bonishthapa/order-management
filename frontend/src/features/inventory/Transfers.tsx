import { DocumentTimeline } from "@/components/document/Timeline";
import { PackageCheck, Pencil, Plus, Send, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Controller, useFieldArray, useForm, useWatch, type Control, type FieldErrors, type UseFormRegister } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useList } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { DocumentLines } from "@/components/document/DocumentLines";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { NumberInput, Select, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { parseSerials, useBalance, useBatches } from "./Movements";

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
        columns={(ctx) => [
          col.doc("number", "Transfer"),
          col.date("date", "Date", ctx),
          col.text("source_name", "From", { flex: 2, minWidth: 180 }),
          col.text("destination_name", "To", { flex: 2, minWidth: 180 }),
          col.number("line_count", "Lines", { valueGetter: (p: any) => p.data?.lines?.length ?? 0, maxWidth: 100 }),
          col.date("received_date", "Received", ctx),
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
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { control, register, handleSubmit, setError, formState: { errors } } = useForm<TransferValues>({
    defaultValues: initial ? {
      source_warehouse: initial.source_warehouse, destination_warehouse: initial.destination_warehouse, date: initial.date, notes: initial.notes ?? "",
      lines: initial.lines.map((l: any) => ({ product: l.product, quantity: String(Number(l.quantity)), batch_number: l.batch_number ?? "",
        serials: (l.serial_numbers ?? []).join("\n") })),
    } : { source_warehouse: null, destination_warehouse: null, date: todayIn(session?.organization?.timezone), notes: "", lines: [emptyTransferLine()] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const source = useWatch({ control, name: "source_warehouse" });

  if (initial && initial.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={initial.number || `Transfer #${initial.id}`} back={{ to: `/inventory/transfers/${initial.id}`, label: "Transfer" }} />
        <Alert tone="warning">Only draft transfers can be edited.</Alert>
      </>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    let invalid = false;
    if (!values.source_warehouse) { setError("source_warehouse", { message: "Choose the source warehouse." }); invalid = true; }
    if (!values.destination_warehouse) { setError("destination_warehouse", { message: "Choose the destination warehouse." }); invalid = true; }
    if (values.source_warehouse && values.source_warehouse === values.destination_warehouse) {
      setError("destination_warehouse", { message: "Choose a different destination warehouse." }); invalid = true;
    }
    const seen = new Set<number>();
    values.lines.forEach((l, i) => {
      if (!l.product) { setError(`lines.${i}.product`, { message: "Choose a product." }); invalid = true; }
      else if (seen.has(l.product)) { setError(`lines.${i}.product`, { message: "List each product once per transfer." }); invalid = true; }
      if (l.product) seen.add(l.product);
      if (!(toNumber(l.quantity) > 0)) { setError(`lines.${i}.quantity`, { message: "Enter a positive quantity." }); invalid = true; }
    });
    if (!values.lines.length) { setFormError("Add at least one line."); invalid = true; }
    if (invalid) return;
    const payload = {
      source_warehouse: values.source_warehouse, destination_warehouse: values.destination_warehouse, date: values.date, notes: values.notes,
      lines: values.lines.map((l) => ({ product: l.product, quantity: l.quantity, batch_number: l.batch_number, serial_numbers: parseSerials(l.serials) })),
    };
    setSaving(true);
    try {
      const { data } = initial ? await api.patch(`/stock-transfers/${initial.id}/`, payload) : await api.post("/stock-transfers/", payload);
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
      toast.success(initial ? "Transfer updated" : "Draft transfer saved");
      navigate(`/inventory/transfers/${data.id}`);
    } catch (err) {
      Object.entries(fieldErrors(err)).forEach(([k, message]) => setError(k as any, { message }));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  });

  return (
    <>
      <PageHeader title={initial ? `Edit draft transfer #${initial.id}` : "New stock transfer"}
        back={initial ? { to: `/inventory/transfers/${initial.id}`, label: "Transfer" } : { to: "/inventory/transfers", label: "Stock transfers" }}
        subtitle="Saved as a draft. Stock leaves the source warehouse only when the transfer is dispatched." />
      <div className="space-y-4">
        {formError && <Alert tone="error">{formError}</Alert>}
        <Panel title="Transfer">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="From warehouse" required error={errors.source_warehouse?.message}>
              <Controller control={control} name="source_warehouse" render={({ field }) => (
                <EntitySelect resource="warehouses" value={field.value} onChange={(v) => field.onChange(v)} invalid={!!errors.source_warehouse} />
              )} />
            </Field>
            <Field label="To warehouse" required error={errors.destination_warehouse?.message}>
              <Controller control={control} name="destination_warehouse" render={({ field }) => (
                <EntitySelect resource="warehouses" value={field.value} onChange={(v) => field.onChange(v)} invalid={!!errors.destination_warehouse} />
              )} />
            </Field>
            <Field label="Dispatch date" required error={errors.date?.message}>
              <Controller control={control} name="date" render={({ field }) => <DatePicker value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label="Notes"><Textarea rows={1} {...register("notes")} /></Field>
          </div>
        </Panel>
        <Panel title="Items" actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyTransferLine())}>Add line</Button>}>
          {!source && <p className="px-4 pt-3 text-xs text-slate-500">Choose the source warehouse to see available stock.</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-2">#</th>
                  <th className="min-w-[260px] px-2 py-2">Product</th>
                  <th className="w-36 px-2 py-2 text-right">Available at source</th>
                  <th className="w-32 px-2 py-2 text-right">Quantity</th>
                  <th className="w-48 px-2 py-2">Batch</th>
                  <th className="min-w-[180px] px-2 py-2">Serial numbers</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {fields.map((f, index) => (
                  <TransferLineRow key={f.id} index={index} control={control} register={register} errors={errors} source={source}
                    onRemove={fields.length > 1 ? () => remove(index) : undefined} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={onSubmit}>{initial ? "Save changes" : "Save draft"}</Button>
        </div>
      </div>
    </>
  );
}

function TransferLineRow({ index, control, register, errors, source, onRemove }: {
  index: number; control: Control<TransferValues>; register: UseFormRegister<TransferValues>; errors: FieldErrors<TransferValues>;
  source: number | null; onRemove?: () => void;
}) {
  const productId = useWatch({ control, name: `lines.${index}.product` });
  const quantity = useWatch({ control, name: `lines.${index}.quantity` });
  const product = useDetail<any>("products", productId ?? undefined, { enabled: !!productId, staleTime: 60_000 });
  const p = product.data;
  const balance = useBalance(source, productId);
  const batches = useBatches(productId, source, !!p?.track_batches);
  const short = !!productId && !!source && !balance.loading && toNumber(quantity) > toNumber(balance.available);
  const err = (errors.lines?.[index] ?? {}) as any;
  return (
    <tr className="border-b border-line align-top">
      <td className="px-2 py-1.5 pt-3 text-xs text-slate-400">{index + 1}</td>
      <td className="px-2 py-1.5">
        <Controller control={control} name={`lines.${index}.product`} render={({ field }) => (
          <EntitySelect resource="products" params={{ product_type: "STOCK", is_active: "true", warehouse: source ?? "" }} value={field.value}
            onChange={(v) => field.onChange(v)} invalid={!!err.product}
            sublabel={(item) => (source ? `On hand ${formatQty(item.on_hand)} ${item.unit_code}` : item.unit_code)} />
        )} />
        {err.product?.message && <p className="mt-0.5 text-xs text-red-600">{err.product.message}</p>}
      </td>
      <td className="num px-2 py-1.5 pt-2.5">
        {!productId || !source ? <span className="text-slate-400">–</span> : balance.loading ? <span className="text-slate-400">…</span> : (
          <span className={cn(short && "font-medium text-red-700")}>
            {formatQty(balance.available)} <span className="text-2xs text-slate-400">{p?.unit_code}</span>
            {toNumber(balance.reserved) > 0 && <span className="block text-2xs text-slate-400">{formatQty(balance.reserved)} reserved</span>}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <NumberInput {...register(`lines.${index}.quantity`)} invalid={!!err.quantity || short} />
        {err.quantity?.message ? <p className="mt-0.5 text-xs text-red-600">{err.quantity.message}</p>
          : short && <p className="mt-0.5 text-xs text-red-600">More than available.</p>}
      </td>
      <td className="px-2 py-1.5">
        {p?.track_batches ? (
          <Select {...register(`lines.${index}.batch_number`)}>
            <option value="">Choose batch…</option>
            {(batches.data?.results ?? []).map((b: any) => (
              <option key={b.id} value={b.batch_number}>{b.batch_number} · {formatQty(b.quantity)}{b.expiry_date ? ` · exp ${b.expiry_date}` : ""}</option>
            ))}
          </Select>
        ) : <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>}
      </td>
      <td className="px-2 py-1.5">
        {p?.track_serials ? <Textarea rows={2} {...register(`lines.${index}.serials`)} placeholder="One per line or comma separated" />
          : <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>}
      </td>
      <td className="px-2 py-1.5 pt-2">
        {onRemove && (
          <button type="button" aria-label="Remove line" onClick={onRemove} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </td>
    </tr>
  );
}

// --- Detail ----------------------------------------------------------------------------------------

const STEPS = [{ key: "DRAFT", label: "Draft" }, { key: "IN_TRANSIT", label: "In transit" }, { key: "RECEIVED", label: "Received" }];

export function TransferDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const query = useDetail<any>("stock-transfers", id);
  const action = useDocumentAction<any>("stock-transfers", id, ["stock-movements", "inventory/ledger"]);
  const movements = useList<any>("stock-movements", { reference_type: "stock_transfer", reference_id: id, ordering: "created_at", page_size: 50 });
  const [dialog, setDialog] = useState<null | "dispatch" | "receive" | "cancel">(null);
  const [receivedDate, setReceivedDate] = useState(todayIn(session?.organization?.timezone));
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
      <Dialog open={dialog === "receive"} onOpenChange={(o) => setDialog(o ? "receive" : null)} title={`Receive ${t.number}`} size="sm"
        description={`Books the goods into ${t.destination_name} at the cost they left ${t.source_name}.`}
        footer={<>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="primary" loading={action.isPending} disabled={!receivedDate}
            onClick={() => action.mutateAsync({ action: "receive", body: { date: receivedDate }, success: "Transfer received" })
              .then(() => { setDialog(null); movements.refetch(); }).catch(() => undefined)}>Receive goods</Button>
        </>}>
        <Field label="Received on" required hint="Cannot be before the dispatch date.">
          <DatePicker value={receivedDate} onChange={setReceivedDate} min={t.date} />
        </Field>
      </Dialog>
    </>
  );
}
