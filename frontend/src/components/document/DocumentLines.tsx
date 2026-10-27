import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BaseTable, col, type TableColumn } from "@/components/table";
import { formatAmount, formatQty } from "@/utils/format";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ExtraColumn = TableColumn<any>;

/** Read-only line table for priced documents (orders, invoices, bills, returns). */
export function DocumentLines({ lines, extra = [], showPricing = true }: { lines: any[]; extra?: ExtraColumn[]; showPricing?: boolean }) {
  const columns: TableColumn<any>[] = [
    col.custom("n", "#", (l) => <span className="text-xs text-slate-400">{lines.indexOf(l) + 1}</span>, { width: 32 }),
    col.custom("product_name", "Item", (l) => (
      <>
        <Link to={`/inventory/products/${l.product}`} className="font-medium text-slate-800 hover:text-brand-700">{l.product_name}</Link>
        <div className="text-2xs text-slate-500">
          {l.sku}{l.description ? ` · ${l.description}` : ""}{l.batch_number ? ` · Batch ${l.batch_number}` : ""}
          {l.serial_numbers?.length ? ` · S/N ${l.serial_numbers.join(", ")}` : ""}
        </div>
      </>
    )),
    col.custom("quantity", "Qty", (l) => <>{formatQty(l.quantity)} <span className="text-2xs text-slate-400">{l.unit}</span></>, { align: "right" }),
    ...(showPricing ? [
      col.money("unit_price", "Rate"),
      col.custom("discount_percent", "Disc %", (l) => (Number(l.discount_percent) ? formatQty(l.discount_percent) : "–"), { align: "right" as const }),
      col.money("taxable_amount", "Taxable"),
      col.money("tax_amount", "VAT"),
    ] : []),
    ...extra,
    ...(showPricing ? [col.money("line_total", "Amount", { className: "font-medium" })] : []),
  ];
  return <BaseTable columns={columns} rows={lines} minWidth={760} />;
}

/** Server-calculated totals for a saved document. */
export function DocumentTotals({ doc, children }: { doc: any; children?: ReactNode }) {
  const row = (label: string, value: string | number | null | undefined, strong = false) => (
    <div className={cn("flex justify-between py-0.5", strong ? "font-semibold text-slate-900" : "text-slate-600")}>
      <span>{label}</span><span className="tabular-nums">{formatAmount(value)}</span>
    </div>
  );
  return (
    <div className="ml-auto w-full max-w-xs p-4 text-[13px]">
      {row("Subtotal", doc.subtotal)}
      {Number(doc.discount_total) > 0 && row("Discount", `-${doc.discount_total}`)}
      {row("Taxable amount", doc.taxable_total)}
      {row("VAT", doc.tax_total)}
      {Number(doc.freight) > 0 && row("Freight", doc.freight)}
      {Number(doc.other_charges) > 0 && row("Other charges", doc.other_charges)}
      <div className="mt-1 border-t border-slate-300 pt-1.5">{row("Grand total", doc.grand_total, true)}</div>
      {children}
    </div>
  );
}
