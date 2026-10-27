import { ClipboardList, Plus, Save, Send, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useDocumentAction, useOptions } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { DocumentTimeline } from "@/components/document/Timeline";
import { BaseForm, CellInput, FormDialog, FormField, FormGrid, FormSection, useFormContext, useWatch } from "@/components/form";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { BaseTable, ResourceList, col, type TableColumn } from "@/components/table";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Input } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatDateTime, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { RemoveLineButton } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
const COUNT_STATUSES = [{ value: "DRAFT", label: "Counting" }, { value: "POSTED", label: "Posted" }, { value: "CANCELLED", label: "Cancelled" }];
const countStatusLabel = (s: string) => COUNT_STATUSES.find((c) => c.value === s)?.label ?? s;

export function CountList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Stock counts" subtitle="Physical counts. Posting adjusts stock to the counted quantities and records the difference."
        actions={can("inventory.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/counts/new")}>New count</Button>
        )} />
      <ResourceList resource="stock-counts" dated searchPlaceholder="Count no., notes…" detailPath={(r) => `/inventory/counts/${r.id}`}
        filters={[
          { type: "select", name: "status", label: "Status", options: COUNT_STATUSES },
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" },
        ]}
        columns={[
          col.doc("number", "Count"),
          col.date("date", "Date"),
          col.text("warehouse_name", "Warehouse", { flex: 2, minWidth: 180 }),
          col.custom("progress", "Counted", (r: any) => `${r.counted_count} of ${r.line_count}`, { align: "right", width: 130 }),
          col.text("notes", "Notes", { flex: 2 }),
          col.text("posted_by_name", "Posted by"),
          col.custom("status", "Status", (r: any) => <StatusBadge status={r.status} label={countStatusLabel(r.status)} />, { minWidth: 120 }),
        ]}
        empty={{ title: "No stock counts", description: "Start a count to reconcile physical stock with the system." }} />
    </>
  );
}

interface NewCountValues { warehouse: number | null; date: string; notes: string; populate: boolean }

export function CountForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return (
    <>
      <PageHeader title="New stock count" back={{ to: "/inventory/counts", label: "Stock counts" }}
        subtitle="Start a count sheet, record what is physically on the shelves, then post to adjust stock." />
      <BaseForm<NewCountValues> defaultValues={{ warehouse: null, date: todayIn(session?.organization?.timezone), notes: "", populate: true }}
        submitLabel="Start count" onCancel={() => navigate(-1)}
        onSubmit={async (values) => {
          const { data } = await api.post("/stock-counts/", { warehouse: values.warehouse, date: values.date, notes: values.notes });
          if (values.populate) {
            try { await api.post(`/stock-counts/${data.id}/populate/`, {}); }
            catch (err) { toast.error(`Count created, but products were not added: ${errorMessage(err)}`); }
          }
          queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
          toast.success("Stock count started");
          navigate(`/inventory/counts/${data.id}`);
        }}>
        <FormSection title="Count" columns={3}>
          <FormField name="warehouse" label="Warehouse" type="entity" resource="warehouses" required />
          <FormField name="date" label="Count date" type="date" required hint="Adjustments are posted on this date." />
          <FormField name="notes" label="Notes" placeholder="e.g. Quarterly count, aisle A–C" />
          <FormField name="populate" label="Products" type="checkbox" span={3}
            hint="Add every product currently in stock at this warehouse to the count sheet" />
        </FormSection>
      </BaseForm>
    </>
  );
}

interface SheetLine { product: number; counted_quantity: string; notes: string }
interface SheetValues { lines: SheetLine[] }
interface FormHandle { getValues: () => SheetValues }

const toPayload = (lines: SheetLine[]) => lines.map((l) => ({
  product: l.product, counted_quantity: l.counted_quantity === "" ? null : l.counted_quantity, notes: l.notes,
}));

