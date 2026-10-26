import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatAmount, formatQty } from "@/utils/format";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ExtraColumn { key: string; label: string; render?: (line: any) => ReactNode; align?: "right" }

/** Read-only line table for priced documents (orders, invoices, bills, returns). */
export function DocumentLines({ lines, extra = [], showPricing = true }: { lines: any[]; extra?: ExtraColumn[]; showPricing?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
          <tr>
            <th className="w-8 px-3 py-2">#</th>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2 text-right">Qty</th>
            {showPricing && <>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Disc %</th>
              <th className="px-3 py-2 text-right">Taxable</th>
              <th className="px-3 py-2 text-right">VAT</th>
            </>}
            {extra.map((c) => <th key={c.key} className={cn("px-3 py-2", c.align === "right" && "text-right")}>{c.label}</th>)}
            {showPricing && <th className="px-3 py-2 text-right">Amount</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={line.id ?? i} className="border-b border-line last:border-0">
              <td className="px-3 py-2 text-xs text-slate-400">{i + 1}</td>
              <td className="px-3 py-2">
                <Link to={`/inventory/products/${line.product}`} className="font-medium text-slate-800 hover:text-brand-700">{line.product_name}</Link>
                <div className="text-2xs text-slate-500">
                  {line.sku}{line.description ? ` · ${line.description}` : ""}{line.batch_number ? ` · Batch ${line.batch_number}` : ""}
                  {line.serial_numbers?.length ? ` · S/N ${line.serial_numbers.join(", ")}` : ""}
                </div>
              </td>
              <td className="num px-3 py-2">{formatQty(line.quantity)} <span className="text-2xs text-slate-400">{line.unit}</span></td>
              {showPricing && <>
                <td className="num px-3 py-2">{formatAmount(line.unit_price)}</td>
                <td className="num px-3 py-2">{Number(line.discount_percent) ? formatQty(line.discount_percent) : "–"}</td>
                <td className="num px-3 py-2">{formatAmount(line.taxable_amount)}</td>
                <td className="num px-3 py-2">{formatAmount(line.tax_amount)}</td>
              </>}
              {extra.map((c) => <td key={c.key} className={cn("px-3 py-2", c.align === "right" && "num")}>{c.render ? c.render(line) : line[c.key]}</td>)}
              {showPricing && <td className="num px-3 py-2 font-medium">{formatAmount(line.line_total)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
