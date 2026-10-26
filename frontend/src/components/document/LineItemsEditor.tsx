import { Plus, Trash2 } from "lucide-react";
import { useFieldArray, useWatch, type Control, type UseFormRegister, type UseFormSetValue, type FieldErrors } from "react-hook-form";
import { api } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Button } from "@/components/ui/Button";
import { NumberInput, Input, Select } from "@/components/ui/Input";
import { formatAmount } from "@/utils/format";
import { cn } from "@/utils/cn";
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
 * Editable product lines. Prices default from the product (sales: wholesale tiers for the customer;
 * purchases: last purchase price) and can be changed; totals here are a preview only.
 */
export function LineItemsEditor({ control, register, setValue, errors, priceMode, customerId, disabled }: {
  control: Control<any>; register: UseFormRegister<any>; setValue: UseFormSetValue<any>; errors?: FieldErrors<any>;
  priceMode: "sales" | "purchase"; customerId?: number | null; disabled?: boolean;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = (useWatch({ control, name: "lines" }) ?? []) as EditableLine[];
  const taxes = useOptions<TaxRate>("tax-rates");
  const rateOf = (id: number | null) => Number(taxes.data?.find((t) => t.id === id)?.rate ?? 0);
  const lineErrors = (errors?.lines ?? []) as any[];

  const onProduct = async (index: number, product: any) => {
    setValue(`lines.${index}.product`, product?.id ?? null, { shouldDirty: true });
    if (!product) return;
    setValue(`lines.${index}.unit`, product.unit_code);
    setValue(`lines.${index}.tax_rate`, product.tax_rate ?? null);
    if (priceMode === "purchase") {
      setValue(`lines.${index}.unit_price`, String(product.purchase_price));
    } else {
      const qty = lines[index]?.quantity || "1";
      const { data } = await api.get(`/products/${product.id}/price/`, { params: { customer: customerId ?? "", quantity: qty } });
      setValue(`lines.${index}.unit_price`, String(data.unit_price));
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-[13px]">
        <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
          <tr>
            <th className="w-8 px-2 py-2">#</th>
            <th className="min-w-[260px] px-2 py-2">Product</th>
            <th className="px-2 py-2">Description</th>
            <th className="w-24 px-2 py-2 text-right">Qty</th>
            <th className="w-28 px-2 py-2 text-right">Rate</th>
            <th className="w-20 px-2 py-2 text-right">Disc %</th>
            <th className="w-32 px-2 py-2">Tax</th>
            <th className="w-32 px-2 py-2 text-right">Amount</th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {fields.map((field, index) => {
            const line = lines[index] ?? emptyLine();
            const preview = computeLine({ ...line, tax_percent: rateOf(line.tax_rate) });
            const err = lineErrors[index] ?? {};
            return (
              <tr key={field.id} className="border-b border-line align-top">
                <td className="px-2 py-1.5 pt-3 text-xs text-slate-400">{index + 1}</td>
                <td className="px-2 py-1.5">
                  <EntitySelect resource="products" value={line.product} disabled={disabled} invalid={!!err.product}
                    params={{ is_active: "true" }} onChange={(_, item) => onProduct(index, item)}
                    sublabel={(p) => `${p.unit_code}${p.product_type === "STOCK" ? ` · on hand ${Number(p.on_hand ?? 0)}` : " · service"}`} />
                  {err.product && <p className="mt-0.5 text-2xs text-red-600">{err.product.message}</p>}
                </td>
                <td className="px-2 py-1.5"><Input disabled={disabled} {...register(`lines.${index}.description`)} placeholder="Optional" /></td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <NumberInput disabled={disabled} invalid={!!err.quantity} {...register(`lines.${index}.quantity`)} aria-label="Quantity" />
                    {line.unit && <span className="text-2xs text-slate-400">{line.unit}</span>}
                  </div>
                  {err.quantity && <p className="mt-0.5 text-2xs text-red-600">{err.quantity.message}</p>}
                </td>
                <td className="px-2 py-1.5"><NumberInput disabled={disabled} invalid={!!err.unit_price} {...register(`lines.${index}.unit_price`)} aria-label="Rate" /></td>
                <td className="px-2 py-1.5"><NumberInput disabled={disabled} {...register(`lines.${index}.discount_percent`)} aria-label="Discount percent" /></td>
                <td className="px-2 py-1.5">
                  <Select disabled={disabled} aria-label="Tax rate" value={line.tax_rate ?? ""}
                    onChange={(e) => setValue(`lines.${index}.tax_rate`, e.target.value ? Number(e.target.value) : null, { shouldDirty: true })}>
                    <option value="">No tax</option>
                    {taxes.data?.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </td>
                <td className="num px-2 py-1.5 pt-3 tabular-nums">{formatAmount(preview.total)}</td>
                <td className="px-1 py-1.5">
                  <Button variant="ghost" size="sm" aria-label={`Remove line ${index + 1}`} disabled={disabled || fields.length === 1}
                    onClick={() => remove(index)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!disabled && (
        <div className="px-2 py-2">
          <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append(emptyLine())}>Add line</Button>
        </div>
      )}
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