export function CountDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useDetail<any>("stock-counts", id);
  const action = useDocumentAction<any>("stock-counts", id, ["stock-movements", "inventory/ledger"]);
  const categories = useOptions<any>("product-categories");
  const formRef = useRef<FormHandle | null>(null);
  const [sheetState, setSheetState] = useState<SheetState>({ dirty: false, submitting: false, counted: null, differences: null });
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [uncountedOnly, setUncountedOnly] = useState(false);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [newProduct, setNewProduct] = useState<number | null>(null);
  const [dialog, setDialog] = useState<null | "post" | "cancel" | "populate">(null);
  const c = query.data;
  const formId = `count-sheet-${id}`;

  // The sheet form is re-created whenever the saved lines change so its "unsaved" state is measured from the server copy.
  const sheetKey = useMemo(() => (c ? JSON.stringify(c.lines.map((l: any) => [l.id, l.counted_quantity, l.notes])) : ""), [c]);
  const defaults = useMemo<SheetValues>(() => ({
    lines: (c?.lines ?? []).map((l: any) => ({
      product: l.product, counted_quantity: l.counted_quantity === null ? "" : String(Number(l.counted_quantity)), notes: l.notes ?? "",
    })),
  }), [sheetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !c) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const editable = c.status === "DRAFT" && can("inventory.manage");
  const dirty = editable && sheetState.dirty;
  const currentLines = (): SheetLine[] => formRef.current?.getValues().lines ?? defaults.lines;

  const storeCount = (data: any) => {
    queryClient.setQueryData(["stock-counts", "detail", String(c.id)], data);
    queryClient.invalidateQueries({ queryKey: ["stock-counts", "list"] });
  };

  /** PATCHes the complete set of lines (the API replaces the sheet). Throws on failure. */
  const saveLines = async (lines: ReturnType<typeof toPayload>) => {
    for (const l of lines) {
      if (l.counted_quantity !== null && (Number.isNaN(Number(l.counted_quantity)) || Number(l.counted_quantity) < 0)) {
        throw new Error("Counted quantities must be zero or more.");
      }
    }
    const { data } = await api.patch(`/stock-counts/${c.id}/`, { lines });
    storeCount(data);
    return data;
  };

  /** Saves unsaved counts before another action; returns false (with a message) if that failed. */
  const saveIfDirty = async () => {
    if (!dirty) return true;
    try { await saveLines(toPayload(currentLines())); return true; }
    catch (e) { toast.error(errorMessage(e)); return false; }
  };

  const runSave = async (lines: ReturnType<typeof toPayload>, message: string) => {
    setSaving(true);
    try { await saveLines(lines); toast.success(message); return true; }
    catch (e) { toast.error(errorMessage(e)); return false; }
    finally { setSaving(false); }
  };

  const addProduct = async () => {
    if (!newProduct) return;
    if (c.lines.some((l: any) => l.product === newProduct)) { toast.error("This product is already on the count sheet."); return; }
    if (await runSave([...toPayload(currentLines()), { product: newProduct, counted_quantity: null, notes: "" }], "Product added")) setNewProduct(null);
  };

  const removeLine = (product: number) => runSave(toPayload(currentLines().filter((l) => l.product !== product)), "Line removed");

  const post = async () => {
    setSaving(true);
    const ok = await saveIfDirty();
    setSaving(false);
    if (!ok) return;
    try {
      await action.mutateAsync({ action: "post", success: "Stock count posted" });
      setDialog(null);
    } catch { /* toast shown by the action */ }
  };

  const sheetLines: SheetLine[] = editable ? defaults.lines : [];
  const countedCount = (editable ? sheetLines.map((l) => l.counted_quantity !== "") : c.lines.map((l: any) => l.counted_quantity !== null)).filter(Boolean).length;

  return (
    <>
      <PageHeader back={{ to: "/inventory/counts", label: "Stock counts" }} title={c.number || `Stock count #${c.id}`}
        meta={<StatusBadge status={c.status} label={countStatusLabel(c.status)} />}
        subtitle={<>{c.warehouse_name} · <DateText value={c.date} bs={c.date_bs} /></>}
        actions={<>
          {editable && <Button icon={<ClipboardList className="h-3.5 w-3.5" />} onClick={() => setDialog("populate")}>Add products from stock</Button>}
          {editable && <Button variant="danger" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("cancel")}>Cancel count</Button>}
          {editable && c.lines.length > 0 && (
            <Button type="submit" form={formId} icon={<Save className="h-3.5 w-3.5" />} loading={sheetState.submitting} disabled={!dirty}>Save counts</Button>
          )}
          {c.status === "DRAFT" && can("inventory.post") && (
            <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} disabled={!c.lines.length} onClick={() => setDialog("post")}>Post count</Button>
          )}
        </>} />

      {c.status === "CANCELLED" && <Alert tone="info" className="mb-4">This count was cancelled. Stock was not adjusted.</Alert>}
      {c.status === "POSTED" && (
        <Alert tone="success" className="mb-4">
          Posted {c.posted_by_name ? `by ${c.posted_by_name}` : ""} {c.posted_at ? `on ${formatDateTime(c.posted_at)}` : ""}.{" "}
          {c.adjustment_movement ? <Link className="link" to={`/inventory/movements/${c.adjustment_movement}`}>View the adjustment movement</Link>
            : "Counted quantities matched the system, so no adjustment was needed."}
        </Alert>
      )}

      <div className="space-y-4">
        <Panel title="Count">
          <KeyValues items={[
            { label: "Warehouse", value: c.warehouse_name },
            { label: "Date", value: <DateText value={c.date} bs={c.date_bs} /> },
            { label: "Lines counted", value: `${editable && sheetState.counted !== null ? sheetState.counted : c.counted_count} of ${c.line_count}` },
            { label: "Lines with a difference", value: String(editable && sheetState.differences !== null ? sheetState.differences
              : c.lines.filter((l: any) => l.difference !== null && Number(l.difference) !== 0).length) },
            ...(c.notes ? [{ label: "Notes", value: c.notes, wide: true }] : []),
          ]} />
        </Panel>

        <Panel title="Count sheet" actions={dirty ? <span className="text-xs text-amber-700">Unsaved changes</span> : undefined}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
            <Input className="w-full sm:w-64" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by SKU or name…" aria-label="Filter lines" />
            <label className="flex h-8 items-center gap-1.5 rounded border border-line-strong bg-white px-2.5 text-[13px] text-slate-700">
              <input type="checkbox" className="accent-brand-600" checked={uncountedOnly} onChange={(e) => setUncountedOnly(e.target.checked)} /> Not yet counted
            </label>
            <label className="flex h-8 items-center gap-1.5 rounded border border-line-strong bg-white px-2.5 text-[13px] text-slate-700">
              <input type="checkbox" className="accent-brand-600" checked={differencesOnly} onChange={(e) => setDifferencesOnly(e.target.checked)} /> With difference
            </label>
            {editable && (
              <div className="ml-auto flex items-center gap-2">
                <div className="w-72">
                  <EntitySelect resource="products" params={{ product_type: "STOCK", is_active: "true" }} value={newProduct}
                    onChange={(v) => setNewProduct(v)} placeholder="Add a product to the sheet…" />
                </div>
                <Button icon={<Plus className="h-3.5 w-3.5" />} disabled={!newProduct} loading={saving && !!newProduct} onClick={addProduct}>Add line</Button>
              </div>
            )}
          </div>
          {c.lines.length === 0 ? (
            <EmptyState title="The count sheet is empty" description={editable ? "Add the products in stock at this warehouse, or add products one at a time." : undefined}
              action={editable ? <Button onClick={() => setDialog("populate")}>Add products from stock</Button> : undefined} />
          ) : editable ? (
            <BaseForm<SheetValues> key={sheetKey} id={formId} actions="none" warnUnsaved defaultValues={defaults}
              formRef={(f) => { formRef.current = f; }}
              onSubmit={async (values, form) => {
                let invalid = false;
                values.lines.forEach((l, i) => {
                  if (l.counted_quantity !== "" && (Number.isNaN(Number(l.counted_quantity)) || Number(l.counted_quantity) < 0)) {
                    form.setError(`lines.${i}.counted_quantity`, { type: "manual", message: "Enter zero or more." });
                    invalid = true;
                  }
                });
                if (invalid) throw new Error("Counted quantities must be zero or more.");
                await saveLines(toPayload(values.lines));
                toast.success("Counts saved");
              }}>
              <SheetStateReporter lines={c.lines} onChange={setSheetState} />
              <EditableSheet lines={c.lines} filter={filter} uncountedOnly={uncountedOnly} differencesOnly={differencesOnly}
                onRemove={removeLine} removing={saving} />
            </BaseForm>
          ) : (
            <ReadOnlySheet lines={c.lines} filter={filter} uncountedOnly={uncountedOnly} differencesOnly={differencesOnly} />
          )}
          {c.status === "DRAFT" && c.lines.length > 0 && (
            <p className="border-t border-line px-4 py-2 text-xs text-slate-500">
              System quantity is the stock when the line was added. Differences shown here are a preview; posting uses the stock on hand at that moment.
            </p>
          )}
        </Panel>
        {id && <DocumentTimeline resource="stock-counts" id={Number(id)} />}
      </div>

      <ConfirmDialog open={dialog === "post"} onOpenChange={(o) => setDialog(o ? "post" : null)} title="Post stock count" confirmLabel="Post count"
        loading={action.isPending || saving}
        description={<PostDescription count={c} countedCount={editable ? countFromForm(formRef.current, countedCount) : countedCount} dirty={dirty} />}
        onConfirm={() => {
          const counted = editable ? countFromForm(formRef.current, countedCount) : countedCount;
          if (counted < c.lines.length) { setDialog(null); setUncountedOnly(true); return; }
          return post();
        }} />
      <ConfirmDialog open={dialog === "cancel"} onOpenChange={(o) => setDialog(o ? "cancel" : null)} title="Cancel stock count" tone="danger"
        confirmLabel="Cancel count" loading={action.isPending} description="The count is closed without adjusting stock. This cannot be undone."
        onConfirm={() => action.mutateAsync({ action: "cancel", success: "Stock count cancelled" }).then(() => setDialog(null)).catch(() => undefined)} />
      <FormDialog<{ category: number | null }> open={dialog === "populate"} onOpenChange={(o) => setDialog(o ? "populate" : null)}
        title="Add products from stock" size="sm" submitLabel="Add products" defaultValues={{ category: null }}
        description={`Adds every product with stock at ${c.warehouse_name} that is not already on the sheet.`}
        onSubmit={async (values) => {
          if (dirty) await saveLines(toPayload(currentLines()));
          const { data } = await api.post(`/stock-counts/${c.id}/populate/`, values.category ? { category: values.category } : {});
          storeCount(data);
          toast.success("Products added");
        }}>
        <FormGrid columns={1}>
          <FormField name="category" label="Category" type="select" emptyOption="All categories" hint="Leave blank to add all categories."
            options={(categories.data ?? []).map((cat: any) => ({ value: cat.id, label: cat.name }))} />
        </FormGrid>
      </FormDialog>
    </>
  );
}

