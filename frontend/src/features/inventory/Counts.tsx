import { DocumentTimeline } from "@/components/document/Timeline";
import { ClipboardList, Plus, Save, Send, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useDocumentAction, useOptions } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatDateTime, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";

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
        columns={(ctx) => [
          col.doc("number", "Count"),
          col.date("date", "Date", ctx),
          col.text("warehouse_name", "Warehouse", { flex: 2, minWidth: 180 }),
          col.text("progress", "Counted", { valueGetter: (p: any) => (p.data ? `${p.data.counted_count} of ${p.data.line_count}` : ""), cellClass: "num-cell", maxWidth: 140 }),
          col.text("notes", "Notes", { flex: 2 }),
          col.text("posted_by_name", "Posted by"),
          col.status("status", "Status", undefined, { cellRenderer: (p: any) => <StatusBadge status={p.value} label={countStatusLabel(p.value)} /> }),
        ]}
        empty={{ title: "No stock counts", description: "Start a count to reconcile physical stock with the system." }} />
    </>
  );
}

export function CountForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [warehouse, setWarehouse] = useState<number | null>(null);
  const [date, setDate] = useState(todayIn(session?.organization?.timezone));
  const [notes, setNotes] = useState("");
  const [populate, setPopulate] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!warehouse) e.warehouse = "Choose the warehouse being counted.";
    if (!date) e.date = "Enter the count date.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const { data } = await api.post("/stock-counts/", { warehouse, date, notes });
      if (populate) {
        try { await api.post(`/stock-counts/${data.id}/populate/`, {}); }
        catch (err) { toast.error(`Count created, but products were not added: ${errorMessage(err)}`); }
      }
      queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
      toast.success("Stock count started");
      navigate(`/inventory/counts/${data.id}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="New stock count" back={{ to: "/inventory/counts", label: "Stock counts" }}
        subtitle="Start a count sheet, record what is physically on the shelves, then post to adjust stock." />
      <Panel title="Count">
        <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Warehouse" required error={errors.warehouse}>
            <EntitySelect resource="warehouses" value={warehouse} onChange={(v) => setWarehouse(v)} invalid={!!errors.warehouse} />
          </Field>
          <Field label="Count date" required error={errors.date} hint="Adjustments are posted on this date.">
            <DatePicker value={date} onChange={setDate} invalid={!!errors.date} />
          </Field>
          <Field label="Notes" error={errors.notes}><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Quarterly count, aisle A–C" /></Field>
          <label className="flex items-center gap-2 text-[13px] text-slate-700 sm:col-span-2 lg:col-span-3">
            <input type="checkbox" className="accent-brand-600" checked={populate} onChange={(e) => setPopulate(e.target.checked)} />
            Add every product currently in stock at this warehouse to the count sheet
          </label>
        </div>
      </Panel>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => navigate(-1)}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={submit}>Start count</Button>
      </div>
    </>
  );
}

interface SheetValue { counted: string; notes: string }

export function CountDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useDetail<any>("stock-counts", id);
  const action = useDocumentAction<any>("stock-counts", id, ["stock-movements", "inventory/ledger"]);
  const categories = useOptions<any>("product-categories");
  const [sheet, setSheet] = useState<Record<number, SheetValue>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [uncountedOnly, setUncountedOnly] = useState(false);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [newProduct, setNewProduct] = useState<number | null>(null);
  const [dialog, setDialog] = useState<null | "post" | "cancel" | "populate">(null);
  const [populateCategory, setPopulateCategory] = useState("");
  const c = query.data;

  useEffect(() => {
    if (!c || dirty) return;
    setSheet(Object.fromEntries(c.lines.map((l: any) => [l.product, {
      counted: l.counted_quantity === null ? "" : String(Number(l.counted_quantity)), notes: l.notes ?? "",
    }])));
  }, [c, dirty]);

  const rows = useMemo(() => {
    if (!c) return [];
    const text = filter.trim().toLowerCase();
    return c.lines.filter((l: any) => {
      const v = sheet[l.product];
      if (text && !`${l.sku} ${l.product_name}`.toLowerCase().includes(text)) return false;
      if (uncountedOnly && v && v.counted !== "") return false;
      if (differencesOnly && (!v || v.counted === "" || toNumber(v.counted) === toNumber(l.system_quantity))) return false;
      return true;
    });
  }, [c, sheet, filter, uncountedOnly, differencesOnly]);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !c) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const editable = c.status === "DRAFT" && can("inventory.manage");
  const values = c.lines.map((l: any) => sheet[l.product]);
  const countedCount = values.filter((v: SheetValue | undefined) => v && v.counted !== "").length;
  const diffCount = c.lines.filter((l: any) => {
    const v = sheet[l.product];
    return v && v.counted !== "" && toNumber(v.counted) !== toNumber(l.system_quantity);
  }).length;

  const linesPayload = (extra: any[] = [], excludeProduct?: number) => [
    ...c.lines.filter((l: any) => l.product !== excludeProduct).map((l: any) => {
      const v = sheet[l.product] ?? { counted: "", notes: "" };
      return { product: l.product, counted_quantity: v.counted === "" ? null : v.counted, notes: v.notes };
    }),
    ...extra,
  ];

  const saveLines = async (lines: any[], message?: string) => {
    for (const l of lines) {
      if (l.counted_quantity !== null && (Number.isNaN(Number(l.counted_quantity)) || Number(l.counted_quantity) < 0)) {
        toast.error("Counted quantities must be zero or more.");
        return false;
      }
    }
    setSaving(true);
    try {
      const { data } = await api.patch(`/stock-counts/${c.id}/`, { lines });
      queryClient.setQueryData(["stock-counts", "detail", String(c.id)], data);
      queryClient.invalidateQueries({ queryKey: ["stock-counts", "list"] });
      setDirty(false);
      if (message) toast.success(message);
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const update = (product: number, patch: Partial<SheetValue>) => {
    setSheet((s) => ({ ...s, [product]: { ...(s[product] ?? { counted: "", notes: "" }), ...patch } }));
    setDirty(true);
  };

  const addProduct = async () => {
    if (!newProduct) return;
    if (c.lines.some((l: any) => l.product === newProduct)) { toast.error("This product is already on the count sheet."); return; }
    if (await saveLines(linesPayload([{ product: newProduct, counted_quantity: null, notes: "" }]), "Product added")) setNewProduct(null);
  };

  const post = async () => {
    if (dirty && !(await saveLines(linesPayload()))) return;
    try {
      await action.mutateAsync({ action: "post", success: "Stock count posted" });
      setDialog(null);
    } catch { /* toast shown by the action */ }
  };

  const focusNext = (index: number) => {
    const next = document.querySelector<HTMLInputElement>(`[data-count-row="${index + 1}"]`);
    if (next) { next.focus(); next.select(); }
  };

  return (
    <>
      <PageHeader back={{ to: "/inventory/counts", label: "Stock counts" }} title={c.number || `Stock count #${c.id}`}
        meta={<StatusBadge status={c.status} label={countStatusLabel(c.status)} />}
        subtitle={<>{c.warehouse_name} · <DateText value={c.date} bs={c.date_bs} /></>}
        actions={<>
          {editable && <Button icon={<ClipboardList className="h-3.5 w-3.5" />} onClick={() => setDialog("populate")}>Add products from stock</Button>}
          {editable && <Button variant="danger" icon={<XCircle className="h-3.5 w-3.5" />} onClick={() => setDialog("cancel")}>Cancel count</Button>}
          {editable && <Button icon={<Save className="h-3.5 w-3.5" />} loading={saving} disabled={!dirty} onClick={() => saveLines(linesPayload(), "Counts saved")}>Save counts</Button>}
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
            { label: "Lines counted", value: `${countedCount} of ${c.lines.length}` },
            { label: "Lines with a difference", value: String(diffCount) },
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
          ) : rows.length === 0 ? (
            <EmptyState title="No lines match the filter" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-[13px]">
                <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="w-8 px-3 py-2">#</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="w-16 px-3 py-2">Unit</th>
                    <th className="w-32 px-3 py-2 text-right">System qty</th>
                    <th className="w-36 px-3 py-2 text-right">Counted</th>
                    <th className="w-32 px-3 py-2 text-right">Difference</th>
                    <th className="w-56 px-3 py-2">Notes</th>
                    {editable && <th className="w-10 px-2 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l: any, i: number) => {
                    const v = sheet[l.product] ?? { counted: "", notes: "" };
                    const diff = v.counted === "" ? null : toNumber(v.counted) - toNumber(l.system_quantity);
                    return (
                      <tr key={l.id} className={cn("border-b border-line last:border-0", diff !== null && diff !== 0 && (diff < 0 ? "bg-red-50/60" : "bg-emerald-50/60"))}>
                        <td className="px-3 py-1.5 text-xs text-slate-400">{i + 1}</td>
                        <td className="px-3 py-1.5">
                          <Link to={`/inventory/products/${l.product}`} className="font-medium text-slate-800 hover:text-brand-700">{l.product_name}</Link>
                          <div className="text-2xs text-slate-500">{l.sku}</div>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500">{l.unit}</td>
                        <td className="num px-3 py-1.5">{formatQty(l.system_quantity)}</td>
                        <td className="px-3 py-1.5">
                          {editable ? (
                            <NumberInput data-count-row={i} value={v.counted} aria-label={`Counted quantity for ${l.sku}`} placeholder="Not counted"
                              onChange={(e) => update(l.product, { counted: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); focusNext(i); } }} />
                          ) : <span className="num block">{l.counted_quantity === null ? "–" : formatQty(l.counted_quantity)}</span>}
                        </td>
                        <td className={cn("num px-3 py-1.5 font-medium", diff === null || diff === 0 ? "text-slate-400" : diff < 0 ? "text-red-700" : "text-emerald-700")}>
                          {diff === null ? "–" : diff === 0 ? "0" : `${diff > 0 ? "+" : ""}${formatQty(diff.toFixed(3))}`}
                        </td>
                        <td className="px-3 py-1.5">
                          {editable ? <Input value={v.notes} onChange={(e) => update(l.product, { notes: e.target.value })} aria-label={`Notes for ${l.sku}`} />
                            : <span className="text-xs text-slate-600">{l.notes || "–"}</span>}
                        </td>
                        {editable && (
                          <td className="px-2 py-1.5">
                            <button type="button" aria-label={`Remove ${l.sku}`} disabled={saving}
                              onClick={() => saveLines(linesPayload([], l.product), "Line removed")}
                              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
        description={<>
          {countedCount < c.lines.length ? (
            <Alert tone="error">{c.lines.length - countedCount} line(s) have no counted quantity. Enter a count (0 if none was found) or remove the line before posting.</Alert>
          ) : (
            <>
              <p>For each line, the adjustment posted is <strong>counted quantity − stock on hand at the time of posting</strong> in {c.warehouse_name}, dated <DateText value={c.date} bs={c.date_bs} />.</p>
              <p className="mt-2">If stock moved since a line was added, the adjustment differs from the preview. Shortages are costed FIFO; surpluses use the current average cost. The count cannot be edited after posting.</p>
              {dirty && <p className="mt-2 text-amber-700">Unsaved counts are saved first.</p>}
            </>
          )}
        </>}
        onConfirm={() => { if (countedCount < c.lines.length) { setDialog(null); setUncountedOnly(true); return; } return post(); }} />
      <ConfirmDialog open={dialog === "cancel"} onOpenChange={(o) => setDialog(o ? "cancel" : null)} title="Cancel stock count" tone="danger"
        confirmLabel="Cancel count" loading={action.isPending} description="The count is closed without adjusting stock. This cannot be undone."
        onConfirm={() => action.mutateAsync({ action: "cancel", success: "Stock count cancelled" }).then(() => setDialog(null)).catch(() => undefined)} />
      <Dialog open={dialog === "populate"} onOpenChange={(o) => setDialog(o ? "populate" : null)} title="Add products from stock" size="sm"
        description={`Adds every product with stock at ${c.warehouse_name} that is not already on the sheet.`}
        footer={<>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="primary" loading={action.isPending} onClick={async () => {
            if (dirty && !(await saveLines(linesPayload()))) return;
            action.mutateAsync({ action: "populate", body: populateCategory ? { category: Number(populateCategory) } : {}, success: "Products added" })
              .then(() => setDialog(null)).catch(() => undefined);
          }}>Add products</Button>
        </>}>
        <Field label="Category" hint="Leave blank to add all categories.">
          <Select value={populateCategory} onChange={(e) => setPopulateCategory(e.target.value)}>
            <option value="">All categories</option>
            {(categories.data ?? []).map((cat: any) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
          </Select>
        </Field>
      </Dialog>
    </>
  );
}
