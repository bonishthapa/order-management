import { BookOpen, Download, Pencil, Percent, Plus, ScanLine, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import { api, downloadFile, errorMessage } from "@/api/client";
import { useApiMutation, useDetail, useGet, useOptions } from "@/api/hooks";
import type { Paginated } from "@/api/types";
import { DateText } from "@/calendar/DateText";
import { useAuth } from "@/auth/AuthContext";
import {
  BaseForm, CellInput, CellSelect, FormDialog, FormField, FormGrid, FormSection, useFieldArray, useFormContext, useWatch,
} from "@/components/form";
import { BaseTable, DataGrid, ResourceList, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount, formatQty, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { RemoveLineButton, rateColumn, referenceLink } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
const PRODUCT_TYPES = [{ value: "STOCK", label: "Stock item" }, { value: "SERVICE", label: "Service / non-stock" }];
const LIST_FILTER_KEYS = ["search", "category", "brand", "product_type", "is_active", "low_stock", "warehouse"];

const stockQty = (key: string, header: string, extra: Partial<TableColumn> = {}) =>
  col.custom(key, header, (r: any) => (r.product_type === "SERVICE" ? "–" : formatQty(r[key])), { align: "right", minWidth: 90, ...extra });

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
        columns={[
          col.text("sku", "SKU", { sortable: true, pinned: true, minWidth: 130, className: "font-medium text-brand-700" }),
          col.text("name", "Name", { sortable: true, flex: 2, minWidth: 220 }),
          col.text("category_name", "Category"),
          col.text("unit_code", "Unit", { width: 80 }),
          col.money("selling_price", "Selling price", { sortable: true }),
          col.money("purchase_price", "Purchase price", { sortable: true }),
          col.custom("on_hand", "On hand", (r: any) => {
            if (r.product_type === "SERVICE") return "–";
            const low = toNumber(r.reorder_level) > 0 && toNumber(r.on_hand) <= toNumber(r.reorder_level);
            return <span className={low ? "font-medium text-red-700" : undefined}>{formatQty(r.on_hand)}</span>;
          }, { sortable: true, align: "right", minWidth: 90 }),
          stockQty("reserved", "Reserved"),
          col.money("stock_value", "Stock value", { sortable: true }),
          col.custom("is_active", "Status", (r: any) => (
            <span className="flex gap-1">
              <Badge tone={r.is_active ? "green" : "neutral"}>{r.is_active ? "Active" : "Inactive"}</Badge>
              {r.product_type === "SERVICE" && <Badge tone="slate">Service</Badge>}
            </span>
          ), { width: 140 }),
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
              <BaseTable rows={result.errors} rowKey={(_, i) => i} density="compact" stickyHeader columns={[
                col.custom("row", "Row", (e) => <span className="tabular-nums">{e.row}</span>, { width: 64 }),
                col.custom("field", "Column", (e) => <span className="font-mono text-xs">{e.field}</span>),
                col.text("message", "Problem"),
              ]} />
            </div>
          </>
        )}
        {checked && <Alert tone="success">{result!.rows} row{result!.rows === 1 ? "" : "s"} checked with no errors. Click Import to save them.</Alert>}
        {done && <Alert tone="success" title="Import complete">{result!.created} product(s) created, {result!.updated} updated.</Alert>}
      </div>
    </Dialog>
  );
}

interface BulkValues {
  scope: "filtered" | "category";
  category: number | null;
  field: "selling_price" | "purchase_price";
  mode: "percent" | "amount" | "set";
  value: string;
  reason: string;
}
interface BulkResult { updated: number; changes: { id: number; sku: string; old: string; new: string }[] }