const countFromForm = (form: FormHandle | null, fallback: number) =>
  form ? form.getValues().lines.filter((l) => l.counted_quantity !== "").length : fallback;

function PostDescription({ count: c, countedCount, dirty }: { count: any; countedCount: number; dirty: boolean }) {
  if (countedCount < c.lines.length) {
    return <Alert tone="error">{c.lines.length - countedCount} line(s) have no counted quantity. Enter a count (0 if none was found) or remove the line before posting.</Alert>;
  }
  return (
    <>
      <p>For each line, the adjustment posted is <strong>counted quantity − stock on hand at the time of posting</strong> in {c.warehouse_name}, dated <DateText value={c.date} bs={c.date_bs} />.</p>
      <p className="mt-2">If stock moved since a line was added, the adjustment differs from the preview. Shortages are costed FIFO; surpluses use the current average cost. The count cannot be edited after posting.</p>
      {dirty && <p className="mt-2 text-amber-700">Unsaved counts are saved first.</p>}
    </>
  );
}

interface SheetState { dirty: boolean; submitting: boolean; counted: number | null; differences: number | null }

/** Reports the sheet form's live state (unsaved, submitting, counted lines, differences) to the page. */
function SheetStateReporter({ lines, onChange }: { lines: any[]; onChange: (s: SheetState) => void }) {
  const { formState } = useFormContext();
  const values = (useWatch({ name: "lines" }) ?? []) as SheetLine[];
  const dirty = formState.isDirty && !formState.isSubmitSuccessful;
  const submitting = formState.isSubmitting;
  const counted = values.filter((v) => v?.counted_quantity !== "").length;
  const differences = values.filter((v, i) => {
    const diff = difference(v?.counted_quantity ?? "", lines[i]?.system_quantity);
    return diff !== null && diff !== 0;
  }).length;
  useEffect(() => onChange({ dirty, submitting, counted, differences }), [dirty, submitting, counted, differences, onChange]);
  return null;
}

