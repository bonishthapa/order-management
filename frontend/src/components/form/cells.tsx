import { useFormContext, useWatch } from "react-hook-form";
import { DatePicker } from "@/calendar/DatePicker";
import { EntitySelect } from "@/components/forms/EntitySelect";
import type { Params } from "@/api/hooks";
import { AllocationTable, type OpenDocument } from "@/components/document/AllocationTable";
import { Alert } from "@/components/ui/Feedback";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Label-less controls bound to a BaseForm field path, for editable BaseTable cells (line quantities, batches,
 * counted quantities...). Each cell shows its own server/validation error under the control.
 */
function useCell(name: string) {
  const { setValue, formState } = useFormContext();
  const value = useWatch({ name });
  const error = name.split(".").reduce((e: any, k) => e?.[k], formState.errors)?.message as string | undefined;
  return { value, error, set: (v: unknown) => setValue(name, v, { shouldDirty: true, shouldValidate: !!error }) };
}

const CellError = ({ error }: { error?: string }) => (error ? <p className="mt-0.5 text-2xs text-red-600">{error}</p> : null);

export function CellInput({ name, label, number, placeholder, disabled, invalid, onKeyDown, list }: {
  name: string; label: string; number?: boolean; placeholder?: string; disabled?: boolean; invalid?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>; list?: string;
}) {
  const { value, error, set } = useCell(name);
  const Control = number ? NumberInput : Input;
  return (
    <>
      <Control aria-label={label} value={value ?? ""} placeholder={placeholder} disabled={disabled} invalid={invalid || !!error}
        onKeyDown={onKeyDown} list={list} onChange={(e) => set(e.target.value)} />
      <CellError error={error} />
    </>
  );
}

export function CellTextarea({ name, label, placeholder, rows = 2, disabled }: {
  name: string; label: string; placeholder?: string; rows?: number; disabled?: boolean;
}) {
  const { value, error, set } = useCell(name);
  return (
    <>
      <Textarea aria-label={label} rows={rows} value={value ?? ""} placeholder={placeholder} disabled={disabled} invalid={!!error}
        onChange={(e) => set(e.target.value)} />
      <CellError error={error} />
    </>
  );
}

export function CellCheckbox({ name, label, disabled }: { name: string; label: string; disabled?: boolean }) {
  const { value, set } = useCell(name);
  return <input type="checkbox" aria-label={label} className="h-3.5 w-3.5 accent-brand-600" checked={!!value} disabled={disabled}
    onChange={(e) => set(e.target.checked)} />;
}

export function CellSelect({ name, label, options, emptyOption, disabled }: {
  name: string; label: string; options: { value: string | number; label: string }[]; emptyOption?: string; disabled?: boolean;
}) {
  const { value, error, set } = useCell(name);
  return (
    <>
      <Select aria-label={label} value={value ?? ""} disabled={disabled} invalid={!!error}
        onChange={(e) => {
          const option = options.find((o) => String(o.value) === e.target.value);
          set(e.target.value === "" ? null : option ? option.value : e.target.value);
        }}>
        {emptyOption !== undefined && <option value="">{emptyOption}</option>}
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </Select>
      <CellError error={error} />
    </>
  );
}

export function CellDate({ name, min, max, disabled }: { name: string; min?: string; max?: string; disabled?: boolean }) {
  const { value, error, set } = useCell(name);
  return (
    <>
      <DatePicker value={value ?? ""} compact min={min || undefined} max={max || undefined} disabled={disabled} invalid={!!error}
        onChange={(v) => set(v)} />
      <CellError error={error} />
    </>
  );
}

export function CellEntity({ name, label, resource, params, optionLabel, optionSublabel, disabled, clearable = true, onValueChange }: {
  name: string; label: string; resource: string; params?: Params; optionLabel?: (item: any) => React.ReactNode;
  optionSublabel?: (item: any) => React.ReactNode; disabled?: boolean; clearable?: boolean; onValueChange?: (id: number | null, item: any) => void;
}) {
  const { value, error, set } = useCell(name);
  return (
    <>
      <EntitySelect resource={resource} params={params} value={value ?? null} disabled={disabled} invalid={!!error} clearable={clearable}
        label={optionLabel} sublabel={optionSublabel} placeholder={label}
        onChange={(id, item) => { set(id); onValueChange?.(id, item); }} />
      <CellError error={error} />
    </>
  );
}

/** AllocationTable bound to a ``Record<documentId, amount>`` form value; errors on ``name`` show above it. */
export function AllocationField({ name, documents, available }: { name: string; documents: OpenDocument[]; available: number }) {
  const { setValue, formState } = useFormContext();
  const allocations: Record<number, string> = useWatch({ name }) ?? {};
  const error = (formState.errors as any)[name]?.message as string | undefined;
  return (
    <>
      {error && <Alert tone="error" className="m-4">{error}</Alert>}
      <AllocationTable documents={documents} allocations={allocations} available={available}
        onChange={(next) => setValue(name, next, { shouldDirty: true })} />
    </>
  );
}
