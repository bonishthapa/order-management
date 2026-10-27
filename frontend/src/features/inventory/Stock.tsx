import type { CellClassParams, ICellRendererParams } from "ag-grid-community";
import { FileOutput } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useGet } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { col } from "@/components/data/columns";
import { ResourceList } from "@/components/data/ResourceList";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Page";
import { useUrlState } from "@/hooks/useUrlState";
import { formatAmount, toNumber } from "@/utils/format";
import { MOVEMENT_TYPES, referenceLink } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface StockSummary { total_value: string | number; rows: number; products: number; warehouses: number; low_stock_rows: number }

const BALANCE_FILTER_KEYS = ["search", "warehouse", "product__category", "low_stock", "include_zero", "product"];

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="panel px-4 py-3">
      <div className="kv-label">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${tone === "warn" ? "text-amber-700" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

export function StockOnHandPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [values] = useUrlState();
  const summaryParams = Object.fromEntries(BALANCE_FILTER_KEYS.filter((k) => values[k]).map((k) => [k, values[k]]));
  const summary = useGet<StockSummary>(["inventory/balances", "summary"], "/inventory/balances/summary/", summaryParams);
  const s = summary.data;
  return (
    <>
      <PageHeader title="Stock on hand" subtitle="Current quantity and value per product and warehouse. Values are at FIFO cost."
        actions={<>
          <Button onClick={() => navigate("/inventory/ledger")}>Stock ledger</Button>
          {can("inventory.manage") && <Button icon={<FileOutput className="h-3.5 w-3.5" />} onClick={() => navigate("/inventory/movements/new")}>New adjustment</Button>}
        </>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Stock value" value={summary.isLoading ? <Spinner /> : formatAmount(s?.total_value ?? 0)} />
        <Stat label="Products" value={summary.isLoading ? <Spinner /> : (s?.products ?? 0).toLocaleString()} />
        <Stat label="Warehouses" value={summary.isLoading ? <Spinner /> : (s?.warehouses ?? 0).toLocaleString()} />
        <Stat label="At or below reorder level" value={summary.isLoading ? <Spinner /> : (s?.low_stock_rows ?? 0).toLocaleString()}
          tone={s && s.low_stock_rows > 0 ? "warn" : undefined} />
      </div>
      <ResourceList resource="inventory/balances" gridId="stock-on-hand" searchPlaceholder="SKU, product, barcode…"
        detailPath={(r) => `/inventory/products/${r.product}`}
        exportUrl="/inventory/balances/export/" exportName="stock-on-hand"
        filters={[
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" },
          { type: "entity", name: "product__category", label: "Category", resource: "product-categories" },
          { type: "boolean", name: "low_stock", label: "At or below reorder level" },
          { type: "boolean", name: "include_zero", label: "Include zero stock" },
        ]}
        columns={() => [
          col.text("sku", "SKU", { sortable: true, sortField: "product__sku", pinned: "left", minWidth: 130 } as any),
          col.text("product_name", "Product", { sortable: true, sortField: "product__name", flex: 2, minWidth: 220 } as any),
          col.text("category", "Category"),
          col.text("warehouse_code", "Warehouse", { sortable: true, sortField: "warehouse__code", maxWidth: 130, tooltipField: "warehouse_name" } as any),
          col.text("unit", "Unit", { maxWidth: 80 }),
          col.qty("on_hand", "On hand", {
            sortable: true,
            cellClassRules: { "text-red-700 font-medium": (p: CellClassParams) => !!p.data && toNumber(p.data.reorder_level) > 0 && toNumber(p.data.on_hand) <= toNumber(p.data.reorder_level) },
          }),
          col.qty("reserved", "Reserved", { sortable: true }),
          col.qty("available", "Available"),
          col.qty("reorder_level", "Reorder level"),
          col.money("unit_cost", "Unit cost", { valueFormatter: (p: any) => formatAmount(p.value, 4) }),
          col.money("value", "Value", { sortable: true }),
        ]}
        empty={{ title: "No stock found", description: "Try another warehouse or include zero-stock items." }} />
    </>
  );
}

export function StockLedgerPage() {
  return (
    <>
      <PageHeader title="Stock ledger" back={{ to: "/inventory/movements", label: "Stock movements" }}
        subtitle="Posted stock changes with running balances. Entries are permanent; corrections appear as new movements." />
      <ResourceList resource="inventory/ledger" gridId="stock-ledger" dated searchPlaceholder="SKU, product, movement or reference no.…"
        detailPath={(r) => `/inventory/movements/${r.movement}`}
        exportUrl="/inventory/ledger/export/" exportName="stock-ledger"
        filters={[
          { type: "entity", name: "warehouse", label: "Warehouse", resource: "warehouses" },
          { type: "entity", name: "product", label: "Product", resource: "products" },
          { type: "select", name: "movement_type", label: "Type", options: MOVEMENT_TYPES },
        ]}
        columns={(ctx) => [
          col.date("date", "Date", ctx, { sortable: true }),
          col.text("movement_number", "Movement", { minWidth: 160, cellClass: "font-medium text-brand-700" }),
          col.text("movement_type_label", "Type", { minWidth: 150 }),
          col.text("sku", "SKU", { minWidth: 120 }),
          col.text("product_name", "Product", { flex: 2, minWidth: 200 }),
          col.text("warehouse_code", "Warehouse", { maxWidth: 120 }),
          col.text("batch_number", "Batch", { maxWidth: 130 }),
          col.qty("quantity", "Quantity", {
            sortable: true,
            cellClassRules: { "text-red-700": (p: CellClassParams) => toNumber(p.value) < 0, "text-emerald-700": (p: CellClassParams) => toNumber(p.value) > 0 },
          }),
          col.money("unit_cost", "Unit cost", { valueFormatter: (p: any) => formatAmount(p.value, 4) }),
          col.money("value", "Value", { sortable: true }),
          col.qty("balance_quantity", "Balance qty"),
          col.money("balance_value", "Balance value"),
          col.text("reference_number", "Reference", {
            minWidth: 160,
            cellRenderer: (p: ICellRendererParams) => {
              const to = referenceLink(p.data?.reference_type, p.data?.reference_id);
              return to && p.value ? <Link className="link" to={to} onClick={(e) => e.stopPropagation()}>{p.value}</Link> : (p.value || "–");
            },
          }),
          col.text("created_by_name", "By"),
        ]}
        empty={{ title: "No ledger entries", description: "Nothing was posted for these filters." }} />
    </>
  );
}