function BulkPriceDialog({ onClose }: { onClose: () => void }) {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const filterParams = useMemo(() => Object.fromEntries(LIST_FILTER_KEYS.filter((k) => searchParams.get(k)).map((k) => [k, searchParams.get(k)!])), [searchParams]);
  const hasFilters = Object.keys(filterParams).length > 0;
  const matching = useGet<Paginated<any>>(["products", "bulk-scope"], "/products/", { ...filterParams, page_size: 1 });
  const [result, setResult] = useState<BulkResult | null>(null);
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

  if (result) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="Bulk price update" size="lg" footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <div className="space-y-3">
          <Alert tone="success" title={`${result.updated} product price${result.updated === 1 ? "" : "s"} changed`}>
            {result.updated === 0 && "All selected products already had the resulting price."}
          </Alert>
          {result.changes.length > 0 && (
            <div className="max-h-72 overflow-y-auto rounded border border-line">
              <BaseTable rows={result.changes} density="compact" stickyHeader columns={[
                col.custom("sku", "SKU", (c) => <Link className="link" to={`/inventory/products/${c.id}`} onClick={onClose}>{c.sku}</Link>),
                col.money("old", "Old"),
                col.money("new", "New"),
              ]} />
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <FormDialog<BulkValues> open onOpenChange={(o) => !o && onClose()} title="Bulk price update" size="lg" submitLabel="Update prices" closeOnSuccess={false}
      description="Changes take effect immediately for new documents. Existing orders and invoices keep their prices."
      errorFieldMap={{ product_ids: "scope" }}
      defaultValues={{ scope: hasFilters ? "filtered" : "category", category: searchParams.get("category") ? Number(searchParams.get("category")) : null,
        field: "selling_price", mode: "percent", value: "", reason: "" }}
      onSubmit={async (values, form) => {
        if (values.scope === "category" && !values.category) { form.setError("category", { type: "manual", message: "Choose a category." }); throw new Error("Choose a category."); }
        if (values.scope === "filtered" && count === 0) { form.setError("scope", { type: "manual", message: "No products match the current filters." }); throw new Error("No products match the current filters."); }
        if (values.mode === "set" && Number(values.value) < 0) { form.setError("value", { type: "manual", message: "Price cannot be negative." }); throw new Error("Price cannot be negative."); }
        const target = values.scope === "filtered" ? { product_ids: await collectIds() } : { category: values.category };
        const { data } = await api.post<BulkResult>("/products/bulk-price-update/", {
          ...target, field: values.field, mode: values.mode, value: values.value, reason: values.reason.trim(),
        });
        ["products", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(`${data.updated} price${data.updated === 1 ? "" : "s"} changed`);
        setResult(data);
      }}>
      <BulkPriceFields hasFilters={hasFilters} count={count} countLoading={matching.isLoading} />
    </FormDialog>
  );
}

function BulkPriceFields({ hasFilters, count, countLoading }: { hasFilters: boolean; count: number; countLoading: boolean }) {
  const categories = useOptions<any>("product-categories");
  const scope = useWatch({ name: "scope" }) as BulkValues["scope"];
  const mode = useWatch({ name: "mode" }) as BulkValues["mode"];
  const valueLabel = { percent: "Change by (%)", amount: "Change by (amount)", set: "New price" }[mode];
  return (
    <FormGrid columns={2}>
      <FormField name="scope" label="Products" type="custom" span="full" render={({ value, onChange }) => (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="radio" className="accent-brand-600" checked={value === "filtered"} onChange={() => onChange("filtered")} />
            {hasFilters ? "Products matching the current list filters" : "All products (no list filters applied)"}
            <span className="text-xs text-slate-500">({countLoading ? "…" : `${count.toLocaleString()} product${count === 1 ? "" : "s"}`})</span>
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="radio" className="accent-brand-600" checked={value === "category"} onChange={() => onChange("category")} /> One category
          </label>
        </div>
      )} />
      {scope === "category" && (
        <FormField name="category" label="Category" type="select" required span="full"
          options={(categories.data ?? []).map((c: any) => ({ value: c.id, label: `${c.name} (${c.product_count ?? 0})` }))} />
      )}
      <FormField name="field" label="Price" type="select" required emptyOption={false}
        options={[{ value: "selling_price", label: "Selling price" }, { value: "purchase_price", label: "Purchase price" }]} />
      <FormField name="mode" label="Method" type="select" required emptyOption={false}
        options={[{ value: "percent", label: "Increase/decrease by percent" }, { value: "amount", label: "Increase/decrease by amount" },
          { value: "set", label: "Set to a fixed price" }]} />
      <FormField name="value" label={valueLabel} type="number" required
        hint={mode === "set" ? undefined : "Use a negative number to reduce. Prices never go below zero."} />
      <FormField name="reason" label="Reason" type="textarea" rows={2} required span="full" placeholder="e.g. Supplier price revision Kartik 2083" />
    </FormGrid>
  );
}

// --- Form ------------------------------------------------------------------------------------------

interface ProductValues {
  sku: string;
  barcode: string;
  name: string;
  description: string;
  product_type: "STOCK" | "SERVICE";
  category: number | null;
  brand: number | null;
  unit: number | null;
  purchase_price: string;
  selling_price: string;
  tax_rate: number | null;
  reorder_level: string;
  reorder_quantity: string;
  track_batches: boolean;
  track_serials: boolean;
  track_expiry: boolean;
  variant_of: number | null;
  attributes: { key: string; value: string }[];
  is_active: boolean;
  price_tiers: { min_quantity: string; price: string; customer_category: number | null }[];
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));
const nonNegative = { validate: (v: any) => (v !== "" && !Number.isNaN(Number(v)) && Number(v) >= 0) || "Enter zero or a positive number." };

export function ProductForm() {
  const { id } = useParams();
  const query = useDetail<any>("products", id);
  const units = useOptions<any>("units");
  const taxes = useOptions<any>("tax-rates");
  if ((id && query.isLoading) || units.isLoading || taxes.isLoading) return <LoadingBlock />;
  if (id && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <ProductFormBody key={id ?? "new"} initial={query.data} units={units.data ?? []} taxes={taxes.data ?? []} />;
}

function ProductFormBody({ initial, units, taxes }: { initial?: any; units: any[]; taxes: any[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const categories = useOptions<any>("product-categories");
  const brands = useOptions<any>("brands");
  const [image, setImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const locked = !!initial?.has_transactions;

  useEffect(() => {
    if (!image) { setPreview(null); return; }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const defaultTax = taxes.find((t) => t.is_default && t.is_active);
  const defaultUnit = units.find((u) => u.code === "PCS") ?? units[0];
  const defaultValues: ProductValues = initial ? {
    sku: initial.sku, barcode: initial.barcode, name: initial.name, description: initial.description, product_type: initial.product_type,
    category: initial.category, brand: initial.brand, unit: initial.unit,
    purchase_price: num(initial.purchase_price), selling_price: num(initial.selling_price), tax_rate: initial.tax_rate,
    reorder_level: num(initial.reorder_level), reorder_quantity: num(initial.reorder_quantity), track_batches: initial.track_batches,
    track_serials: initial.track_serials, track_expiry: initial.track_expiry, variant_of: initial.variant_of,
    attributes: Object.entries(initial.variant_attributes ?? {}).map(([key, value]) => ({ key, value: String(value) })),
    is_active: initial.is_active,
    price_tiers: (initial.price_tiers ?? []).map((t: any) => ({ min_quantity: num(t.min_quantity), price: num(t.price), customer_category: t.customer_category })),
  } : {
    sku: "", barcode: "", name: "", description: "", product_type: "STOCK", category: null, brand: null, unit: defaultUnit?.id ?? null,
    purchase_price: "0", selling_price: "0", tax_rate: defaultTax?.id ?? null, reorder_level: "0", reorder_quantity: "0", track_batches: false,
    track_serials: false, track_expiry: false, variant_of: null, attributes: [], is_active: true, price_tiers: [],
  };
  const keep = (list: any[] | undefined, current: unknown) => (list ?? []).filter((o) => o.is_active || o.id === current);
  const currentImage = !removeImage ? initial?.image : null;

  return (
    <>
      <PageHeader title={initial ? `Edit ${initial.sku}` : "New product"}
        back={initial ? { to: `/inventory/products/${initial.id}`, label: initial.name } : { to: "/inventory/products", label: "Products" }} />
      {locked && (
        <Alert tone="info" title="Stock has been posted for this product" className="mb-4">
          Product type, unit, batch tracking and serial tracking can no longer be changed.
        </Alert>
      )}
      <BaseForm<ProductValues> defaultValues={defaultValues} submitLabel={initial ? "Save changes" : "Create product"} onCancel={() => navigate(-1)}
        errorFieldMap={{ variant_attributes: "attributes" }}
        onSubmit={async (v, form) => {
          let invalid = false;
          const fail = (name: string, message: string) => { form.setError(name as any, { type: "manual", message }); invalid = true; };
          const keys = new Set<string>();
          v.attributes.forEach((a, i) => {
            const key = a.key.trim();
            if (!key && a.value.trim()) fail(`attributes.${i}.key`, "Name the attribute.");
            if (key && keys.has(key.toLowerCase())) fail(`attributes.${i}.key`, "Duplicate attribute.");
            if (key) keys.add(key.toLowerCase());
          });
          const tierKeys = new Set<string>();
          v.price_tiers.forEach((t, i) => {
            if (!(toNumber(t.min_quantity) > 0)) fail(`price_tiers.${i}.min_quantity`, "Must be more than 0.");
            if (t.price === "" || Number.isNaN(Number(t.price)) || Number(t.price) < 0) fail(`price_tiers.${i}.price`, "Enter a price.");
            const k = `${t.customer_category ?? ""}|${Number(t.min_quantity)}`;
            if (tierKeys.has(k)) fail(`price_tiers.${i}.min_quantity`, "Duplicate tier.");
            tierKeys.add(k);
          });
          if (initial && v.variant_of === initial.id) fail("variant_of", "A product cannot be a variant of itself.");
          if (invalid) throw new Error("Correct the highlighted fields.");

          const service = v.product_type === "SERVICE";
          const payload: Record<string, unknown> = {
            sku: v.sku.trim(), barcode: v.barcode.trim(), name: v.name.trim(), description: v.description, product_type: v.product_type,
            category: v.category, brand: v.brand, unit: v.unit, purchase_price: v.purchase_price, selling_price: v.selling_price, tax_rate: v.tax_rate,
            reorder_level: v.reorder_level, reorder_quantity: v.reorder_quantity,
            track_batches: !service && v.track_batches, track_serials: !service && v.track_serials, track_expiry: !service && v.track_batches && v.track_expiry,
            variant_of: v.variant_of,
            variant_attributes: Object.fromEntries(v.attributes.filter((a) => a.key.trim()).map((a) => [a.key.trim(), a.value.trim()])),
            is_active: v.is_active,
            price_tiers: v.price_tiers.map((t) => ({ min_quantity: t.min_quantity, price: t.price, customer_category: t.customer_category })),
          };
          if (removeImage && !image) payload.image = null;
          const { data } = initial ? await api.patch(`/products/${initial.id}/`, payload) : await api.post("/products/", payload);
          if (image) {
            const upload = new FormData();
            upload.append("image", image);
            try { await api.patch(`/products/${data.id}/`, upload); }
            catch (e) { toast.error(`Product saved, but the image was not uploaded: ${errorMessage(e)}`); }
          }
          queryClient.invalidateQueries({ queryKey: ["products"] });
          toast.success(initial ? "Product updated" : `Product ${data.sku} created`);
          navigate(`/inventory/products/${data.id}`);
        }}>
        <TrackingRules />
        <FormSection title="Product" columns={4}>
          <FormField name="name" label="Name" required maxLength={200} span={2} />
          <FormField name="sku" label="SKU" uppercase maxLength={40} hint={initial ? undefined : "Leave blank to number automatically."} />
          <FormField name="barcode" label="Barcode" maxLength={60} />
          <FormField name="product_type" label="Type" type="select" required emptyOption={false} disabled={locked} options={PRODUCT_TYPES} />
          <FormField name="unit" label="Unit" type="select" required disabled={locked}
            options={keep(units, initial?.unit).map((u) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
          <FormField name="category" label="Category" type="select" emptyOption="None"
            options={keep(categories.data, initial?.category).map((c) => ({ value: c.id, label: c.name }))} />
          <FormField name="brand" label="Brand" type="select" emptyOption="None"
            options={keep(brands.data, initial?.brand).map((b) => ({ value: b.id, label: b.name }))} />
          <FormField name="description" label="Description" type="textarea" rows={2} span={4} />
          <FormField name="is_active" label="Status" type="checkbox" hint="Active (available on new documents)" span={2} />
        </FormSection>

        <FormSection title="Pricing and tax" columns={4}>
          <FormField name="selling_price" label="Selling price" type="money" required rules={nonNegative} />
          <FormField name="purchase_price" label="Purchase price" type="money" required rules={nonNegative} hint="Default rate on purchase documents." />
          <FormField name="tax_rate" label="Tax rate" type="select" emptyOption="No tax"
            options={keep(taxes, initial?.tax_rate).map((t) => ({ value: t.id, label: t.name }))} />
          <PriceTiersEditor />
        </FormSection>

        <FormSection title="Stock control" columns={4}>
          <StockControlFields locked={locked} />
        </FormSection>

        <FormSection title="Variant" columns={2}>
          <FormField name="variant_of" label="Variant of" type="entity" resource="products" placeholder="Not a variant"
            hint="Link sizes or colours to a parent product." />
          <AttributesEditor />
        </FormSection>

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
              {initial?.image && !image && (
                <label className="flex items-center gap-2 text-[13px] text-slate-700">
                  <input type="checkbox" className="accent-brand-600" checked={removeImage} onChange={(e) => setRemoveImage(e.target.checked)} /> Remove current image
                </label>
              )}
            </div>
          </div>
        </Panel>
      </BaseForm>
    </>
  );
}

/** Services are never tracked, and expiry tracking requires batches. */
function TrackingRules() {
  const { setValue } = useFormContext<ProductValues>();
  const type = useWatch({ name: "product_type" }) as ProductValues["product_type"];
  const trackBatches = useWatch({ name: "track_batches" }) as boolean;
  useEffect(() => {
    if (type === "SERVICE") { setValue("track_batches", false); setValue("track_serials", false); setValue("track_expiry", false); }
  }, [type, setValue]);
  useEffect(() => { if (!trackBatches) setValue("track_expiry", false); }, [trackBatches, setValue]);
  return null;
}

function StockControlFields({ locked }: { locked: boolean }) {
  const service = useWatch({ name: "product_type" }) === "SERVICE";
  const trackBatches = useWatch({ name: "track_batches" }) as boolean;
  return (
    <>
      <FormField name="reorder_level" label="Reorder level" type="number" disabled={service} rules={nonNegative}
        hint="Flag as low stock at or below this quantity." />
      <FormField name="reorder_quantity" label="Reorder quantity" type="number" disabled={service} rules={nonNegative}
        hint="Suggested quantity to purchase." />
      <div className="space-y-0.5 sm:col-span-2">
        <span className="text-xs font-medium text-slate-600">Tracking</span>
        {service && <p className="text-xs text-slate-500">Services are not stocked, so tracking does not apply.</p>}
        <FormField name="track_batches" label="Batches" type="checkbox" hint="Track batches / lots" disabled={service || locked}
          className={cn((service || locked) && "opacity-60")} />
        <FormField name="track_expiry" label="Expiry" type="checkbox" hint="Track expiry dates (requires batches)" disabled={service || !trackBatches}
          className={cn((service || !trackBatches) && "opacity-60")} />
        <FormField name="track_serials" label="Serial numbers" type="checkbox" hint="Track serial numbers" disabled={service || locked}
          className={cn((service || locked) && "opacity-60")} />
      </div>
    </>
  );
}

function PriceTiersEditor() {
  const { control, formState } = useFormContext<ProductValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "price_tiers" });
  const customerCategories = useOptions<any>("customer-categories");
  const rows = fields.map((f, index) => ({ key: f.id, index }));
  const error = (formState.errors as any).price_tiers?.message as string | undefined;
  return (
    <div className="col-span-full border-t border-line pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-slate-600">Wholesale price tiers</h3>
          <p className="text-xs text-slate-500">The price applies from the minimum quantity upwards; a tier for a customer category takes priority for those customers.</p>
        </div>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append({ min_quantity: "", price: "", customer_category: null })}>Add tier</Button>
      </div>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {rows.length === 0 ? <p className="text-xs text-slate-400">No tiers. The selling price applies to every quantity.</p> : (
        <BaseTable rows={rows} rowKey={(r) => r.key} density="compact" className="max-w-2xl" columns={[
          col.custom("min_quantity", "Minimum quantity", (r) => <CellInput number name={`price_tiers.${r.index}.min_quantity`} label="Minimum quantity" />),
          col.custom("price", "Unit price", (r) => <CellInput number name={`price_tiers.${r.index}.price`} label="Unit price" />),
          col.custom("customer_category", "Customer category", (r) => (
            <CellSelect name={`price_tiers.${r.index}.customer_category`} label="Customer category" emptyOption="All customers"
              options={(customerCategories.data ?? []).map((c: any) => ({ value: c.id, label: c.name }))} />
          )),
          col.custom("remove", "", (r) => <RemoveLineButton label="Remove tier" onClick={() => remove(r.index)} />, { width: 40 }),
        ]} />
      )}
    </div>
  );
}

function AttributesEditor() {
  const { control, formState } = useFormContext<ProductValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "attributes" });
  const variantOf = useWatch({ control, name: "variant_of" });
  const rows = fields.map((f, index) => ({ key: f.id, index }));
  const error = (formState.errors as any).attributes?.message as string | undefined;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">Attributes</span>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append({ key: "", value: "" })}>Add attribute</Button>
      </div>
      {error && <p className="mb-1 text-xs text-red-600">{error}</p>}
      {rows.length === 0 ? <p className="text-xs text-slate-400">{variantOf ? "Add attributes such as Size or Colour." : "None."}</p> : (
        <BaseTable rows={rows} rowKey={(r) => r.key} density="compact" columns={[
          col.custom("key", "Attribute", (r) => <CellInput name={`attributes.${r.index}.key`} label="Attribute name" placeholder="e.g. Size" />),
          col.custom("value", "Value", (r) => <CellInput name={`attributes.${r.index}.value`} label="Attribute value" placeholder="e.g. L" />),
          col.custom("remove", "", (r) => <RemoveLineButton label="Remove attribute" onClick={() => remove(r.index)} />, { width: 40 }),
        ]} />
      )}
    </div>
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
  const { can } = useAuth();
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

  const historyColumns: TableColumn[] = [
    col.date("date", "Date"),
    col.text("movement_number", "Movement", { minWidth: 160, className: "font-medium text-brand-700" }),
    col.text("movement_type_label", "Type", { minWidth: 150 }),
    col.text("warehouse_code", "Warehouse", { minWidth: 100 }),
    col.text("batch_number", "Batch", { minWidth: 100 }),
    col.custom("quantity", "Quantity", (r: any) => (
      <span className={toNumber(r.quantity) < 0 ? "text-red-700" : "text-emerald-700"}>{formatQty(r.quantity)}</span>
    ), { align: "right", minWidth: 90 }),
    rateColumn("unit_cost", "Unit cost"),
    col.money("value", "Value"),
    col.qty("balance_quantity", "Balance"),
    col.custom("reference_number", "Reference", (r: any) => {
      const to = referenceLink(r.reference_type, r.reference_id);
      return to && r.reference_number ? <Link className="link" to={to} onClick={(e) => e.stopPropagation()}>{r.reference_number}</Link> : (r.reference_number || "–");
    }, { minWidth: 150 }),
  ];

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
              <BaseTable rows={warehouses} rowKey={(w) => w.warehouse_id} columns={[
                col.custom("warehouse", "Warehouse", (w) => <>{w.warehouse}{w.is_transit && <Badge tone="amber" className="ml-2">In transit</Badge>}</>),
                col.qty("on_hand", "On hand"),
                col.qty("reserved", "Reserved"),
                col.qty("available", "Available"),
                rateColumn("unit_cost", "Unit cost"),
                col.money("value", "Value"),
              ]} />
            )}
          </Panel>
        )}

        {isStock && (p.track_batches || (stock.data?.batches.length ?? 0) > 0) && (
          <Panel title="Batches in stock">
            {!stock.data?.batches.length ? <p className="p-4 text-xs text-slate-500">No batches in stock.</p> : (
              <BaseTable rows={stock.data.batches} rowKey={(b, i) => `${b.warehouse}-${b.batch}-${i}`} columns={[
                col.text("batch", "Batch", { className: "font-medium" }),
                col.text("warehouse", "Warehouse"),
                col.custom("expiry_date", "Expiry", (b) => <DateText value={b.expiry_date} />),
                col.qty("quantity", "Quantity"),
              ]} />
            )}
          </Panel>
        )}

        <Panel title="Price tiers">
          {!p.price_tiers.length ? <p className="p-4 text-xs text-slate-500">No wholesale tiers. The selling price of {formatAmount(p.selling_price)} applies to every quantity.</p> : (
            <BaseTable rows={p.price_tiers} columns={[
              col.custom("customer_category", "Customer category", (t: any) => categoryName(t.customer_category)),
              col.custom("min_quantity", "From quantity", (t: any) => <>{formatQty(t.min_quantity)} {p.unit_code}</>, { align: "right" }),
              col.money("price", "Unit price"),
              col.custom("diff", "vs. selling price", (t: any) => {
                const base = toNumber(p.selling_price);
                const diff = base ? ((toNumber(t.price) - base) / base) * 100 : 0;
                return <span className="text-slate-500">{base ? `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%` : "–"}</span>;
              }, { align: "right" }),
            ]} />
          )}
        </Panel>

        {isStock && can("inventory.view") && (
          <Panel title="Stock history">
            <DataGrid id="product-history" columns={historyColumns} rows={history.data?.results} total={history.data?.count}
              page={historyPage} pageSize={historySize} onPageChange={setHistoryPage} onPageSizeChange={(s: number) => { setHistorySize(s); setHistoryPage(1); }}
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
