import { useEffect, useMemo, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { BaseForm, FormField, FormGrid, FormSection, useFormContext, useWatch } from "@/components/form";
import { Panel } from "@/components/ui/Page";
import { emptyLine, LineItemsEditor, TotalsPreview, type EditableLine, type TaxRate } from "./LineItemsEditor";
import { computeTotals } from "./pricing";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TradeDocumentFormProps {
  resource: string; // API resource, e.g. "sales-orders"
  detailPath: (id: number) => string;
  party: { field: "customer" | "supplier"; resource: string; label: string };
  dateField: string;
  dateLabel: string;
  secondaryDate?: { field: string; label: string };
  referenceField?: { field: string; label: string; required?: boolean };
  warehouse?: { required: boolean; label?: string; hint?: string };
  priceMode: "sales" | "purchase";
  showTerms?: boolean;
  showCharges?: boolean;
  initial?: any; // existing document when editing
  /** Extra FormFields rendered in the details section (names are API field names). */
  extraFields?: ReactNode;
  extraDefaults?: Record<string, any>;
}

/**
 * Shared create/edit form for orders, direct invoices and direct bills, built on BaseForm.
 * Form field names are the API field names, so server validation errors land on the right field.
 * The server computes every total; the panel on the right is a preview.
 */
export function TradeDocumentForm(props: TradeDocumentFormProps) {
  const { resource, detailPath, party, dateField, dateLabel, secondaryDate, referenceField, warehouse, priceMode, showTerms = true,
    showCharges = true, initial, extraFields, extraDefaults = {} } = props;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const today = todayIn(session?.organization?.timezone);
  const presetParty = searchParams.get(party.field);

  const defaults: Record<string, any> = initial ? {
    [party.field]: initial[party.field], [dateField]: initial[dateField] ?? "",
    ...(secondaryDate ? { [secondaryDate.field]: initial[secondaryDate.field] ?? "" } : {}),
    ...(referenceField ? { [referenceField.field]: initial[referenceField.field] ?? "" } : {}),
    warehouse: initial.warehouse ?? null, freight: initial.freight ?? "0", other_charges: initial.other_charges ?? "0",
    notes: initial.notes ?? "", terms: initial.terms ?? "",
    ...Object.fromEntries(Object.keys(extraDefaults).map((k) => [k, initial[k] ?? extraDefaults[k]])),
    lines: (initial.lines ?? []).map((l: any): EditableLine => ({
      id: l.id, product: l.product, description: l.description ?? "", quantity: l.quantity, unit_price: l.unit_price,
      discount_percent: l.discount_percent ?? "0", tax_rate: l.tax_rate ?? null, unit: l.unit,
    })),
  } : {
    [party.field]: presetParty ? Number(presetParty) : null, [dateField]: today,
    ...(secondaryDate ? { [secondaryDate.field]: "" } : {}), ...(referenceField ? { [referenceField.field]: "" } : {}),
    warehouse: null, freight: "0", other_charges: "0", notes: "", terms: "", ...extraDefaults, lines: [emptyLine()],
  };

  const submit = async (values: Record<string, any>) => {
    const lines = (values.lines as EditableLine[]).filter((l) => l.product);
    if (!lines.length) throw new Error("Add at least one product line.");
    const payload: Record<string, any> = {
      ...values,
      lines: lines.map(({ id: _id, unit: _u, ...l }) => ({ ...l, description: l.description ?? "" })),
    };
    if (!warehouse) delete payload.warehouse;
    if (!showCharges) { delete payload.freight; delete payload.other_charges; }
    if (!showTerms) delete payload.terms;
    if (secondaryDate && !payload[secondaryDate.field]) delete payload[secondaryDate.field];
    const { data } = initial ? await api.patch(`/${resource}/${initial.id}/`, payload) : await api.post(`/${resource}/`, payload);
    queryClient.invalidateQueries({ queryKey: [resource] });
    toast.success(initial ? "Changes saved" : "Draft saved");
    navigate(detailPath(data.id));
  };

  return (
    <BaseForm defaultValues={defaults} onSubmit={submit} submitLabel={initial ? "Save changes" : "Save as draft"} onCancel={() => navigate(-1)}>
      <FormSection title="Details">
        <FormField name={party.field} label={party.label} type="entity" resource={party.resource} params={{ is_active: "true" }} required span={2}
          optionSublabel={(c) => [c.phone, c.tax_id && `PAN ${c.tax_id}`].filter(Boolean).join(" · ")} />
        <FormField name={dateField} label={dateLabel} type="date" required />
        {secondaryDate && <SecondaryDate field={secondaryDate.field} label={secondaryDate.label} minField={dateField} />}
        {warehouse && (
          <FormField name="warehouse" label={warehouse.label ?? "Warehouse"} type="entity" resource="warehouses" params={{ is_active: "true" }}
            required={warehouse.required} hint={warehouse.hint} />
        )}
        {referenceField && <FormField name={referenceField.field} label={referenceField.label} required={referenceField.required} />}
        {extraFields}
      </FormSection>
      <Panel title="Items">
        <LineItemsEditor priceMode={priceMode} customerField={party.field === "customer" ? "customer" : undefined} />
        <div className="flex flex-col gap-4 border-t border-line p-4 md:flex-row md:items-start md:justify-between">
          <FormGrid className="flex-1">
            {showCharges && <>
              <FormField name="freight" label="Freight" type="money" />
              <FormField name="other_charges" label="Other charges" type="money" />
            </>}
            <FormField name="notes" label="Notes" type="textarea" rows={2} span={2} />
            {showTerms && <FormField name="terms" label="Terms and conditions" type="textarea" rows={3} span={2} />}
          </FormGrid>
          <Totals />
        </div>
      </Panel>
      <DefaultTax />
    </BaseForm>
  );
}

function SecondaryDate({ field, label, minField }: { field: string; label: string; minField: string }) {
  const min = useWatch({ name: minField });
  return <FormField name={field} label={label} type="date" min={min || undefined} />;
}

function Totals() {
  const taxes = useOptions<TaxRate>("tax-rates");
  const lines = useWatch({ name: "lines" }) as EditableLine[];
  const freight = useWatch({ name: "freight" });
  const other = useWatch({ name: "other_charges" });
  const totals = useMemo(() => {
    const rate = (id: number | null | undefined) => Number(taxes.data?.find((t) => t.id === id)?.rate ?? 0);
    return computeTotals((lines ?? []).map((l) => ({ ...l, tax_percent: rate(l.tax_rate) })), Number(freight || 0), Number(other || 0));
  }, [lines, freight, other, taxes.data]);
  return <TotalsPreview totals={totals} className="md:w-72" />;
}

/** Applies the organisation's default tax rate to blank new lines once tax rates have loaded. */
function DefaultTax() {
  const { getValues, setValue } = useFormContext();
  const taxes = useOptions<TaxRate>("tax-rates");
  const defaultTax = taxes.data?.find((t) => t.is_default)?.id ?? null;
  useEffect(() => {
    if (!defaultTax) return;
    (getValues("lines") as EditableLine[]).forEach((l, i) => {
      if (l.tax_rate === null && !l.product) setValue(`lines.${i}.tax_rate`, defaultTax);
    });
  }, [defaultTax, getValues, setValue]);
  return null;
}