interface SheetFilters { filter: string; uncountedOnly: boolean; differencesOnly: boolean }

function matches(line: any, counted: string, { filter, uncountedOnly, differencesOnly }: SheetFilters) {
  const text = filter.trim().toLowerCase();
  if (text && !`${line.sku} ${line.product_name}`.toLowerCase().includes(text)) return false;
  if (uncountedOnly && counted !== "") return false;
  if (differencesOnly && (counted === "" || toNumber(counted) === toNumber(line.system_quantity))) return false;
  return true;
}

function difference(counted: string, system: string) {
  return counted === "" ? null : toNumber(counted) - toNumber(system);
}

function DifferenceText({ diff }: { diff: number | null }) {
  return (
    <span className={cn("font-medium", diff === null || diff === 0 ? "text-slate-400" : diff < 0 ? "text-red-700" : "text-emerald-700")}>
      {diff === null ? "–" : diff === 0 ? "0" : `${diff > 0 ? "+" : ""}${formatQty(diff.toFixed(3))}`}
    </span>
  );
}

const diffRowClass = (diff: number | null) => (diff !== null && diff !== 0 ? (diff < 0 ? "bg-red-50/60" : "bg-emerald-50/60") : undefined);

const productCell = (l: any) => (
  <>
    <Link to={`/inventory/products/${l.product}`} className="font-medium text-slate-800 hover:text-brand-700">{l.product_name}</Link>
    <div className="text-2xs text-slate-500">{l.sku}</div>
  </>
);

