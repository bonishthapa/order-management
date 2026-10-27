import type { ICellRendererParams } from "ag-grid-community";
import { BookOpen, Download, Pencil, Percent, Plus, ScanLine, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import { api, downloadFile, errorMessage, fieldErrors } from "@/api/client";
import { useApiMutation, useDetail, useGet, useOptions } from "@/api/hooks";
import type { Paginated } from "@/api/types";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { DataTable } from "@/components/data/DataTable";
import { ResourceList } from "@/components/data/ResourceList";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { referenceLink } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
const PRODUCT_TYPES = [{ value: "STOCK", label: "Stock item" }, { value: "SERVICE", label: "Service / non-stock" }];
const LIST_FILTER_KEYS = ["search", "category", "brand", "product_type", "is_active", "low_stock", "warehouse"];

// --- List ------------------------------------------------------------------------------------------

export function ProductList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | "import" | "price">(null);
  return (
    <>
      <PageHeader title="Products" subtitle="Items you buy, stock and sell. Stock figures are across warehouses unless a warehouse is selected."
        actions={<>
          <BarcodeLookup />
          {can("products.manage") && <Button icon={<Upload className="h-3.5 w-3.5" />} onClick={() => setDialog("import")}>Import</Button>}
          {can("products.price_update") && <Button icon={<Percent className="h-3.5 w-3.5" />} onClick={() => setDialog("price")}>Bulk price update</Button>}
          {can("products.manage") && (
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/products/new")}>New product</Button>
          )}
        </>} />
      <ResourceList resource="products" searchPlaceholder="SKU, name, barcode…" detailPath={(r) => `/inventory/products/${r.id}`}
        exportUrl="/products/export/" defaultOrdering="name"
        filters={[
          { type: "entity", name: "category", label: "Category", resource: "product-categories" },
          { type: "entity", name: "brand", label: "Brand", resource: "brands" },
          { type: "select", name: "product_type", label: "Type", options: PRODUCT_TYPES },
          { type: "select", name: "is_active", label: "Status", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" },
          { type: "boolean", name: "low_stock", label: "At or below reorder level" },
        ]}
        columns={() => [
          col.text("sku", "SKU", { sortable: true, pinned: "left", minWidth: 130, cellClass: "font-medium text-brand-700" }),
          col.text("name", "Name", { sortable: true, flex: 2, minWidth: 220 }),
          col.text("category_name", "Category"),
          col.text("unit_code", "Unit", { maxWidth: 80 }),
          col.money("selling_price", "Selling price", { sortable: true }),
          col.money("purchase_price", "Purchase price", { sortable: true }),
          col.qty("on_hand", "On hand", {
            sortable: true,
            valueFormatter: (p: any) => (p.data?.product_type === "SERVICE" ? "–" : formatQty(p.value)),
            cellClassRules: { "text-red-700 font-medium": (p: any) => !!p.data && p.data.product_type === "STOCK" && toNumber(p.data.reorder_level) > 0 && toNumber(p.value) <= toNumber(p.data.reorder_level) },
          }),
          col.qty("reserved", "Reserved", { valueFormatter: (p: any) => (p.data?.product_type === "SERVICE" ? "–" : formatQty(p.value)) }),
          col.money("stock_value", "Stock value", { sortable: true }),
          col.text("is_active", "Status", {
            maxWidth: 130,
            cellRenderer: (p: ICellRendererParams) => (
              <span className="flex gap-1">
                <Badge tone={p.value ? "green" : "neutral"}>{p.value ? "Active" : "Inactive"}</Badge>
                {p.data?.product_type === "SERVICE" && <Badge tone="slate">Service</Badge>}
              </span>
            ),
          }),
        ]}
        empty={{ title: "No products found", description: "Try changing the filters, or create or import products." }} />
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === "price" && <BulkPriceDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function BarcodeLookup() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const lookup = async () => {
    const value = code.trim();
    if (!value) return;
    setBusy(true);
    try {
      const { data } = await api.get("/products/lookup/", { params: { code: value } });
      setCode("");
      navigate(`/inventory/products/${data.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative w-56">
      <ScanLine className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <Input value={code} onChange={(e) => setCode(e.target.value)} className="pl-8" placeholder="Scan barcode or SKU, Enter" aria-label="Barcode or SKU lookup"
        disabled={busy} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } }} />
    </div>
  );
}

interface ImportResult { rows: number; errors: { row: number; field: string; message: string }[]; created: number; updated: number; dry_run: boolean }

function ImportDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<null | "check" | "import">(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? "check" : "import");
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("dry_run", String(dryRun));
    form.append("update_existing", String(updateExisting));
    try {
      const { data } = await api.post<ImportResult>("/products/import/", form);
      setResult(data);
      if (!dryRun) {
        queryClient.invalidateQueries({ queryKey: ["products"] });
        ["product-categories", "brands"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(`Import complete: ${data.created} created, ${data.updated} updated`);
      }
    } catch (e) {
      const body = axios.isAxiosError(e) ? (e.response?.data as any) : null;
      if (body && Array.isArray(body.errors)) setResult(body as ImportResult);
      else { setResult(null); setError(errorMessage(e)); }
    } finally {
      setBusy(null);
    }
  };

  const template = (format: "csv" | "xlsx") => downloadFile("/products/import-template/", { export: format }, `product-import-template.${format}`)
    .catch((e) => toast.error(errorMessage(e)));
  const checked = result?.dry_run && result.errors.length === 0;
  const done = result && !result.dry_run && result.errors.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Import products" size="lg"
      description="Upload a CSV or Excel (.xlsx) file. Every row is checked first; nothing is saved if any row has an error."
      footer={done ? <Button variant="primary" onClick={onClose}>Close</Button> : <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={checked ? "secondary" : "primary"} loading={busy === "check"} disabled={!file || !!busy} onClick={() => run(true)}>Check file</Button>
        <Button variant="primary" loading={busy === "import"} disabled={!checked || !!busy} onClick={() => run(false)}>
          {checked ? `Import ${result!.rows} row${result!.rows === 1 ? "" : "s"}` : "Import"}
        </Button>
      </>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>Start from the template:</span>
          <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => template("csv")}>CSV template</Button>
          <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => template("xlsx")}>Excel template</Button>
        </div>
        <p className="text-xs text-slate-500">
          Columns: sku (blank to auto-number), name*, barcode, product_type (STOCK or SERVICE), category, brand, unit* (unit code, e.g. PCS),
          purchase_price, selling_price, tax_rate (name or percent), reorder_level, description. New categories and brands are created.
        </p>
        <Field label="File" required>
          <input ref={inputRef} type="file" accept=".csv,.xlsx" className="block w-full text-[13px] file:mr-3 file:rounded file:border file:border-line-strong file:bg-white file:px-3 file:py-1 file:text-[13px]"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }} />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-slate-700">
          <input type="checkbox" className="accent-brand-600" checked={updateExisting}
            onChange={(e) => { setUpdateExisting(e.target.checked); setResult(null); }} />
          Update products whose SKU already exists (otherwise existing SKUs are reported as errors)
        </label>
        {error && <Alert tone="error">{error}</Alert>}
        {result && result.errors.length > 0 && (
          <>
            <Alert tone="error" title={`${result.errors.length} problem${result.errors.length === 1 ? "" : "s"} in ${result.rows} rows`}>
              Fix the file and check it again. Row numbers match the spreadsheet (row 1 is the header).
            </Alert>
            <div className="max-h-64 overflow-y-auto rounded border border-line">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                  <tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Column</th><th className="px-3 py-1.5">Problem</th></tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="num px-3 py-1.5 text-left">{e.row}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{e.field}</td>
                      <td className="px-3 py-1.5">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {checked && <Alert tone="success">{result!.rows} row{result!.rows === 1 ? "" : "s"} checked with no errors. Click Import to save them.</Alert>}
        {done && <Alert tone="success" title="Import complete">{result!.created} product(s) created, {result!.updated} updated.</Alert>}
      </div>
    </Dialog>
  );
}

function BulkPriceDialog({ onClose }: { onClose: () => void }) {
  const [searchParams] = useSearchParams();
  const categories = useOptions<any>("product-categories");
  const filterParams = useMemo(() => Object.fromEntries(LIST_FILTER_KEYS.filter((k) => searchParams.get(k)).map((k) => [k, searchParams.get(k)!])), [searchParams]);
  const hasFilters = Object.keys(filterParams).length > 0;
  const matching = useGet<Paginated<any>>(["products", "bulk-scope"], "/products/", { ...filterParams, page_size: 1 });
  const [scope, setScope] = useState<"filtered" | "category">(hasFilters ? "filtered" : "category");
  const [category, setCategory] = useState(searchParams.get("category") ?? "");
  const [field, setField] = useState<"selling_price" | "purchase_price">("selling_price");
  const [mode, setMode] = useState<"percent" | "amount" | "set">("percent");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [collecting, setCollecting] = useState(false);
  const [result, setResult] = useState<{ updated: number; changes: { id: number; sku: string; old: string; new: string }[] } | null>(null);
  const update = useApiMutation(async (body: any) => (await api.post("/products/bulk-price-update/", body)).data, { invalidate: ["products"] });
  const count = matching.data?.count ?? 0;

  const collectIds = async () => {
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const { data } = await api.get<Paginated<any>>("/products/", { params: { ...filterParams, page, page_size: 500 } });
      ids.push(...data.results.map((p) => p.id));
      if (page >= data.num_pages) break;
    }
    return ids;
  };

  const submit = async () => {
    const e: Record<string, string> = {};
    if (scope === "category" && !category) e.category = "Choose a category.";
    if (scope === "filtered" && count === 0) e.scope = "No products match the current filters.";
    if (value.trim() === "" || Number.isNaN(Number(value))) e.value = "Enter a number.";
    else if (mode === "set" && Number(value) < 0) e.value = "Price cannot be negative.";
    if (!reason.trim()) e.reason = "Give a reason for the audit trail.";
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      let target: Record<string, unknown>;
      if (scope === "filtered") {
        setCollecting(true);
        target = { product_ids: await collectIds() };
        setCollecting(false);
      } else {
        target = { category: Number(category) };
      }
      const data = await update.mutateAsync({ ...target, field, mode, value, reason: reason.trim() });
      setResult(data);
      toast.success(`${data.updated} price${data.updated === 1 ? "" : "s"} changed`);
    } catch (err) {
      setCollecting(false);
      setErrors(fieldErrors(err));
    }
  };

  const valueLabel = { percent: "Change by (%)", amount: "Change by (amount)", set: "New price" }[mode];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Bulk price update" size="lg"
      description="Changes take effect immediately for new documents. Existing orders and invoices keep their prices."
      footer={result ? <Button variant="primary" onClick={onClose}>Close</Button> : <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={update.isPending || collecting} onClick={submit}>Update prices</Button>
      </>}>
      {result ? (
        <div className="space-y-3">
          <Alert tone="success" title={`${result.updated} product price${result.updated === 1 ? "" : "s"} changed`}>
            {result.updated === 0 && "All selected products already had the resulting price."}
          </Alert>
          {result.changes.length > 0 && (
            <div className="max-h-72 overflow-y-auto rounded border border-line">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                  <tr><th className="px-3 py-1.5">SKU</th><th className="px-3 py-1.5 text-right">Old</th><th className="px-3 py-1.5 text-right">New</th></tr>
                </thead>
                <tbody>
                  {result.changes.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-1.5"><Link className="link" to={`/inventory/products/${c.id}`} onClick={onClose}>{c.sku}</Link></td>
                      <td className="num px-3 py-1.5">{formatAmount(c.old)}</td>
                      <td className="num px-3 py-1.5">{formatAmount(c.new)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="mb-1 text-xs font-medium text-slate-600">Products</legend>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" className="accent-brand-600" checked={scope === "filtered"} onChange={() => setScope("filtered")} />
              {hasFilters ? "Products matching the current list filters" : "All products (no list filters applied)"}
              <span className="text-xs text-slate-500">({matching.isLoading ? "…" : `${count.toLocaleString()} product${count === 1 ? "" : "s"}`})</span>
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" className="accent-brand-600" checked={scope === "category"} onChange={() => setScope("category")} /> One category
            </label>
            {errors.scope && <p className="text-xs text-red-600">{errors.scope}</p>}
            {errors.product_ids && <p className="text-xs text-red-600">{errors.product_ids}</p>}
          </fieldset>
          {scope === "category" && (
            <Field label="Category" required error={errors.category} className="sm:col-span-2">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} invalid={!!errors.category}>
                <option value="">Choose…</option>
                {(categories.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.product_count ?? 0})</option>)}
              </Select>
            </Field>
          )}
          <Field label="Price" required>
            <Select value={field} onChange={(e) => setField(e.target.value as any)}>
              <option value="selling_price">Selling price</option>
              <option value="purchase_price">Purchase price</option>
            </Select>
          </Field>
          <Field label="Method" required>
            <Select value={mode} onChange={(e) => setMode(e.target.value as any)}>
              <option value="percent">Increase/decrease by percent</option>
              <option value="amount">Increase/decrease by amount</option>
              <option value="set">Set to a fixed price</option>
            </Select>
          </Field>
          <Field label={valueLabel} required error={errors.value} hint={mode === "set" ? undefined : "Use a negative number to reduce. Prices never go below zero."}>
            <NumberInput value={value} onChange={(e) => setValue(e.target.value)} invalid={!!errors.value} />
          </Field>
          <Field label="Reason" required error={errors.reason} className="sm:col-span-2">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!errors.reason} placeholder="e.g. Supplier price revision Kartik 2083" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// --- Form ------------------------------------------------------------------------------------------

interface ProductValues {
  sku: string;
  barcode: string;
  name: string;
  description: string;
  product_type: "STOCK" | "SERVICE";
  category: string;
  brand: string;
  unit: string;
  purchase_price: string;
  selling_price: string;
  tax_rate: string;
  reorder_level: string;
  reorder_quantity: string;
  track_batches: boolean;
  track_serials: boolean;
  track_expiry: boolean;
  variant_of: number | null;
  attributes: { key: string; value: string }[];
  is_active: boolean;
  price_tiers: { min_quantity: string; price: string; customer_category: string }[];
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));

export function ProductForm() {
  const { id } = useParams();
  const query = useDetail<any>("products", id);
  if (id && query.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <ProductFormBody key={id ?? "new"} initial={query.data} />;
}

function ProductFormBody({ initial }: { initial?: any }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const units = useOptions<any>("units");
  const taxes = useOptions<any>("tax-rates");
  const categories = useOptions<any>("product-categories");
  const brands = useOptions<any>("brands");
  const customerCategories = useOptions<any>("customer-categories");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const locked = !!initial?.has_transactions;

  const { control, register, handleSubmit, setError, setValue, formState: { errors } } = useForm<ProductValues>({
    defaultValues: initial ? {
      sku: initial.sku, barcode: initial.barcode, name: initial.name, description: initial.description, product_type: initial.product_type,
      category: initial.category ? String(initial.category) : "", brand: initial.brand ? String(initial.brand) : "", unit: String(initial.unit),
      purchase_price: num(initial.purchase_price), selling_price: num(initial.selling_price), tax_rate: initial.tax_rate ? String(initial.tax_rate) : "",
      reorder_level: num(initial.reorder_level), reorder_quantity: num(initial.reorder_quantity), track_batches: initial.track_batches,
      track_serials: initial.track_serials, track_expiry: initial.track_expiry, variant_of: initial.variant_of,
      attributes: Object.entries(initial.variant_attributes ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      is_active: initial.is_active,
      price_tiers: (initial.price_tiers ?? []).map((t: any) => ({ min_quantity: num(t.min_quantity), price: num(t.price), customer_category: t.customer_category ? String(t.customer_category) : "" })),
    } : {
      sku: "", barcode: "", name: "", description: "", product_type: "STOCK", category: "", brand: "", unit: "", purchase_price: "0", selling_price: "0",
      tax_rate: "", reorder_level: "0", reorder_quantity: "0", track_batches: false, track_serials: false, track_expiry: false, variant_of: null,
      attributes: [], is_active: true, price_tiers: [],
    },
  });
  const tiers = useFieldArray({ control, name: "price_tiers" });
  const attributes = useFieldArray({ control, name: "attributes" });
  const type = useWatch({ control, name: "product_type" });
  const trackBatches = useWatch({ control, name: "track_batches" });
  const variantOf = useWatch({ control, name: "variant_of" });
  const service = type === "SERVICE";

  // Defaults for a new product: the default tax rate and the first unit.
  useEffect(() => {
    if (initial) return;
    const def = taxes.data?.find((t) => t.is_default && t.is_active);
    if (def) setValue("tax_rate", String(def.id));
  }, [initial, taxes.data, setValue]);
  useEffect(() => {
    if (initial || !units.data?.length) return;
    const pcs = units.data.find((u) => u.code === "PCS") ?? units.data[0];
    setValue("unit", String(pcs.id));
  }, [initial, units.data, setValue]);
  useEffect(() => {
    if (service) { setValue("track_batches", false); setValue("track_serials", false); setValue("track_expiry", false); }
  }, [service, setValue]);
  useEffect(() => { if (!trackBatches) setValue("track_expiry", false); }, [trackBatches, setValue]);
  useEffect(() => {
    if (!image) { setPreview(null); return; }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    let invalid = false;
    if (!v.name.trim()) { setError("name", { message: "Enter the product name." }); invalid = true; }
    if (!v.unit) { setError("unit", { message: "Choose the unit." }); invalid = true; }
    (["purchase_price", "selling_price", "reorder_level", "reorder_quantity"] as const).forEach((k) => {
      if (v[k] === "" || Number.isNaN(Number(v[k])) || Number(v[k]) < 0) { setError(k, { message: "Enter zero or a positive number." }); invalid = true; }
    });
    const keys = new Set<string>();
    v.attributes.forEach((a, i) => {
      const key = a.key.trim();
      if (!key && a.value.trim()) { setError(`attributes.${i}.key`, { message: "Name the attribute." }); invalid = true; }
      if (key && keys.has(key.toLowerCase())) { setError(`attributes.${i}.key`, { message: "Duplicate attribute." }); invalid = true; }
      if (key) keys.add(key.toLowerCase());
    });
    const tierKeys = new Set<string>();
    v.price_tiers.forEach((t, i) => {
      if (!(toNumber(t.min_quantity) > 0)) { setError(`price_tiers.${i}.min_quantity`, { message: "Must be more than 0." }); invalid = true; }
      if (t.price === "" || Number(t.price) < 0 || Number.isNaN(Number(t.price))) { setError(`price_tiers.${i}.price`, { message: "Enter a price." }); invalid = true; }
      const k = `${t.customer_category}|${Number(t.min_quantity)}`;
      if (tierKeys.has(k)) { setError(`price_tiers.${i}.min_quantity`, { message: "Duplicate tier." }); invalid = true; }
      tierKeys.add(k);
    });
    if (initial && v.variant_of === initial.id) { setError("variant_of", { message: "A product cannot be a variant of itself." }); invalid = true; }
    if (invalid) return;

    const payload: Record<string, unknown> = {
      sku: v.sku.trim(), barcode: v.barcode.trim(), name: v.name.trim(), description: v.description, product_type: v.product_type,
      category: v.category ? Number(v.category) : null, brand: v.brand ? Number(v.brand) : null, unit: Number(v.unit),
      purchase_price: v.purchase_price, selling_price: v.selling_price, tax_rate: v.tax_rate ? Number(v.tax_rate) : null,
      reorder_level: v.reorder_level, reorder_quantity: v.reorder_quantity,
      track_batches: !service && v.track_batches, track_serials: !service && v.track_serials, track_expiry: !service && v.track_batches && v.track_expiry,
      variant_of: v.variant_of,
      variant_attributes: Object.fromEntries(v.attributes.filter((a) => a.key.trim()).map((a) => [a.key.trim(), a.value.trim()])),
      is_active: v.is_active,
      price_tiers: v.price_tiers.map((t) => ({ min_quantity: t.min_quantity, price: t.price, customer_category: t.customer_category ? Number(t.customer_category) : null })),
    };
    if (removeImage && !image) payload.image = null;
    setSaving(true);
    try {
      const { data } = initial ? await api.patch(`/products/${initial.id}/`, payload) : await api.post("/products/", payload);
      if (image) {
        const form = new FormData();
        form.append("image", image);
        try { await api.patch(`/products/${data.id}/`, form); }
        catch (e) { toast.error(`Product saved, but the image was not uploaded: ${errorMessage(e)}`); }
      }
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(initial ? "Product updated" : `Product ${data.sku} created`);
      navigate(`/inventory/products/${data.id}`);
    } catch (err) {
      Object.entries(fieldErrors(err)).forEach(([k, message]) => {
        const field = k === "variant_attributes" ? "attributes" : k;
        setError(field as any, { message });
      });
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  });

  const currentImage = !removeImage ? initial?.image : null;
  return (
    <>
      <PageHeader title={initial ? `Edit ${initial.sku}` : "New product"}
        back={initial ? { to: `/inventory/products/${initial.id}`, label: initial.name } : { to: "/inventory/products", label: "Products" }} />
      <div className="space-y-4">
        {formError && <Alert tone="error">{formError}</Alert>}
        {locked && (
          <Alert tone="info" title="Stock has been posted for this product">
            Product type, unit, batch tracking and serial tracking can no longer be changed.
          </Alert>
        )}
        <Panel title="Product">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name" required error={errors.name?.message} className="sm:col-span-2">
              <Input {...register("name")} invalid={!!errors.name} maxLength={200} />
            </Field>
            <Field label="SKU" error={errors.sku?.message} hint={initial ? undefined : "Leave blank to number automatically."}>
              <Input {...register("sku")} invalid={!!errors.sku} maxLength={40} className="uppercase" />
            </Field>
            <Field label="Barcode" error={errors.barcode?.message}><Input {...register("barcode")} invalid={!!errors.barcode} maxLength={60} /></Field>
            <Field label="Type" required error={errors.product_type?.message}>
              <Select {...register("product_type")} disabled={locked}>
                {PRODUCT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label="Unit" required error={errors.unit?.message}>
              <Select {...register("unit")} disabled={locked} invalid={!!errors.unit}>
                <option value="">Choose…</option>
                {(units.data ?? []).filter((u) => u.is_active || String(u.id) === String(initial?.unit)).map((u) => (
                  <option key={u.id} value={u.id}>{u.code} · {u.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Category" error={errors.category?.message}>
              <Select {...register("category")}>
                <option value="">None</option>
                {(categories.data ?? []).filter((c) => c.is_active || String(c.id) === String(initial?.category)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Brand" error={errors.brand?.message}>
              <Select {...register("brand")}>
                <option value="">None</option>
                {(brands.data ?? []).filter((b) => b.is_active || String(b.id) === String(initial?.brand)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Description" className="sm:col-span-2 lg:col-span-4"><Textarea rows={2} {...register("description")} /></Field>
            <label className="flex items-center gap-2 text-[13px] text-slate-700">
              <input type="checkbox" className="accent-brand-600" {...register("is_active")} /> Active (available on new documents)
            </label>
          </div>
        </Panel>

        <Panel title="Pricing and tax">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Selling price" required error={errors.selling_price?.message}><NumberInput {...register("selling_price")} invalid={!!errors.selling_price} /></Field>
            <Field label="Purchase price" required error={errors.purchase_price?.message} hint="Default rate on purchase documents.">
              <NumberInput {...register("purchase_price")} invalid={!!errors.purchase_price} />
            </Field>
            <Field label="Tax rate" error={errors.tax_rate?.message}>
              <Select {...register("tax_rate")}>
                <option value="">No tax</option>
                {(taxes.data ?? []).filter((t) => t.is_active || String(t.id) === String(initial?.tax_rate)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-slate-600">Wholesale price tiers</h3>
                <p className="text-xs text-slate-500">The price applies from the minimum quantity upwards; a tier for a customer category takes priority for those customers.</p>
              </div>
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => tiers.append({ min_quantity: "", price: "", customer_category: "" })}>Add tier</Button>
            </div>
            {errors.price_tiers?.message && <p className="mb-2 text-xs text-red-600">{errors.price_tiers.message}</p>}
            {tiers.fields.length === 0 ? <p className="text-xs text-slate-400">No tiers. The selling price applies to every quantity.</p> : (
              <table className="w-full max-w-2xl text-[13px]">
                <thead className="text-left text-xs text-slate-500">
                  <tr><th className="py-1 pr-2">Minimum quantity</th><th className="py-1 pr-2">Unit price</th><th className="py-1 pr-2">Customer category</th><th className="w-8" /></tr>
                </thead>
                <tbody>
                  {tiers.fields.map((f, i) => {
                    const err = errors.price_tiers?.[i];
                    return (
                      <tr key={f.id} className="align-top">
                        <td className="py-1 pr-2">
                          <NumberInput {...register(`price_tiers.${i}.min_quantity`)} invalid={!!err?.min_quantity} />
                          {err?.min_quantity?.message && <p className="mt-0.5 text-xs text-red-600">{err.min_quantity.message}</p>}
                        </td>
                        <td className="py-1 pr-2">
                          <NumberInput {...register(`price_tiers.${i}.price`)} invalid={!!err?.price} />
                          {err?.price?.message && <p className="mt-0.5 text-xs text-red-600">{err.price.message}</p>}
                        </td>
                        <td className="py-1 pr-2">
                          <Select {...register(`price_tiers.${i}.customer_category`)}>
                            <option value="">All customers</option>
                            {(customerCategories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </Select>
                        </td>
                        <td className="py-1 pt-1.5">
                          <button type="button" aria-label="Remove tier" onClick={() => tiers.remove(i)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="Stock control">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Reorder level" error={errors.reorder_level?.message} hint="Flag as low stock at or below this quantity.">
              <NumberInput {...register("reorder_level")} disabled={service} invalid={!!errors.reorder_level} />
            </Field>
            <Field label="Reorder quantity" error={errors.reorder_quantity?.message} hint="Suggested quantity to purchase.">
              <NumberInput {...register("reorder_quantity")} disabled={service} invalid={!!errors.reorder_quantity} />
            </Field>
            <div className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Tracking</span>
              {service && <p className="text-xs text-slate-500">Services are not stocked, so tracking does not apply.</p>}
              <label className={cn("flex items-center gap-2 text-[13px]", (service || locked) && "opacity-60")}>
                <input type="checkbox" className="accent-brand-600" disabled={service || locked} {...register("track_batches")} /> Track batches / lots
              </label>
              <label className={cn("flex items-center gap-2 text-[13px]", (service || !trackBatches) && "opacity-60")}>
                <input type="checkbox" className="accent-brand-600" disabled={service || !trackBatches} {...register("track_expiry")} /> Track expiry dates (requires batches)
              </label>
              <label className={cn("flex items-center gap-2 text-[13px]", (service || locked) && "opacity-60")}>
                <input type="checkbox" className="accent-brand-600" disabled={service || locked} {...register("track_serials")} /> Track serial numbers
              </label>
              {(errors.track_batches || errors.track_serials || errors.track_expiry) && (
                <p className="text-xs text-red-600">{errors.track_batches?.message ?? errors.track_serials?.message ?? errors.track_expiry?.message}</p>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Variant">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2">
            <Field label="Variant of" error={errors.variant_of?.message} hint="Link sizes or colours to a parent product.">
              <Controller control={control} name="variant_of" render={({ field }) => (
                <EntitySelect resource="products" value={field.value} onChange={(v) => field.onChange(v)} placeholder="Not a variant" invalid={!!errors.variant_of} />
              )} />
            </Field>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Attributes</span>
                <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => attributes.append({ key: "", value: "" })}>Add attribute</Button>
              </div>
              {errors.attributes?.message && <p className="mb-1 text-xs text-red-600">{errors.attributes.message}</p>}
              {attributes.fields.length === 0 ? (
                <p className="text-xs text-slate-400">{variantOf ? "Add attributes such as Size or Colour." : "None."}</p>
              ) : (
                <div className="space-y-1.5">
                  {attributes.fields.map((f, i) => (
                    <div key={f.id} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Input {...register(`attributes.${i}.key`)} placeholder="Attribute, e.g. Size" invalid={!!errors.attributes?.[i]?.key} aria-label="Attribute name" />
                        {errors.attributes?.[i]?.key?.message && <p className="mt-0.5 text-xs text-red-600">{errors.attributes[i]!.key!.message}</p>}
                      </div>
                      <Input className="flex-1" {...register(`attributes.${i}.value`)} placeholder="Value, e.g. L" aria-label="Attribute value" />
                      <button type="button" aria-label="Remove attribute" onClick={() => attributes.remove(i)} className="mt-1.5 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Image">
          <div className="flex flex-wrap items-start gap-4 p-4">
            <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded border border-line bg-surface-muted">
              {preview ? <img src={preview} alt="New product image" className="h-full w-full object-contain" />
                : currentImage ? <img src={currentImage} alt={initial?.name} className="h-full w-full object-contain" />
                  : <span className="text-2xs text-slate-400">No image</span>}
            </div>
            <div className="space-y-2">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Product image"
                className="block text-[13px] file:mr-3 file:rounded file:border file:border-line-strong file:bg-white file:px-3 file:py-1 file:text-[13px]"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.size > 2 * 1024 * 1024) { toast.error("Images must be smaller than 2 MB."); e.target.value = ""; return; }
                  setImage(f);
                  if (f) setRemoveImage(false);
                }} />
              <p className="text-xs text-slate-500">PNG, JPEG or WebP, up to 2 MB. Uploaded when you save.</p>
              {(errors as any).image?.message && <p className="text-xs text-red-600">{(errors as any).image.message}</p>}
              {initial?.image && !image && (
                <label className="flex items-center gap-2 text-[13px] text-slate-700">
                  <input type="checkbox" className="accent-brand-600" checked={removeImage} onChange={(e) => setRemoveImage(e.target.checked)} /> Remove current image
                </label>
              )}
            </div>
          </div>
        </Panel>

        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={onSubmit}>{initial ? "Save changes" : "Create product"}</Button>
        </div>
      </div>
    </>
  );
}

// --- Detail ----------------------------------------------------------------------------------------

interface StockInfo {
  warehouses: { warehouse_id: number; warehouse: string; is_transit: boolean; on_hand: number; reserved: number; available: number; value: number; unit_cost: number }[];
  batches: { warehouse: string; batch: string; expiry_date: string | null; quantity: number }[];
}

export function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, dateMode } = useAuth();
  const query = useDetail<any>("products", id);
  const stock = useGet<StockInfo>(["products", "stock", id], `/products/${id}/stock/`, {}, !!id && can(["products.view", "inventory.view"]));
  const [historyPage, setHistoryPage] = useState(1);
  const [historySize, setHistorySize] = useState(25);
  const history = useGet<Paginated<any>>(["products", "history", id], `/products/${id}/history/`, { page: historyPage, page_size: historySize },
    !!id && can("inventory.view"));
  const customerCategories = useOptions<any>("customer-categories");
  const parent = useDetail<any>("products", query.data?.variant_of ?? undefined, { enabled: !!query.data?.variant_of });
  const [confirmActive, setConfirmActive] = useState(false);
  const toggle = useApiMutation(async (is_active: boolean) => (await api.patch(`/products/${id}/`, { is_active })).data, {
    invalidate: ["products"], success: (p: any) => (p.is_active ? "Product reactivated" : "Product deactivated"),
  });

  const historyColumns = useMemo(() => [
    col.date("date", "Date", { dateMode }),
    col.text("movement_number", "Movement", { minWidth: 160, cellClass: "font-medium text-brand-700" }),
    col.text("movement_type_label", "Type", { minWidth: 150 }),
    col.text("warehouse_code", "Warehouse", { maxWidth: 120 }),
    col.text("batch_number", "Batch", { maxWidth: 120 }),
    col.qty("quantity", "Quantity", { cellClassRules: { "text-red-700": (p: any) => toNumber(p.value) < 0, "text-emerald-700": (p: any) => toNumber(p.value) > 0 } }),
    col.money("unit_cost", "Unit cost", { valueFormatter: (p: any) => formatAmount(p.value, 4) }),
    col.money("value", "Value"),
    col.qty("balance_quantity", "Balance"),
    col.text("reference_number", "Reference", {
      minWidth: 150,
      cellRenderer: (p: ICellRendererParams) => {
        const to = referenceLink(p.data?.reference_type, p.data?.reference_id);
        return to && p.value ? <Link className="link" to={to} onClick={(e) => e.stopPropagation()}>{p.value}</Link> : (p.value || "–");
      },
    }),
  ], [dateMode]);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const p = query.data;
  const isStock = p.product_type === "STOCK";
  const low = isStock && toNumber(p.reorder_level) > 0 && toNumber(p.on_hand) <= toNumber(p.reorder_level);
  const categoryName = (cid: number | null) => (cid ? customerCategories.data?.find((c) => c.id === cid)?.name ?? `#${cid}` : "All customers");
  const warehouses = (stock.data?.warehouses ?? []).filter((w) => !w.is_transit || w.on_hand !== 0);

  return (
    <>
      <PageHeader back={{ to: "/inventory/products", label: "Products" }} title={p.name}
        meta={<>
          <Badge tone={p.is_active ? "green" : "neutral"}>{p.is_active ? "Active" : "Inactive"}</Badge>
          {!isStock && <Badge tone="slate">Service</Badge>}
          {low && <Badge tone="amber">Low stock</Badge>}
        </>}
        subtitle={<>{p.sku}{p.barcode ? ` · ${p.barcode}` : ""}{p.category_name ? ` · ${p.category_name}` : ""}</>}
        actions={<>
          {can("inventory.view") && isStock && (
            <Button icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => navigate(`/inventory/ledger?product=${p.id}&fiscal_year=all`)}>Stock ledger</Button>
          )}
          {can("products.manage") && (
            <>
              <Button onClick={() => setConfirmActive(true)}>{p.is_active ? "Deactivate" : "Reactivate"}</Button>
              <Button variant="primary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/inventory/products/${p.id}/edit`)}>Edit</Button>
            </>
          )}
          {can("inventory.manage") && isStock && (
            <Menu>
              <MenuTrigger asChild><Button>More</Button></MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => navigate("/inventory/movements/new")}>New stock movement</MenuItem>
                <MenuItem onSelect={() => navigate("/inventory/transfers/new")}>New transfer</MenuItem>
              </MenuContent>
            </Menu>
          )}
        </>} />

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Summary" className="lg:col-span-2">
            <KeyValues items={[
              { label: "SKU", value: p.sku },
              { label: "Barcode", value: p.barcode || "–" },
              { label: "Type", value: isStock ? "Stock item" : "Service / non-stock" },
              { label: "Unit", value: p.unit_code },
              { label: "Category", value: p.category_name ?? "–" },
              { label: "Brand", value: p.brand_name ?? "–" },
              { label: "Selling price", value: formatAmount(p.selling_price) },
              { label: "Purchase price", value: formatAmount(p.purchase_price) },
              { label: "Tax", value: p.tax_rate_percent !== null ? `${Number(p.tax_rate_percent)}%` : "No tax" },
              { label: "Reorder level", value: isStock ? `${formatQty(p.reorder_level)} (order ${formatQty(p.reorder_quantity)})` : "–" },
              { label: "Tracking", value: [p.track_batches && "Batches", p.track_expiry && "Expiry", p.track_serials && "Serial numbers"].filter(Boolean).join(", ") || "None" },
              { label: "Variant of", value: p.variant_of ? <Link className="link" to={`/inventory/products/${p.variant_of}`}>{parent.data ? `${parent.data.sku} · ${parent.data.name}` : `#${p.variant_of}`}</Link> : "–" },
              ...(Object.keys(p.variant_attributes ?? {}).length ? [{
                label: "Attributes", wide: true,
                value: <span className="flex flex-wrap gap-1">{Object.entries(p.variant_attributes).map(([k, v]) => <Badge key={k} tone="slate">{k}: {String(v)}</Badge>)}</span>,
              }] : []),
              ...(p.description ? [{ label: "Description", value: <span className="whitespace-pre-line">{p.description}</span>, wide: true }] : []),
            ]} />
          </Panel>
          <div className="space-y-4">
            {p.image && (
              <Panel title="Image"><div className="flex justify-center p-4"><img src={p.image} alt={p.name} className="max-h-48 object-contain" /></div></Panel>
            )}
            {isStock && (
              <Panel title="Stock (all warehouses)">
                <dl className="grid grid-cols-2 gap-3 p-4 text-[13px]">
                  <div><dt className="kv-label">On hand</dt><dd className={cn("mt-0.5 tabular-nums", low && "font-medium text-red-700")}>{formatQty(p.on_hand)} {p.unit_code}</dd></div>
                  <div><dt className="kv-label">Reserved</dt><dd className="mt-0.5 tabular-nums">{formatQty(p.reserved)}</dd></div>
                  <div><dt className="kv-label">Available</dt><dd className="mt-0.5 tabular-nums">{formatQty(toNumber(p.on_hand) - toNumber(p.reserved))}</dd></div>
                  <div><dt className="kv-label">Stock value</dt><dd className="mt-0.5 tabular-nums">{formatAmount(p.stock_value)}</dd></div>
                </dl>
              </Panel>
            )}
          </div>
        </div>

        {isStock && (
          <Panel title="Stock by warehouse">
            {stock.isLoading ? <LoadingBlock /> : stock.error ? <ErrorState error={stock.error} onRetry={() => stock.refetch()} /> : warehouses.length === 0 ? (
              <p className="p-4 text-xs text-slate-500">No stock has been recorded for this product.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Warehouse</th><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right">Reserved</th>
                    <th className="px-4 py-2 text-right">Available</th><th className="px-4 py-2 text-right">Unit cost</th><th className="px-4 py-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouses.map((w) => (
                    <tr key={w.warehouse_id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">{w.warehouse}{w.is_transit && <Badge tone="amber" className="ml-2">In transit</Badge>}</td>
                      <td className="num px-4 py-2">{formatQty(w.on_hand)}</td>
                      <td className="num px-4 py-2">{formatQty(w.reserved)}</td>
                      <td className="num px-4 py-2">{formatQty(w.available)}</td>
                      <td className="num px-4 py-2">{formatAmount(w.unit_cost, 4)}</td>
                      <td className="num px-4 py-2">{formatAmount(w.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {isStock && (p.track_batches || (stock.data?.batches.length ?? 0) > 0) && (
          <Panel title="Batches in stock">
            {!stock.data?.batches.length ? <p className="p-4 text-xs text-slate-500">No batches in stock.</p> : (
              <table className="w-full text-[13px]">
                <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                  <tr><th className="px-4 py-2">Batch</th><th className="px-4 py-2">Warehouse</th><th className="px-4 py-2">Expiry</th><th className="px-4 py-2 text-right">Quantity</th></tr>
                </thead>
                <tbody>
                  {stock.data.batches.map((b, i) => (
                    <tr key={`${b.warehouse}-${b.batch}-${i}`} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 font-medium">{b.batch}</td>
                      <td className="px-4 py-2">{b.warehouse}</td>
                      <td className="px-4 py-2"><DateText value={b.expiry_date} /></td>
                      <td className="num px-4 py-2">{formatQty(b.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        <Panel title="Price tiers">
          {!p.price_tiers.length ? <p className="p-4 text-xs text-slate-500">No wholesale tiers. The selling price of {formatAmount(p.selling_price)} applies to every quantity.</p> : (
            <table className="w-full text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                <tr><th className="px-4 py-2">Customer category</th><th className="px-4 py-2 text-right">From quantity</th><th className="px-4 py-2 text-right">Unit price</th><th className="px-4 py-2 text-right">vs. selling price</th></tr>
              </thead>
              <tbody>
                {p.price_tiers.map((t: any) => {
                  const base = toNumber(p.selling_price);
                  const diff = base ? ((toNumber(t.price) - base) / base) * 100 : 0;
                  return (
                    <tr key={t.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">{categoryName(t.customer_category)}</td>
                      <td className="num px-4 py-2">{formatQty(t.min_quantity)} {p.unit_code}</td>
                      <td className="num px-4 py-2">{formatAmount(t.price)}</td>
                      <td className="num px-4 py-2 text-slate-500">{base ? `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {isStock && can("inventory.view") && (
          <Panel title="Stock history">
            <DataTable id="product-history" columns={historyColumns} rows={history.data?.results} total={history.data?.count}
              page={historyPage} pageSize={historySize} onPageChange={setHistoryPage} onPageSizeChange={(s) => { setHistorySize(s); setHistoryPage(1); }}
              loading={history.isLoading} fetching={history.isFetching} error={history.error} onRetry={() => history.refetch()}
              onRowClick={(r: any) => navigate(`/inventory/movements/${r.movement}`)}
              empty={{ title: "No stock movements yet", description: "Opening stock, receipts and deliveries appear here once posted." }} />
          </Panel>
        )}
      </div>

      <ConfirmDialog open={confirmActive} onOpenChange={setConfirmActive} title={p.is_active ? `Deactivate ${p.sku}` : `Reactivate ${p.sku}`}
        tone={p.is_active ? "danger" : "primary"} confirmLabel={p.is_active ? "Deactivate" : "Reactivate"} loading={toggle.isPending}
        description={p.is_active
          ? "The product can no longer be chosen on new documents. Existing documents, stock and history are kept."
          : "The product becomes available on new documents again."}
        onConfirm={() => toggle.mutateAsync(!p.is_active).then(() => setConfirmActive(false)).catch(() => undefined)} />
    </>
  );
}
