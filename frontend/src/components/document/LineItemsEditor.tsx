import { Plus, Trash2 } from "lucide-react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { CellInput, CellSelect } from "@/components/form/cells";
import { api } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { BaseTable, col } from "@/components/table";
import { Button } from "@/components/ui/Button";
import { cn } from "@/utils/cn";
import { formatAmount } from "@/utils/format";
import { computeLine } from "./pricing";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EditableLine {
  id?: number;
  product: number | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount_percent: string;
  tax_rate: number | null;
  unit?: string;
}

export const emptyLine = (): EditableLine => ({ product: null, description: "", quantity: "1", unit_price: "0", discount_percent: "0", tax_rate: null });

export interface TaxRate { id: number; name: string; rate: string; is_default: boolean; is_active: boolean }

/**
 * Editable product lines inside a BaseForm (field array "lines"). Prices default from the product
 * (sales: wholesale tiers for the customer; purchases: last purchase price); totals here are a preview.
 */
export function LineItemsEditor({ priceMode, customerField }: { priceMode: "sales" | "purchase"; customerField?: string }) {
  const { control, setValue, formState } = useFormContext();
  const customerId = useWatch({ control, name: customerField ?? "__none__" }) as number | null | undefined;
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = (useWatch({ control, name: "lines" }) ?? []) as EditableLine[];
  const taxes = useOptions<TaxRate>("tax-rates");
  const rateOf = (id: number | null) => Number(taxes.data?.find((t) => t.id === id)?.rate ?? 0);
  const lineErrors = ((formState.errors as any).lines ?? []) as any[];
  const disabled = formState.isSubmitting;

  const onProduct = async (index: number, product: any) => {
    setValue(`lines.${index}.product`, product?.id ?? null, { shouldDirty: true });
    if (!product) return;
    setValue(`lines.${index}.unit`, product.unit_code);
    setValue(`lines.${index}.tax_rate`, product.tax_rate ?? null);
    if (priceMode === "purchase") {
      setValue(`lines.${index}.unit_price`, String(product.purchase_price));
    } else {
      const { data } = await api.get(`/products/${product.id}/price/`, { params: { customer: customerId ?? "", quantity: lines[index]?.quantity || "1" } });
      setValue(`lines.${index}.unit_price`, String(data.unit_price));
    }
  };

  const err = (i: number, f: string) => lineErrors[i]?.[f]?.message as string | undefined;
  const rows = fields.map((f, index) => ({ id: f.id, index }));

  return (
    <div>
      <BaseTable
        rows={rows}
        rowKey={(r) => r.id}
        minWidth={920}
        density="compact"
        columns={[
          col.custom("n", "#", (r) => <span className="text-xs text-slate-400">{r.index + 1}</span>, { width: 32 }),
          col.custom("product", "Product", (r) => (
            <>
              <EntitySelect resource="products" value={lines[r.index]?.product ?? null} disabled={disabled} invalid={!!err(r.index, "product")}
                params={{ is_active: "true" }} onChange={(_, item) => onProduct(r.index, item)}
                sublabel={(p) => `${p.unit_code}${p.product_type === "STOCK" ? ` · on hand ${Number(p.on_hand ?? 0)}` : " · service"}`} />
              {err(r.index, "product") && <p className="mt-0.5 text-2xs text-red-600">{err(r.index, "product")}</p>}
            </>
          ), { minWidth: 260 }),
          col.custom("description", "Description", (r) => <CellInput name={`lines.${r.index}.description`} label="Description" placeholder="Optional" disabled={disabled} />),
          col.custom("quantity", "Qty", (r) => (
            <div className="flex items-start gap-1">
              <div className="flex-1"><CellInput number name={`lines.${r.index}.quantity`} label="Quantity" disabled={disabled} /></div>
              {lines[r.index]?.unit && <span className="pt-2 text-2xs text-slate-400">{lines[r.index].unit}</span>}
            </div>
          ), { width: 110, align: "right" }),
          col.custom("unit_price", "Rate", (r) => (
            <CellInput number name={`lines.${r.index}.unit_price`} label="Rate" disabled={disabled} />
          ), { width: 120, align: "right" }),
          col.custom("discount_percent", "Disc %", (r) => (
            <CellInput number name={`lines.${r.index}.discount_percent`} label="Discount percent" disabled={disabled} />
          ), { width: 80, align: "right" }),
          col.custom("tax_rate", "Tax", (r) => (
            <CellSelect name={`lines.${r.index}.tax_rate`} label="Tax rate" disabled={disabled} emptyOption="No tax"
              options={(taxes.data ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.name }))} />
          ), { width: 130 }),
          col.custom("amount", "Amount", (r) => {
            const line = lines[r.index] ?? emptyLine();
            return <span className="tabular-nums">{formatAmount(computeLine({ ...line, tax_percent: rateOf(line.tax_rate) }).total)}</span>;
          }, { width: 120, align: "right", className: "pt-3" }),
          col.custom("remove", "", (r) => (
            <Button variant="ghost" size="sm" aria-label={`Remove line ${r.index + 1}`} disabled={disabled || fields.length === 1}
              onClick={() => remove(r.index)}><Trash2 className="h-3.5 w-3.5" /></Button>
          ), { width: 40 }),
        ]}
      />
      <div className={cn("px-2 py-2", disabled && "hidden")}>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyLine())}>Add line</Button>
      </div>
    </div>
  );
}

export function TotalsPreview({ totals, className, note = "Preview – final totals are calculated when you save." }: {
  totals: { subtotal: number; discount: number; taxable: number; tax: number; freight: number; other: number; grand: number };
  className?: string; note?: string;
}) {
  const rows: [string, number][] = [["Subtotal", totals.subtotal], ["Discount", -totals.discount], ["Taxable amount", totals.taxable],
    ["VAT", totals.tax], ["Freight", totals.freight], ["Other charges", totals.other]];
  return (
    <div className={cn("w-full max-w-xs text-[13px]", className)}>
      {rows.filter(([label, v]) => v !== 0 || label === "Taxable amount" || label === "VAT").map(([label, v]) => (
        <div key={label} className="flex justify-between py-0.5 text-slate-600"><span>{label}</span><span className="tabular-nums">{formatAmount(v)}</span></div>
      ))}
      <div className="mt-1 flex justify-between border-t border-slate-300 pt-1.5 text-sm font-semibold text-slate-900">
        <span>Grand total</span><span className="tabular-nums">{formatAmount(totals.grand)}</span>
      </div>
      {note && <p className="mt-1 text-2xs text-slate-400">{note}</p>}
    </div>
  );
}