function EditableSheet({ lines, onRemove, removing, ...filters }: SheetFilters & { lines: any[]; onRemove: (product: number) => void; removing: boolean }) {
  const values = (useWatch({ name: "lines" }) ?? []) as SheetLine[];
  const rows = lines.map((line, index) => ({ line, index, counted: values[index]?.counted_quantity ?? "" }))
    .filter((r) => matches(r.line, r.counted, filters));
  const focusNext = (position: number) => {
    const next = document.querySelector<HTMLInputElement>(`[data-count-row="${position + 1}"] input`);
    if (next) { next.focus(); next.select(); }
  };
  if (!rows.length) return <EmptyState title="No lines match the filter" />;
  const columns: TableColumn<(typeof rows)[number]>[] = [
    col.custom("n", "#", (r) => <span className="text-xs text-slate-400">{rows.indexOf(r) + 1}</span>, { width: 32 }),
    col.custom("product", "Product", (r) => productCell(r.line)),
    col.custom("unit", "Unit", (r) => <span className="text-xs text-slate-500">{r.line.unit}</span>, { width: 64 }),
    col.custom("system_quantity", "System qty", (r) => formatQty(r.line.system_quantity), { width: 128, align: "right" }),
    col.custom("counted_quantity", "Counted", (r) => {
      const position = rows.indexOf(r);
      return (
        <div data-count-row={position} onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); focusNext(position); }
        }}>
          <CellInput number name={`lines.${r.index}.counted_quantity`} label={`Counted quantity for ${r.line.sku}`} placeholder="Not counted" />
        </div>
      );
    }, { width: 144, align: "right" }),
    col.custom("difference", "Difference", (r) => <DifferenceText diff={difference(r.counted, r.line.system_quantity)} />, { width: 128, align: "right" }),
    col.custom("notes", "Notes", (r) => <CellInput name={`lines.${r.index}.notes`} label={`Notes for ${r.line.sku}`} />, { width: 224 }),
    col.custom("remove", "", (r) => (removing ? null : <RemoveLineButton label={`Remove ${r.line.sku}`} onClick={() => onRemove(r.line.product)} />), { width: 40 }),
  ];
  return (
    <BaseTable rows={rows} rowKey={(r) => r.line.id} columns={columns} density="compact" minWidth={860}
      rowClassName={(r) => diffRowClass(difference(r.counted, r.line.system_quantity))} />
  );
}

function ReadOnlySheet({ lines, ...filters }: SheetFilters & { lines: any[] }) {
  const counted = (l: any) => (l.counted_quantity === null ? "" : String(l.counted_quantity));
  const rows = lines.filter((l) => matches(l, counted(l), filters));
  if (!rows.length) return <EmptyState title="No lines match the filter" />;
  return (
    <BaseTable rows={rows} density="compact" minWidth={860}
      rowClassName={(l: any) => diffRowClass(difference(counted(l), l.system_quantity))}
      columns={[
        col.custom("n", "#", (l: any) => <span className="text-xs text-slate-400">{rows.indexOf(l) + 1}</span>, { width: 32 }),
        col.custom("product", "Product", productCell),
        col.custom("unit", "Unit", (l: any) => <span className="text-xs text-slate-500">{l.unit}</span>, { width: 64 }),
        col.qty("system_quantity", "System qty", { width: 128 }),
        col.custom("counted_quantity", "Counted", (l: any) => (l.counted_quantity === null ? "–" : formatQty(l.counted_quantity)), { width: 144, align: "right" }),
        col.custom("difference", "Difference", (l: any) => <DifferenceText diff={difference(counted(l), l.system_quantity)} />, { width: 128, align: "right" }),
        col.custom("notes", "Notes", (l: any) => <span className="text-xs text-slate-600">{l.notes || "–"}</span>, { width: 224 }),
      ]} />
  );
}
