import type { ReactNode } from "react";
import { Controller, useFormContext, type RegisterOptions } from "react-hook-form";
import { DatePicker } from "@/calendar/DatePicker";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
import type { Params } from "@/api/hooks";
import { cn } from "@/utils/cn";
import { useFormMeta } from "./BaseForm";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FormFieldType =
  | "text" | "email" | "password" | "tel" | "number" | "money" | "percent" | "textarea" | "select" | "checkbox" | "date" | "entity" | "custom";

export interface FormFieldProps {
  name: string;
  label: ReactNode;
  type?: FormFieldType;
  required?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  /** Grid span inside FormSection / FormGrid (1–4, or "full"). */
  span?: 1 | 2 | 3 | 4 | "full";
  /** select */
  options?: { value: string | number; label: string }[];
  emptyOption?: string | false;
  /** entity */
  resource?: string;
  params?: Params;
  optionLabel?: (item: any) => ReactNode;
  optionSublabel?: (item: any) => ReactNode;
  clearable?: boolean;
  /** Label to show for an entity value before its record has loaded. */
  initialLabel?: string;
  /** date */
  min?: string;
  max?: string;
  /** textarea */
  rows?: number;
  maxLength?: number;
  /** text: force upper case (codes). */
  uppercase?: boolean;
  /** number/money suffix shown inside the label, e.g. "%". */
  suffix?: string;
  autoFocus?: boolean;
  rules?: RegisterOptions;
  /** Called after the value changes (e.g. to fill dependent fields). */
  onValueChange?: (value: any, item?: any) => void;
  /** type "custom": render any control bound to the field. */
  render?: (field: { value: any; onChange: (v: any) => void; onBlur: () => void; invalid: boolean; disabled: boolean }) => ReactNode;
  className?: string;
}

const SPAN = { 1: "", 2: "sm:col-span-2", 3: "sm:col-span-2 lg:col-span-3", 4: "sm:col-span-2 lg:col-span-4", full: "col-span-full" };
const NUMBER = /^-?\d*(\.\d*)?$/;

/** One field of a BaseForm: label, control, required marker, validation and server error in one place. */
export function FormField(props: FormFieldProps) {
  const { name, label, type = "text", required, hint, placeholder, span = 1, options = [], emptyOption = "Choose…", resource, params,
    optionLabel, optionSublabel, clearable, initialLabel, min, max, rows = 3, maxLength, uppercase, suffix, autoFocus, rules, onValueChange, render,
    className } = props;
  const { control, formState } = useFormContext();
  const meta = useFormMeta();
  const disabled = props.disabled || meta.disabled;
  const error = name.split(".").reduce((e: any, k) => e?.[k], formState.errors)?.message as string | undefined;
  const id = `f-${name.replace(/\./g, "-")}`;
  const validation = {
    ...(required ? { validate: (v: any) => (type === "checkbox" || (v !== null && v !== undefined && String(v).trim() !== "")) || "Required" } : {}),
    ...(["number", "money", "percent"].includes(type) ? { pattern: { value: NUMBER, message: "Enter a number" } } : {}),
    ...(maxLength ? { maxLength: { value: maxLength, message: `At most ${maxLength} characters` } } : {}),
    ...rules,
  };

  const control_ = (
    <Controller name={name} control={control} rules={validation as any} render={({ field }) => {
      const change = (v: any, item?: any) => { field.onChange(v); onValueChange?.(v, item); };
      const invalid = !!error;
      switch (type) {
        case "textarea":
          return <Textarea id={id} rows={rows} value={field.value ?? ""} onChange={(e) => change(e.target.value)} onBlur={field.onBlur}
            placeholder={placeholder} disabled={disabled} invalid={invalid} maxLength={maxLength} />;
        case "number": case "money": case "percent":
          return <NumberInput id={id} value={field.value ?? ""} onChange={(e) => change(e.target.value)} onBlur={field.onBlur}
            placeholder={placeholder} disabled={disabled} invalid={invalid} autoFocus={autoFocus} />;
        case "select":
          return (
            <Select id={id} value={field.value ?? ""} disabled={disabled} invalid={invalid} onBlur={field.onBlur}
              onChange={(e) => {
                const raw = e.target.value;
                const option = options.find((o) => String(o.value) === raw);
                change(option ? option.value : raw === "" ? null : raw);
              }}>
              {emptyOption !== false && <option value="">{emptyOption}</option>}
              {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
            </Select>
          );
        case "checkbox":
          return (
            <label className="flex h-8 cursor-pointer items-center gap-2 text-[13px] text-slate-700">
              <input id={id} type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={!!field.value} disabled={disabled}
                onChange={(e) => change(e.target.checked)} />
              {hint && typeof hint === "string" ? hint : label}
            </label>
          );
        case "date":
          return <DatePicker id={id} value={field.value ?? ""} onChange={(v) => change(v)} onBlur={field.onBlur} required={required}
            invalid={invalid} disabled={disabled} min={min} max={max} placeholder={placeholder} />;
        case "entity":
          return <EntitySelect id={id} resource={resource!} params={params} value={field.value ?? null} invalid={invalid} disabled={disabled}
            clearable={clearable ?? !required} initialLabel={initialLabel} label={optionLabel} sublabel={optionSublabel} placeholder={placeholder}
            onChange={(v, item) => change(v, item)} />;
        case "custom":
          return <>{render?.({ value: field.value, onChange: change, onBlur: field.onBlur, invalid, disabled })}</>;
        default:
          return <Input id={id} type={type} value={field.value ?? ""} placeholder={placeholder} disabled={disabled} invalid={invalid}
            autoFocus={autoFocus} maxLength={maxLength} onBlur={field.onBlur}
            onChange={(e) => change(uppercase ? e.target.value.toUpperCase() : e.target.value)} />;
      }
    }} />
  );

  if (type === "checkbox") {
    return (
      <Field label={hint && typeof hint === "string" ? label : <span className="sr-only">{label}</span>} htmlFor={id} error={error}
        className={cn(SPAN[span], className)}>
        {control_}
      </Field>
    );
  }
  return (
    <Field label={<>{label}{suffix && <span className="ml-1 text-slate-400">({suffix})</span>}</>} htmlFor={id} required={required}
      error={error} hint={hint} className={cn(SPAN[span], className)}>
      {control_}
    </Field>
  );
}
