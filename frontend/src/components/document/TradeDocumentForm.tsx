import { useEffect, useMemo, type ReactNode } from "react";
import { Controller, useForm, useWatch, type Control, type UseFormRegister } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { DatePicker } from "@/calendar/DatePicker";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { NumberInput, Textarea } from "@/components/ui/Input";
import { Panel } from "@/components/ui/Page";
import { emptyLine, LineItemsEditor, TotalsPreview, type EditableLine, type TaxRate } from "./LineItemsEditor";
import { computeTotals } from "./pricing";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TradeFormValues {
  party: number | null;
  warehouse: number | null;
  date: string;
  secondary_date: string;
  reference: string;
  freight: string;
  other_charges: string;
  notes: string;
  terms: string;
  extra: Record<string, any>;
  lines: EditableLine[];
}

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
  extraFields?: (ctx: { control: Control<TradeFormValues>; register: UseFormRegister<TradeFormValues> }) => ReactNode;
  toPayload?: (values: TradeFormValues) => Record<string, any>;
}

function fromDocument(doc: any, props: TradeDocumentFormProps): TradeFormValues {
  return {
    party: doc[props.party.field],
    warehouse: doc.warehouse ?? null,
    date: doc[props.dateField] ?? "",
    secondary_date: props.secondaryDate ? doc[props.secondaryDate.field] ?? "" : "",
    reference: props.referenceField ? doc[props.referenceField.field] ?? "" : "",
    freight: doc.freight ?? "0",
    other_charges: doc.other_charges ?? "0",
    notes: doc.notes ?? "",
    terms: doc.terms ?? "",
    extra: {},
    lines: (doc.lines ?? []).map((l: any) => ({
      id: l.id, product: l.product, description: l.description ?? "", quantity: l.quantity, unit_price: l.unit_price,
      discount_percent: l.discount_percent ?? "0", tax_rate: l.tax_rate ?? null, unit: l.unit,
    })),
  };
}

