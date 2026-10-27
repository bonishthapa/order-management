import { DocumentTimeline } from "@/components/document/Timeline";
import { BookOpen, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch, type Control, type FieldErrors, type UseFormRegister } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useGet, useList } from "@/api/hooks";
import type { Paginated } from "@/api/types";
import { todayIn } from "@/calendar/bs";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { DataTable } from "@/components/data/DataTable";
import { ResourceList } from "@/components/data/ResourceList";
import { DocumentLines } from "@/components/document/DocumentLines";
import { ReverseAction } from "@/components/document/ReverseAction";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Shared inventory helpers (also used by Transfers, Counts, Stock and Products) ------------------

export const MOVEMENT_TYPES = [
  { value: "OPENING", label: "Opening stock" }, { value: "RECEIPT", label: "Goods receipt" }, { value: "ISSUE", label: "Sales delivery" },
  { value: "TRANSFER_OUT", label: "Transfer out" }, { value: "TRANSFER_IN", label: "Transfer in" },
  { value: "ADJUSTMENT", label: "Stock adjustment" }, { value: "DAMAGE", label: "Damaged / expired write-off" },
  { value: "SALES_RETURN", label: "Sales return" }, { value: "PURCHASE_RETURN", label: "Purchase return" },
  { value: "COUNT", label: "Stock count reconciliation" }, { value: "REVERSAL", label: "Reversal" },
];

export const MANUAL_TYPES = ["OPENING", "ADJUSTMENT", "DAMAGE"] as const;
type ManualType = (typeof MANUAL_TYPES)[number];

const MOVEMENT_STATUSES = [
  { value: "DRAFT", label: "Draft" }, { value: "POSTED", label: "Posted" }, { value: "REVERSED", label: "Reversed" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** Stock ledger / movement ``reference_type`` → application route. */
const REFERENCE_ROUTES: Record<string, string> = {
  delivery: "/sales/deliveries", sales_invoice: "/sales/invoices", sales_return: "/sales/returns",
  goods_receipt: "/purchases/grns", supplier_bill: "/purchases/bills", purchase_return: "/purchases/returns",
  stock_transfer: "/inventory/transfers", stock_count: "/inventory/counts", stock_movement: "/inventory/movements",
};

export function referenceLink(type: string | null | undefined, id: number | null | undefined): string | null {
  if (!type || !id) return null;
  const base = REFERENCE_ROUTES[type];
  return base ? `${base}/${id}` : null;
}

export function ReferenceText({ type, id, number }: { type?: string | null; id?: number | null; number?: string | null }) {
  if (!number) return <>–</>;
  const to = referenceLink(type, id);
  return to ? <Link className="link" to={to}>{number}</Link> : <>{number}</>;
}

/** Splits serial numbers typed one per line or separated by commas. */
export const parseSerials = (text: string): string[] => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

/** Current on-hand/available stock for one product in one warehouse. */
export function useBalance(warehouse: number | null | undefined, product: number | null | undefined) {
  const query = useGet<Paginated<any>>(["inventory/balances", "line", warehouse, product], "/inventory/balances/",
    { warehouse: warehouse ?? "", product: product ?? "", include_zero: "true" }, !!warehouse && !!product);
  const row = query.data?.results?.[0];
  return { loading: query.isLoading && !!warehouse && !!product, onHand: row?.on_hand ?? "0", available: row?.available ?? "0", reserved: row?.reserved ?? "0", unit: row?.unit };
}

/** Batches of a product that still have stock (optionally in one warehouse). */
export function useBatches(product: number | null | undefined, warehouse: number | null | undefined, enabled: boolean) {
  return useGet<Paginated<any>>(["inventory/batches", product, warehouse], "/inventory/batches/",
    { product: product ?? "", warehouse: warehouse ?? "", in_stock: "true", page_size: 200 }, enabled && !!product);
}

const movementTypeLabel = (t: string) => MOVEMENT_TYPES.find((m) => m.value === t)?.label ?? t;

// --- List ------------------------------------------------------------------------------------------

export function MovementList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Stock movements"
        subtitle="Every change to stock. Opening stock, adjustments and write-offs are entered here; other movements come from their source documents."
        actions={<>
          <Button icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/ledger")}>Stock ledger</Button>
          {can("inventory.manage") && (
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/movements/new")}>New movement</Button>
          )}
        </>} />
      <ResourceList resource="stock-movements" dated searchPlaceholder="Movement no., reason, reference…"
        detailPath={(r) => `/inventory/movements/${r.id}`}
        filters={[
          { type: "select", name: "movement_type", label: "Type", options: MOVEMENT_TYPES },
          { type: "select", name: "status", label: "Status", options: MOVEMENT_STATUSES },
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" },
        ]}
        columns={(ctx) => [
          col.doc("number", "Movement", { sortable: true }),
          col.date("date", "Date", ctx, { sortable: true }),
          col.text("movement_type_label", "Type", { minWidth: 160 }),
          col.text("warehouse_name", "Warehouse", { minWidth: 180 }),
          col.text("reason", "Reason", { flex: 2 }),
          col.text("reference_number", "Reference"),
          col.status("status"),
          col.money("total_value", "Value"),
        ]}
        empty={{ title: "No stock movements", description: "Record opening stock or an adjustment to get started." }} />
    </>
  );
}

