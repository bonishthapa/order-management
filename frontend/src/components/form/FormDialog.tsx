import { useId, type ReactNode } from "react";
import type { FieldValues } from "react-hook-form";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { BaseForm, type BaseFormProps } from "./BaseForm";

/** A BaseForm inside a dialog: the footer holds Cancel and the submit button. Closes after a successful submit. */
export function FormDialog<T extends FieldValues>({ open, onOpenChange, title, description, size = "md", submitLabel = "Save",
  closeOnSuccess = true, onSubmit, footerActions, ...formProps }: Omit<BaseFormProps<T>, "actions" | "onCancel" | "id"> & {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; size?: "sm" | "md" | "lg" | "xl";
  closeOnSuccess?: boolean;
  /** Extra buttons in the dialog footer, left of Cancel (e.g. secondary account actions). */
  footerActions?: ReactNode;
}) {
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size={size}
      footer={<>
        {footerActions && <div className="mr-auto flex gap-2">{footerActions}</div>}
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        {!formProps.disabled && (formProps.submitActions ?? [{ key: "submit", label: submitLabel, primary: true }]).map((a) => (
          <Button key={a.key} type="submit" form={id} name="intent" value={a.key} variant={a.primary ? "primary" : "secondary"}>{a.label}</Button>
        ))}
      </>}>
      {open && (
        <BaseForm<T> {...formProps} id={id} actions="none" warnUnsaved={false}
          onSubmit={async (values, form, intent) => {
            const result = await onSubmit(values, form, intent);
            if (closeOnSuccess) onOpenChange(false);
            return result;
          }} />
      )}
    </Dialog>
  );
}