/** Shared create/edit form for orders, direct invoices and direct bills. The server computes every total. */
export function TradeDocumentForm(props: TradeDocumentFormProps) {
  const { resource, detailPath, party, dateField, dateLabel, secondaryDate, referenceField, warehouse, priceMode, showTerms = true,
    showCharges = true, initial, extraFields, toPayload } = props;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const presetParty = searchParams.get(party.field);
  const taxes = useOptions<TaxRate>("tax-rates");
  const today = todayIn(session?.organization?.timezone);
  const defaultTax = taxes.data?.find((t) => t.is_default)?.id ?? null;
  const form = useForm<TradeFormValues>({
    defaultValues: initial ? fromDocument(initial, props) : {
      party: presetParty ? Number(presetParty) : null, warehouse: null, date: today, secondary_date: "", reference: "", freight: "0", other_charges: "0", notes: "", terms: "",
      extra: {}, lines: [emptyLine()],
    },
  });
  const { control, register, handleSubmit, setValue, setError, formState } = form;
  useUnsavedChangesWarning(formState.isDirty && !formState.isSubmitSuccessful);
  useEffect(() => {
    if (!initial && defaultTax) form.getValues("lines").forEach((l, i) => l.tax_rate === null && !l.product && setValue(`lines.${i}.tax_rate`, defaultTax));
  }, [defaultTax]); // apply the default tax to blank lines once rates load

  const watched = useWatch({ control });
  const totals = useMemo(() => {
    const rate = (id: number | null | undefined) => Number(taxes.data?.find((t) => t.id === id)?.rate ?? 0);
    return computeTotals((watched.lines ?? []).map((l: any) => ({ ...l, tax_percent: rate(l.tax_rate) })),
      Number(watched.freight || 0), Number(watched.other_charges || 0));
  }, [watched, taxes.data]);

  const onSubmit = handleSubmit(async (values) => {
    const lines = values.lines.filter((l) => l.product);
    if (!values.party) return setError("party", { message: `Choose a ${party.label.toLowerCase()}.` });
    if (warehouse?.required && !values.warehouse) return setError("warehouse", { message: "Choose a warehouse." });
    if (!lines.length) return toast.error("Add at least one product line.");
    const payload: Record<string, any> = {
      [party.field]: values.party,
      [dateField]: values.date,
      warehouse: values.warehouse,
      notes: values.notes,
      lines: lines.map(({ id: _id, unit: _u, ...l }) => ({ ...l, description: l.description ?? "" })),
      ...(showCharges ? { freight: values.freight || "0", other_charges: values.other_charges || "0" } : {}),
      ...(showTerms ? { terms: values.terms } : {}),
      ...(secondaryDate && values.secondary_date ? { [secondaryDate.field]: values.secondary_date } : {}),
      ...(referenceField ? { [referenceField.field]: values.reference } : {}),
      ...(toPayload ? toPayload(values) : {}),
    };
    if (!warehouse) delete payload.warehouse;
    try {
      const { data } = initial
        ? await api.patch(`/${resource}/${initial.id}/`, payload)
        : await api.post(`/${resource}/`, payload);
      queryClient.invalidateQueries({ queryKey: [resource] });
      toast.success(initial ? "Changes saved" : "Draft saved");
      navigate(detailPath(data.id));
    } catch (e) {
      const errors = fieldErrors(e);
      const map: Record<string, string> = { [party.field]: "party", [dateField]: "date", ...(referenceField ? { [referenceField.field]: "reference" } : {}) };
      Object.entries(errors).forEach(([field, message]) => setError((map[field] ?? field) as any, { message }));
      toast.error(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {formState.errors.root && <Alert tone="error">{formState.errors.root.message}</Alert>}
      <Panel title="Details">
        <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={party.label} required error={formState.errors.party?.message} className="lg:col-span-2">
            <Controller control={control} name="party" render={({ field }) => (
              <EntitySelect resource={party.resource} value={field.value} invalid={!!formState.errors.party} params={{ is_active: "true" }}
                onChange={(id) => field.onChange(id)} sublabel={(c) => [c.phone, c.tax_id && `PAN ${c.tax_id}`].filter(Boolean).join(" · ")} />
            )} />
          </Field>
          <Field label={dateLabel} required error={formState.errors.date?.message}>
            <Controller control={control} name="date" render={({ field }) => (
              <DatePicker value={field.value} onChange={field.onChange} required invalid={!!formState.errors.date} />
            )} />
          </Field>
          {secondaryDate && (
            <Field label={secondaryDate.label} error={(formState.errors as any)[secondaryDate.field]?.message}>
              <Controller control={control} name="secondary_date" render={({ field }) => (
                <DatePicker value={field.value} onChange={field.onChange} min={watched.date || undefined} />
              )} />
            </Field>
          )}
          {warehouse && (
            <Field label={warehouse.label ?? "Warehouse"} required={warehouse.required} hint={warehouse.hint} error={formState.errors.warehouse?.message}>
              <Controller control={control} name="warehouse" render={({ field }) => (
                <EntitySelect resource="warehouses" value={field.value} onChange={(id) => field.onChange(id)} invalid={!!formState.errors.warehouse}
                  params={{ is_active: "true" }} clearable={!warehouse.required} />
              )} />
            </Field>
          )}
          {referenceField && (
            <Field label={referenceField.label} required={referenceField.required} error={formState.errors.reference?.message}>
              <input className="control" {...register("reference", { required: referenceField.required ? "Required" : false })} />
            </Field>
          )}
          {extraFields?.({ control, register })}
        </div>
      </Panel>
      <Panel title="Items">
        <LineItemsEditor control={control as any} register={register as any} setValue={setValue as any} errors={formState.errors as any}
          priceMode={priceMode} customerId={party.field === "customer" ? watched.party : null} />
        <div className="flex flex-col gap-4 border-t border-line p-4 md:flex-row md:items-start md:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            {showCharges && (
              <>
                <Field label="Freight"><NumberInput {...register("freight")} /></Field>
                <Field label="Other charges"><NumberInput {...register("other_charges")} /></Field>
              </>
            )}
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} {...register("notes")} /></Field>
            {showTerms && <Field label="Terms and conditions" className="sm:col-span-2"><Textarea rows={3} {...register("terms")} /></Field>}
          </div>
          <TotalsPreview totals={totals} className="md:w-72" />
        </div>
      </Panel>
      <div className="flex justify-end gap-2">
        <Button onClick={() => navigate(-1)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={formState.isSubmitting}>{initial ? "Save changes" : "Save as draft"}</Button>
      </div>
    </form>
  );
}