// --- Form ------------------------------------------------------------------------------------------

interface MoveLine {
  product: number | null;
  quantity: string;
  unit_cost: string;
  batch_number: string;
  expiry_date: string;
  serials: string;
  notes: string;
}
interface MoveValues {
  movement_type: ManualType;
  warehouse: number | null;
  date: string;
  reason: string;
  notes: string;
  lines: MoveLine[];
}

const emptyMoveLine = (): MoveLine => ({ product: null, quantity: "", unit_cost: "", batch_number: "", expiry_date: "", serials: "", notes: "" });

const TYPE_HELP: Record<ManualType, string> = {
  OPENING: "Stock on hand when you start using the system. Quantities are positive and each line needs its unit cost.",
  ADJUSTMENT: "Corrects stock: enter a positive quantity to add stock (e.g. found items) and a negative quantity (−) to remove it. Unit cost is optional for additions; the current average is used when left blank. Removals are costed FIFO.",
  DAMAGE: "Writes off damaged or expired goods. Enter the quantity removed as a positive number; it is costed FIFO and charged to the write-off account.",
};

export function MovementForm() {
  const { id } = useParams();
  const editing = !!id;
  const query = useDetail<any>("stock-movements", id);
  if (editing && query.isLoading) return <LoadingBlock />;
  if (editing && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <MovementFormBody initial={query.data} />;
}

function MovementFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, can } = useAuth();
  const [saving, setSaving] = useState<null | "draft" | "post">(null);
  const [formError, setFormError] = useState<string | null>(null);
  const { control, register, handleSubmit, setError, formState: { errors } } = useForm<MoveValues>({
    defaultValues: initial ? {
      movement_type: initial.movement_type, warehouse: initial.warehouse, date: initial.date, reason: initial.reason ?? "", notes: initial.notes ?? "",
      lines: initial.lines.map((l: any) => ({
        product: l.product, quantity: String(Number(l.quantity)), unit_cost: l.unit_cost ?? "", batch_number: l.batch_number ?? "",
        expiry_date: l.expiry_date ?? "", serials: (l.serial_numbers ?? []).join("\n"), notes: l.notes ?? "",
      })),
    } : {
      movement_type: "ADJUSTMENT", warehouse: null, date: todayIn(session?.organization?.timezone), reason: "", notes: "", lines: [emptyMoveLine()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const type = useWatch({ control, name: "movement_type" });
  const warehouse = useWatch({ control, name: "warehouse" });

  if (initial && initial.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={initial.number} back={{ to: `/inventory/movements/${initial.id}`, label: initial.number }} />
        <Alert tone="warning">Only draft movements can be edited. Posted movements are corrected by reversal.</Alert>
      </>
    );
  }

  const submit = (mode: "draft" | "post") => handleSubmit(async (values) => {
    setFormError(null);
    let invalid = false;
    if (!values.warehouse) { setError("warehouse", { message: "Choose the warehouse." }); invalid = true; }
    if (!values.reason.trim()) { setError("reason", { message: "Give a reason for the movement." }); invalid = true; }
    if (!values.lines.length) { setFormError("Add at least one line."); invalid = true; }
    values.lines.forEach((line, i) => {
      const qty = toNumber(line.quantity);
      if (!line.product) { setError(`lines.${i}.product`, { message: "Choose a product." }); invalid = true; }
      if (!line.quantity || qty === 0) { setError(`lines.${i}.quantity`, { message: "Enter a non-zero quantity." }); invalid = true; }
      else if (values.movement_type !== "ADJUSTMENT" && qty < 0) {
        setError(`lines.${i}.quantity`, { message: "Enter a positive quantity." }); invalid = true;
      }
      if (values.movement_type === "OPENING" && line.unit_cost === "") { setError(`lines.${i}.unit_cost`, { message: "Unit cost is required for opening stock." }); invalid = true; }
      if (line.unit_cost !== "" && toNumber(line.unit_cost) < 0) { setError(`lines.${i}.unit_cost`, { message: "Must not be negative." }); invalid = true; }
    });
    if (invalid) return;
    const inbound = (line: MoveLine) => values.movement_type === "OPENING" || (values.movement_type === "ADJUSTMENT" && toNumber(line.quantity) > 0);
    const payload = {
      movement_type: values.movement_type, warehouse: values.warehouse, date: values.date, reason: values.reason.trim(), notes: values.notes,
      lines: values.lines.map((l) => ({
        product: l.product, quantity: l.quantity, unit_cost: inbound(l) && l.unit_cost !== "" ? l.unit_cost : null,
        batch_number: l.batch_number.trim(), expiry_date: inbound(l) && l.expiry_date ? l.expiry_date : null,
        serial_numbers: parseSerials(l.serials), notes: l.notes,
      })),
    };
    setSaving(mode);
    try {
      const { data } = initial ? await api.patch(`/stock-movements/${initial.id}/`, payload) : await api.post("/stock-movements/", payload);
      queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
      if (mode === "post") {
        try {
          await api.post(`/stock-movements/${data.id}/post/`);
          ["stock-movements", "inventory/balances", "inventory/ledger", "products", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          toast.success("Movement posted");
        } catch (e) {
          toast.error(`Saved as draft but not posted: ${errorMessage(e)}`);
        }
      } else {
        toast.success(initial ? "Draft updated" : "Draft movement saved");
      }
      navigate(`/inventory/movements/${data.id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      Object.entries(fe).forEach(([k, message]) => setError(k as any, { message }));
      setFormError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  });

  return (
    <>
      <PageHeader title={initial ? `Edit draft movement #${initial.id}` : "New stock movement"}
        back={initial ? { to: `/inventory/movements/${initial.id}`, label: "Movement" } : { to: "/inventory/movements", label: "Stock movements" }}
        subtitle="Saved as a draft first. Stock and the inventory journal change only when the movement is posted." />
      <div className="space-y-4">
        {formError && <Alert tone="error">{formError}</Alert>}
        <Panel title="Movement">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Type" required>
              <Select {...register("movement_type")}>
                {MANUAL_TYPES.map((t) => <option key={t} value={t}>{movementTypeLabel(t)}</option>)}
              </Select>
            </Field>
            <Field label="Warehouse" required error={errors.warehouse?.message}>
              <Controller control={control} name="warehouse" render={({ field }) => (
                <EntitySelect resource="warehouses" value={field.value} onChange={(v) => field.onChange(v)} invalid={!!errors.warehouse} />
              )} />
            </Field>
            <Field label="Date" required error={errors.date?.message}>
              <Controller control={control} name="date" render={({ field }) => (
                <DatePicker value={field.value} onChange={field.onChange} invalid={!!errors.date} />
              )} />
            </Field>
            <Field label="Reason" required error={errors.reason?.message}>
              <Input {...register("reason")} invalid={!!errors.reason} placeholder="e.g. Shelf recount, rain damage" />
            </Field>
            <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><Textarea rows={2} {...register("notes")} /></Field>
          </div>
          <Alert tone="info" className="mx-4 mb-4">{TYPE_HELP[type]}</Alert>
        </Panel>
        <Panel title="Lines" actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyMoveLine())}>Add line</Button>}>
          {errors.lines?.message && <Alert tone="error" className="m-4">{errors.lines.message}</Alert>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-2">#</th>
                  <th className="min-w-[260px] px-2 py-2">Product</th>
                  <th className="w-32 px-2 py-2 text-right">{type === "ADJUSTMENT" ? "Quantity (+/−)" : "Quantity"}</th>
                  <th className="w-32 px-2 py-2 text-right">Unit cost{type === "OPENING" ? " *" : ""}</th>
                  <th className="w-40 px-2 py-2">Batch</th>
                  <th className="w-44 px-2 py-2">Expiry</th>
                  <th className="min-w-[180px] px-2 py-2">Serial numbers</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {fields.map((f, index) => (
                  <MovementLineRow key={f.id} index={index} control={control} register={register} errors={errors} type={type} warehouse={warehouse}
                    onRemove={fields.length > 1 ? () => remove(index) : undefined} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant={can("inventory.post") ? "secondary" : "primary"} loading={saving === "draft"} disabled={!!saving}
            onClick={submit("draft")}>Save draft</Button>
          {can("inventory.post") && (
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={saving === "post"} disabled={!!saving}
              onClick={submit("post")}>Save and post</Button>
          )}
        </div>
      </div>
    </>
  );
}

function MovementLineRow({ index, control, register, errors, type, warehouse, onRemove }: {
  index: number; control: Control<MoveValues>; register: UseFormRegister<MoveValues>; errors: FieldErrors<MoveValues>; type: ManualType;
  warehouse: number | null; onRemove?: () => void;
}) {
  const productId = useWatch({ control, name: `lines.${index}.product` });
  const quantity = useWatch({ control, name: `lines.${index}.quantity` });
  const product = useDetail<any>("products", productId ?? undefined, { enabled: !!productId, staleTime: 60_000 });
  const p = product.data;
  const balance = useBalance(warehouse, productId);
  const qty = toNumber(quantity);
  const inbound = type === "OPENING" || (type === "ADJUSTMENT" && qty >= 0);
  const batches = useBatches(productId, warehouse, !!p?.track_batches);
  const err = (errors.lines?.[index] ?? {}) as any;
  const listId = `mv-batches-${index}`;
  return (
    <tr className="border-b border-line align-top">
      <td className="px-2 py-1.5 pt-3 text-xs text-slate-400">{index + 1}</td>
      <td className="px-2 py-1.5">
        <Controller control={control} name={`lines.${index}.product`} render={({ field }) => (
          <EntitySelect resource="products" params={{ product_type: "STOCK", is_active: "true" }} value={field.value}
            onChange={(v) => field.onChange(v)} invalid={!!err.product} />
        )} />
        {err.product?.message && <p className="mt-0.5 text-xs text-red-600">{err.product.message}</p>}
        {productId && warehouse && (
          <p className="mt-0.5 text-2xs text-slate-500">
            {balance.loading ? "Checking stock…" : <>On hand {formatQty(balance.onHand)} {p?.unit_code ?? ""} · available {formatQty(balance.available)}</>}
            {p && (p.track_batches || p.track_serials) && <> · {[p.track_batches && "batch", p.track_expiry && "expiry", p.track_serials && "serial"].filter(Boolean).join(", ")} tracked</>}
          </p>
        )}
      </td>
      <td className="px-2 py-1.5">
        <NumberInput {...register(`lines.${index}.quantity`)} invalid={!!err.quantity} />
        {err.quantity?.message && <p className="mt-0.5 text-xs text-red-600">{err.quantity.message}</p>}
        {type === "ADJUSTMENT" && qty !== 0 && (
          <p className={cn("mt-0.5 text-2xs", qty > 0 ? "text-emerald-700" : "text-red-700")}>{qty > 0 ? "Adds stock" : "Removes stock"}</p>
        )}
      </td>
      <td className="px-2 py-1.5">
        <NumberInput {...register(`lines.${index}.unit_cost`)} disabled={!inbound} invalid={!!err.unit_cost}
          placeholder={inbound ? (type === "OPENING" ? "Required" : "Current average") : "FIFO cost"} />
        {err.unit_cost?.message && <p className="mt-0.5 text-xs text-red-600">{err.unit_cost.message}</p>}
      </td>
      <td className="px-2 py-1.5">
        {p?.track_batches ? (
          <>
            <Input list={listId} {...register(`lines.${index}.batch_number`)} invalid={!!err.batch_number}
              placeholder={inbound ? "New or existing batch" : "Batch to issue"} />
            <datalist id={listId}>
              {(batches.data?.results ?? []).map((b: any) => (
                <option key={b.id} value={b.batch_number}>{`${formatQty(b.quantity)} in stock${b.expiry_date ? ` · exp ${b.expiry_date}` : ""}`}</option>
              ))}
            </datalist>
          </>
        ) : <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>}
      </td>
      <td className="px-2 py-1.5">
        {p?.track_expiry && inbound ? (
          <Controller control={control} name={`lines.${index}.expiry_date`} render={({ field }) => (
            <DatePicker compact value={field.value} onChange={field.onChange} />
          )} />
        ) : <span className="block pt-2 text-xs text-slate-400">{p?.track_expiry ? "From batch" : "–"}</span>}
      </td>
      <td className="px-2 py-1.5">
        {p?.track_serials ? (
          <Textarea rows={2} {...register(`lines.${index}.serials`)} placeholder="One per line or comma separated" />
        ) : <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>}
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

export function MovementDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDetail<any>("stock-movements", id);
  const action = useDocumentAction<any>("stock-movements", id, ["inventory/ledger"]);
  const [dialog, setDialog] = useState<null | "post" | "delete">(null);
  const [deleting, setDeleting] = useState(false);
  const m = query.data;
  const ledger = useList<any>("inventory/ledger", { movement: id, page_size: 500, ordering: "id" }, { enabled: !!m && m.status !== "DRAFT" });

  const ledgerColumns = useMemo(() => [
    col.text("sku", "SKU", { maxWidth: 140 }),
    col.text("product_name", "Product", { flex: 2, minWidth: 200 }),
    col.text("warehouse_code", "Warehouse", { maxWidth: 120 }),
    col.text("batch_number", "Batch", { maxWidth: 140 }),
    col.qty("quantity", "Quantity"),
    col.money("unit_cost", "Unit cost", { valueFormatter: (p: any) => formatAmount(p.value, 4) }),
    col.money("value", "Value"),
    col.qty("balance_quantity", "Balance qty"),
    col.money("balance_value", "Balance value"),
  ], []);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !m) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const manual = (MANUAL_TYPES as readonly string[]).includes(m.movement_type);
  const draft = m.status === "DRAFT";

  const deleteDraft = async () => {
    setDeleting(true);
    try {
      await api.delete(`/stock-movements/${m.id}/`);
      toast.success("Draft deleted");
      navigate("/inventory/movements");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader back={{ to: "/inventory/movements", label: "Stock movements" }} title={m.number || `Draft movement #${m.id}`}
        meta={<><StatusBadge status={m.status} /><Badge tone="slate">{m.movement_type_label}</Badge></>}
        subtitle={<>{m.warehouse_name} · <DateText value={m.date} bs={m.date_bs} /></>}
        actions={<>
          {draft && manual && can("inventory.manage") && (
            <>
              <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/inventory/movements/${m.id}/edit`)}>Edit</Button>
              <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDialog("delete")}>Delete draft</Button>
            </>
          )}
          {draft && manual && can("inventory.post") && (
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setDialog("post")}>Post movement</Button>
          )}
          {m.status === "POSTED" && manual && can(["inventory.post", "accounting.reverse"]) && (
            <ReverseAction title={`Reverse ${m.number}`} loading={action.isPending}
              description="An opposite movement is posted at the original costs and the inventory journal is reversed. Stock that has since been issued cannot be reversed."
              onReverse={async (reason) => {
                const reversal = await action.mutateAsync({ action: "reverse", body: { reason }, success: "Movement reversed" });
                query.refetch();
                if (reversal?.id && String(reversal.id) !== String(m.id)) navigate(`/inventory/movements/${reversal.id}`);
              }} />
          )}
        </>} />

      {draft && <Alert tone="info" className="mb-4">This movement has not been posted. Stock and accounts have not changed yet.</Alert>}
      {m.reversed_by && (
        <Alert tone="warning" className="mb-4" title="Reversed">
          Reversed by <Link className="link" to={`/inventory/movements/${m.reversed_by.id}`}>{m.reversed_by.number}</Link>.
        </Alert>
      )}
      {m.reversal_of && (
        <Alert tone="info" className="mb-4">
          This movement reverses <Link className="link" to={`/inventory/movements/${m.reversal_of}`}>{m.reversal_of_number ?? `#${m.reversal_of}`}</Link>.
        </Alert>
      )}

      <div className="space-y-4">
        <Panel title="Movement">
          <KeyValues items={[
            { label: "Type", value: m.movement_type_label },
            { label: "Date", value: <DateText value={m.date} bs={m.date_bs} /> },
            { label: "Warehouse", value: m.warehouse_name },
            { label: "Status", value: <StatusBadge status={m.status} /> },
            { label: "Reason", value: m.reason || "–", wide: true },
            { label: "Source document", value: <ReferenceText type={m.reference_type} id={m.reference_id} number={m.reference_number} /> },
            { label: "Value", value: m.total_value === null || m.total_value === undefined ? (draft ? "Calculated on posting" : "–") : formatAmount(m.total_value) },
            { label: "Created by", value: m.created_by_name ?? "–" },
            { label: "Posted by", value: m.posted_by_name ? `${m.posted_by_name} · ${formatDateTime(m.posted_at)}` : "–" },
            { label: "Journal", value: m.journal ? <Link className="link" to={`/finance/journals/${m.journal}`}>{m.journal_number ?? "View journal"}</Link> : "–" },
            ...(m.notes ? [{ label: "Notes", value: <span className="whitespace-pre-line">{m.notes}</span>, wide: true }] : []),
          ]} />
        </Panel>
        {m.lines.length > 0 && (
          <Panel title="Lines">
            <DocumentLines showPricing={false} lines={m.lines} extra={[
              { key: "unit_cost", label: "Unit cost entered", align: "right", render: (l) => (l.unit_cost === null ? "–" : formatAmount(l.unit_cost, 4)) },
              { key: "expiry_date", label: "Expiry", render: (l) => <DateText value={l.expiry_date} /> },
              { key: "notes", label: "Notes", render: (l) => l.notes || "–" },
            ]} />
          </Panel>
        )}
        {!draft && (
          <Panel title="Ledger entries" actions={<Link className="link text-xs" to={`/inventory/ledger?movement=${m.id}&fiscal_year=all`}>Open in stock ledger</Link>}>
            <DataTable id="movement-ledger" columns={ledgerColumns} rows={ledger.data?.results} loading={ledger.isLoading} error={ledger.error}
              onRetry={() => ledger.refetch()} empty={{ title: "No ledger entries", description: "Nothing was posted for this movement." }}
              onRowClick={(r: any) => navigate(`/inventory/products/${r.product}`)} />
          </Panel>
        )}
        {id && <DocumentTimeline resource="stock-movements" id={Number(id)} />}
      </div>

      <ConfirmDialog open={dialog === "post"} onOpenChange={(o) => setDialog(o ? "post" : null)} title={`Post ${m.movement_type_label.toLowerCase()}`}
        confirmLabel="Post movement" loading={action.isPending}
        description={<>
          <p>Stock at {m.warehouse_name} is updated on <DateText value={m.date} bs={m.date_bs} /> and the inventory journal is posted.</p>
          <p className="mt-2">Posted movements cannot be edited; mistakes are corrected by reversal.</p>
        </>}
        onConfirm={() => action.mutateAsync({ action: "post", success: "Movement posted" }).then(() => setDialog(null)).catch(() => undefined)} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => setDialog(o ? "delete" : null)} title="Delete draft movement" tone="danger"
        confirmLabel="Delete draft" loading={deleting} description="The draft is removed. Nothing has been posted, so stock is not affected."
        onConfirm={deleteDraft} />
    </>
  );
}

