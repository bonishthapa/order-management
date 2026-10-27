import { zodResolver } from "@hookform/resolvers/zod";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { FormProvider, useForm, type DefaultValues, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import type { ZodType } from "zod";
import { toast } from "sonner";
import { errorMessage, fieldErrors } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Feedback";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { cn } from "@/utils/cn";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BaseFormProps<T extends FieldValues> {
  defaultValues: DefaultValues<T>;
  /** Optional zod schema; FormField ``required`` rules apply as well. */
  schema?: ZodType<any>;
  /** Submit handler. Throw (e.g. a failed API call) to show field and form errors automatically.
   *  ``intent`` is the key of the submit action used (see ``submitActions``), "submit" by default. */
  onSubmit: (values: T, form: UseFormReturn<T>, intent: string) => Promise<unknown> | unknown;
  /** Several submit buttons with different intents, e.g. [{ key: "draft", label: "Save draft" }, { key: "post", label: "Post", primary: true }]. */
  submitActions?: { key: string; label: string; primary?: boolean }[];
  children: ReactNode | ((form: UseFormReturn<T>) => ReactNode);
  /** Maps API field names to form field names when they differ (e.g. ``{ deposit_account: "account" }``). */
  errorFieldMap?: Record<string, string>;
  submitLabel?: string;
  /** Renders a Cancel button; omit to hide. */
  onCancel?: () => void;
  /** Extra buttons next to Cancel/Submit. */
  extraActions?: ReactNode;
  /** "page" renders the action bar under the form; "none" leaves actions to the caller (FormDialog). */
  actions?: "page" | "none";
  /** Warn before leaving with unsaved edits (default on for page forms). */
  warnUnsaved?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Called with the form instance (e.g. to watch values from the parent). */
  formRef?: (form: UseFormReturn<T>) => void;
}

interface FormMeta { disabled: boolean }
const FormMetaContext = createContext<FormMeta>({ disabled: false });
export const useFormMeta = () => useContext(FormMetaContext);

/**
 * The application's only form wrapper. Every create/edit screen and dialog form uses it, so validation,
 * server-error display, submit state and unsaved-change protection behave the same everywhere.
 */
export function BaseForm<T extends FieldValues>({
  defaultValues, schema, onSubmit, children, errorFieldMap = {}, submitLabel = "Save", onCancel, extraActions, actions = "page",
  warnUnsaved, disabled = false, id, className, formRef, submitActions,
}: BaseFormProps<T>) {
  const generatedId = useId();
  const form = useForm<T>({ defaultValues, resolver: schema ? zodResolver(schema) : undefined, mode: "onTouched" });
  const { handleSubmit, setError, formState } = form;
  useUnsavedChangesWarning((warnUnsaved ?? actions === "page") && formState.isDirty && !formState.isSubmitSuccessful);
  useEffect(() => formRef?.(form), [form, formRef]);

  const intent = useRef("submit");
  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(values, form, intent.current);
    } catch (error) {
      const errors = fieldErrors(error);
      const known = new Set(Object.keys(form.getValues() ?? {}));
      let unmatched = false;
      for (const [field, message] of Object.entries(errors)) {
        const name = errorFieldMap[field] ?? field;
        const top = name.split(".")[0];
        if (known.has(top)) setError(name as Path<T>, { type: "server", message });
        else unmatched = true;
      }
      if (!Object.keys(errors).length || unmatched) setError("root.server" as any, { type: "server", message: errorMessage(error) });
      toast.error(errorMessage(error));
      throw error; // keeps isSubmitSuccessful false
    }
  });

  return (
    <FormProvider {...form}>
      <FormMetaContext.Provider value={{ disabled }}>
        <form id={id ?? generatedId} noValidate className={cn("space-y-4", className)}
          onSubmit={(e) => {
            // A FormDialog opened from inside a page form is portalled out of the DOM but still inside the
            // React tree, so its submit event would bubble to the outer form. Stop it here.
            e.stopPropagation();
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (submitter?.name === "intent" && submitter.value) intent.current = submitter.value;
            submit(e).catch(() => undefined);
          }}>
          {formState.errors.root?.server?.message && <Alert tone="error">{formState.errors.root.server.message}</Alert>}
          <fieldset disabled={disabled || formState.isSubmitting} className="m-0 min-w-0 space-y-4 border-0 p-0">
            {typeof children === "function" ? children(form) : children}
          </fieldset>
          {actions === "page" && (
            <div className="flex justify-end gap-2">
              {onCancel && <Button onClick={onCancel}>Cancel</Button>}
              {extraActions}
              {!disabled && (submitActions ?? [{ key: "submit", label: submitLabel, primary: true }]).map((a) => (
                <Button key={a.key} type="submit" variant={a.primary ? "primary" : "secondary"}
                  loading={formState.isSubmitting && intent.current === a.key} disabled={formState.isSubmitting}
                  onClick={() => { intent.current = a.key; }}>{a.label}</Button>
              ))}
            </div>
          )}
        </form>
      </FormMetaContext.Provider>
    </FormProvider>
  );
}
