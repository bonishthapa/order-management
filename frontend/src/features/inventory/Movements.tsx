import { BookOpen, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction, useGet, useList } from "@/api/hooks";
import type { Paginated } from "@/api/types";
import { todayIn } from "@/calendar/bs";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { DocumentLines } from "@/components/document/DocumentLines";
import { ReverseAction } from "@/components/document/ReverseAction";
import { DocumentTimeline } from "@/components/document/Timeline";
import { BaseForm, CellDate, CellInput, CellSelect, FormField, FormSection, useFieldArray, useFormContext, useWatch } from "@/components/form";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { BaseTable, DataGrid, ResourceList, col, type TableColumn } from "@/components/table";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
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

/** Rate shown with four decimals (unit costs). */
export const rateColumn = (key: string, header: string, extra: Partial<TableColumn> = {}): TableColumn =>
  col.custom(key, header, (r: any) => (r[key] === null || r[key] === undefined || r[key] === "" ? "–" : formatAmount(r[key], 4)), { align: "right", minWidth: 110, ...extra });

/** Inline error under an editable table cell. */
export function CellError({ message }: { message?: string }) {
  return message ? <p className="mt-0.5 text-xs text-red-600">{message}</p> : null;
}

/** Remove button for editable line tables. */
export function RemoveLineButton({ onClick, label = "Remove line" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

/** Product of line ``index`` in a form with a ``lines`` field array, with its tracking flags. */
export function useLineProduct(index: number) {
  const { control } = useFormContext();
  const productId = useWatch({ control, name: `lines.${index}.product` }) as number | null;
  const product = useDetail<any>("products", productId ?? undefined, { enabled: !!productId, staleTime: 60_000 });
  return { productId, product: product.data };
}

/** Field error of line ``index`` (client or server). */
export function useLineError(index: number, field: string): string | undefined {
  const { formState } = useFormContext();
  return (formState.errors as any).lines?.[index]?.[field]?.message;
}

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
        columns={[
          col.doc("number", "Movement", { sortable: true }),
          col.date("date", "Date", { sortable: true }),
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

const isInbound = (type: ManualType, quantity: string) => type === "OPENING" || (type === "ADJUSTMENT" && toNumber(quantity) >= 0);

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
  const canPost = can("inventory.post");

  if (initial && initial.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={initial.number} back={{ to: `/inventory/movements/${initial.id}`, label: initial.number }} />
        <Alert tone="warning">Only draft movements can be edited. Posted movements are corrected by reversal.</Alert>
      </>
    );
  }

  const defaultValues: MoveValues = initial ? {
    movement_type: initial.movement_type, warehouse: initial.warehouse, date: initial.date, reason: initial.reason ?? "", notes: initial.notes ?? "",
    lines: initial.lines.map((l: any) => ({
      product: l.product, quantity: String(Number(l.quantity)), unit_cost: l.unit_cost ?? "", batch_number: l.batch_number ?? "",
      expiry_date: l.expiry_date ?? "", serials: (l.serial_numbers ?? []).join("\n"), notes: l.notes ?? "",
    })),
  } : { movement_type: "ADJUSTMENT", warehouse: null, date: todayIn(session?.organization?.timezone), reason: "", notes: "", lines: [emptyMoveLine()] };

  return (
    <>
      <PageHeader title={initial ? `Edit draft movement #${initial.id}` : "New stock movement"}
        back={initial ? { to: `/inventory/movements/${initial.id}`, label: "Movement" } : { to: "/inventory/movements", label: "Stock movements" }}
        subtitle="Saved as a draft first. Stock and the inventory journal change only when the movement is posted." />
      <BaseForm<MoveValues> defaultValues={defaultValues} onCancel={() => navigate(-1)}
        submitActions={canPost ? [{ key: "draft", label: "Save draft" }, { key: "post", label: "Save and post", primary: true }]
          : [{ key: "draft", label: "Save draft", primary: true }]}
        onSubmit={async (values, form, intent) => {
          const submitMode = intent === "post" && canPost ? "post" : "draft";
          form.clearErrors("lines");
          let invalid = false;
          const fail = (name: string, message: string) => { form.setError(name as any, { type: "manual", message }); invalid = true; };
          if (!values.lines.length) fail("lines", "Add at least one line.");
          values.lines.forEach((line, i) => {
            const qty = toNumber(line.quantity);
            if (!line.product) fail(`lines.${i}.product`, "Choose a product.");
            if (!line.quantity || qty === 0) fail(`lines.${i}.quantity`, "Enter a non-zero quantity.");
            else if (values.movement_type !== "ADJUSTMENT" && qty < 0) fail(`lines.${i}.quantity`, "Enter a positive quantity.");
            if (values.movement_type === "OPENING" && line.unit_cost === "") fail(`lines.${i}.unit_cost`, "Unit cost is required for opening stock.");
            if (line.unit_cost !== "" && toNumber(line.unit_cost) < 0) fail(`lines.${i}.unit_cost`, "Must not be negative.");
          });
          if (invalid) throw new Error("Correct the highlighted lines.");
          const payload = {
            movement_type: values.movement_type, warehouse: values.warehouse, date: values.date, reason: values.reason.trim(), notes: values.notes,
            lines: values.lines.map((l) => {
              const inbound = isInbound(values.movement_type, l.quantity);
              return {
                product: l.product, quantity: l.quantity, unit_cost: inbound && l.unit_cost !== "" ? l.unit_cost : null,
                batch_number: l.batch_number.trim(), expiry_date: inbound && l.expiry_date ? l.expiry_date : null,
                serial_numbers: parseSerials(l.serials), notes: l.notes,
              };
            }),
          };
          const { data } = initial ? await api.patch(`/stock-movements/${initial.id}/`, payload) : await api.post("/stock-movements/", payload);
          queryClient.invalidateQueries({ queryKey: ["stock-movements"] });
          if (submitMode === "post") {
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
        }}>
        <FormSection title="Movement" columns={4}>
          <FormField name="movement_type" label="Type" type="select" required emptyOption={false}
            options={MANUAL_TYPES.map((t) => ({ value: t, label: movementTypeLabel(t) }))} />
          <FormField name="warehouse" label="Warehouse" type="entity" resource="warehouses" required />
          <FormField name="date" label="Date" type="date" required />
          <FormField name="reason" label="Reason" required placeholder="e.g. Shelf recount, rain damage" />
          <FormField name="notes" label="Notes" type="textarea" rows={2} span={4} />
          <MovementTypeHelp />
        </FormSection>
        <MovementLines />
      </BaseForm>
    </>
  );
}

function MovementTypeHelp() {
  const type = useWatch({ name: "movement_type" }) as ManualType;
  return <Alert tone="info" className="col-span-full">{TYPE_HELP[type]}</Alert>;
}

function MovementLines() {
  const { control, formState } = useFormContext<MoveValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const type = useWatch({ control, name: "movement_type" });
  const warehouse = useWatch({ control, name: "warehouse" });
  const linesError = (formState.errors as any).lines?.message ?? (formState.errors as any).lines?.root?.message;
  const rows = fields.map((f, index) => ({ id: f.id, index }));
  return (
    <Panel title="Lines" actions={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyMoveLine())}>Add line</Button>}>
      {linesError && <Alert tone="error" className="m-4">{linesError}</Alert>}
      <BaseTable rows={rows} rowKey={(r) => r.id} minWidth={980} density="compact" columns={[
        col.custom("n", "#", (r) => <span className="text-xs text-slate-400">{r.index + 1}</span>, { width: 32, className: "pt-3" }),
        col.custom("product", "Product", (r) => <MovementLineProduct index={r.index} warehouse={warehouse} />, { minWidth: 260 }),
        col.custom("quantity", type === "ADJUSTMENT" ? "Quantity (+/−)" : "Quantity", (r) => <MovementLineQuantity index={r.index} type={type} />, { width: 128, align: "right" }),
        col.custom("unit_cost", `Unit cost${type === "OPENING" ? " *" : ""}`, (r) => <MovementLineCost index={r.index} type={type} />, { width: 128, align: "right" }),
        col.custom("batch_number", "Batch", (r) => <MovementLineBatch index={r.index} type={type} warehouse={warehouse} />, { width: 160 }),
        col.custom("expiry_date", "Expiry", (r) => <MovementLineExpiry index={r.index} type={type} />, { width: 176 }),
        col.custom("serials", "Serial numbers", (r) => <LineSerials index={r.index} />, { minWidth: 180 }),
        col.custom("remove", "", (r) => (fields.length > 1 ? <RemoveLineButton onClick={() => remove(r.index)} /> : null), { width: 40 }),
      ]} />
    </Panel>
  );
}

function MovementLineProduct({ index, warehouse }: { index: number; warehouse: number | null }) {
  const { setValue, clearErrors } = useFormContext();
  const { productId, product: p } = useLineProduct(index);
  const error = useLineError(index, "product");
  const balance = useBalance(warehouse, productId);
  return (
    <>
      <EntitySelect resource="products" params={{ product_type: "STOCK", is_active: "true" }} value={productId} invalid={!!error}
        onChange={(v) => { setValue(`lines.${index}.product`, v, { shouldDirty: true }); clearErrors(`lines.${index}.product`); }} />
      <CellError message={error} />
      {productId && warehouse && (
        <p className="mt-0.5 text-2xs text-slate-500">
          {balance.loading ? "Checking stock…" : <>On hand {formatQty(balance.onHand)} {p?.unit_code ?? ""} · available {formatQty(balance.available)}</>}
          {p && (p.track_batches || p.track_serials) && <> · {[p.track_batches && "batch", p.track_expiry && "expiry", p.track_serials && "serial"].filter(Boolean).join(", ")} tracked</>}
        </p>
      )}
    </>
  );
}

function MovementLineQuantity({ index, type }: { index: number; type: ManualType }) {
  const quantity = useWatch({ name: `lines.${index}.quantity` }) as string;
  const qty = toNumber(quantity);
  return (
    <>
      <CellInput number name={`lines.${index}.quantity`} label="Quantity" />
      {type === "ADJUSTMENT" && qty !== 0 && (
        <p className={cn("mt-0.5 text-left text-2xs", qty > 0 ? "text-emerald-700" : "text-red-700")}>{qty > 0 ? "Adds stock" : "Removes stock"}</p>
      )}
    </>
  );
}

function MovementLineCost({ index, type }: { index: number; type: ManualType }) {
  const quantity = useWatch({ name: `lines.${index}.quantity` }) as string;
  const inbound = isInbound(type, quantity);
  return (
    <CellInput number name={`lines.${index}.unit_cost`} label="Unit cost" disabled={!inbound}
      placeholder={inbound ? (type === "OPENING" ? "Required" : "Current average") : "FIFO cost"} />
  );
}

function MovementLineBatch({ index, type, warehouse }: { index: number; type: ManualType; warehouse: number | null }) {
  const quantity = useWatch({ name: `lines.${index}.quantity` }) as string;
  const { productId, product: p } = useLineProduct(index);
  const batches = useBatches(productId, warehouse, !!p?.track_batches);
  if (!p?.track_batches) return <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>;
  const inStock = batches.data?.results ?? [];
  if (!isInbound(type, quantity)) {
    return <BatchSelect name={`lines.${index}.batch_number`} batches={inStock} />;
  }
  return (
    <>
      <CellInput name={`lines.${index}.batch_number`} label="Batch" placeholder="New or existing batch" />
      {inStock.length > 0 && <p className="mt-0.5 text-2xs text-slate-400">In stock: {inStock.map((b: any) => b.batch_number).join(", ")}</p>}
    </>
  );
}

/** Choice of in-stock batches for an issuing line. */
export function BatchSelect({ name, batches }: { name: string; batches: any[] }) {
  return (
    <CellSelect name={name} label="Batch" emptyOption="Choose batch…"
      options={batches.map((b: any) => ({
        value: b.batch_number, label: `${b.batch_number} · ${formatQty(b.quantity)}${b.expiry_date ? ` · exp ${b.expiry_date}` : ""}`,
      }))} />
  );
}

function MovementLineExpiry({ index, type }: { index: number; type: ManualType }) {
  const quantity = useWatch({ name: `lines.${index}.quantity` }) as string;
  const { product: p } = useLineProduct(index);
  if (!(p?.track_expiry && isInbound(type, quantity))) {
    return <span className="block pt-2 text-xs text-slate-400">{p?.track_expiry ? "From batch" : "–"}</span>;
  }
  return <CellDate name={`lines.${index}.expiry_date`} />;
}

/** Serial-number cell for line tables (shown only for serial-tracked products). */
export function LineSerials({ index }: { index: number }) {
  const { product: p } = useLineProduct(index);
  if (!p?.track_serials) return <span className="block pt-2 text-xs text-slate-400">{p ? "Not tracked" : "–"}</span>;
  return <CellInput name={`lines.${index}.serials`} label="Serial numbers" placeholder="Comma separated" />;
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

  const ledgerColumns: TableColumn[] = [
    col.text("sku", "SKU", { minWidth: 120 }),
    col.text("product_name", "Product", { flex: 2, minWidth: 200 }),
    col.text("warehouse_code", "Warehouse", { minWidth: 100 }),
    col.text("batch_number", "Batch", { minWidth: 110 }),
    col.qty("quantity", "Quantity"),
    rateColumn("unit_cost", "Unit cost"),
    col.money("value", "Value"),
    col.qty("balance_quantity", "Balance qty"),
    col.money("balance_value", "Balance value"),
  ];

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
              rateColumn("unit_cost", "Unit cost entered"),
              col.custom("expiry_date", "Expiry", (l: any) => <DateText value={l.expiry_date} />),
              col.custom("notes", "Notes", (l: any) => l.notes || "–"),
            ]} />
          </Panel>
        )}
        {!draft && (
          <Panel title="Ledger entries" actions={<Link className="link text-xs" to={`/inventory/ledger?movement=${m.id}&fiscal_year=all`}>Open in stock ledger</Link>}>
            <DataGrid id="movement-ledger" columns={ledgerColumns} rows={ledger.data?.results} loading={ledger.isLoading} error={ledger.error}
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

