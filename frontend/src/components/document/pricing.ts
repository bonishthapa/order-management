import { round2, toNumber } from "@/utils/format";

export interface PricedLineInput {
  quantity: string | number;
  unit_price: string | number;
  discount_percent?: string | number;
  tax_percent?: number;
}

/** Client-side preview of the server calculation (apps/core/documents.py). The server result is authoritative. */
export function computeLine(line: PricedLineInput) {
  const gross = round2(toNumber(line.quantity) * toNumber(line.unit_price));
  const discount = round2((gross * toNumber(line.discount_percent)) / 100);
  const taxable = round2(gross - discount);
  const tax = round2((taxable * (line.tax_percent ?? 0)) / 100);
  return { gross, discount, taxable, tax, total: round2(taxable + tax) };
}

export function computeTotals(lines: PricedLineInput[], freight = 0, other = 0) {
  const parts = lines.map(computeLine);
  const sum = (k: keyof ReturnType<typeof computeLine>) => round2(parts.reduce((a, p) => a + p[k], 0));
  const taxable = sum("taxable");
  const tax = sum("tax");
  return { subtotal: sum("gross"), discount: sum("discount"), taxable, tax, freight, other, grand: round2(taxable + tax + freight + other) };
}
