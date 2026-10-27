import { useEffect } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useOptions } from "@/api/hooks";
import { FormField } from "./FormField";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Method { id: number; name: string; default_account: number | null; requires_reference: boolean; is_active: boolean }
interface Account { id: number; code: string; name: string; is_cash: boolean; is_bank: boolean }

/**
 * Payment method + cash/bank account (+ reference) fields for a BaseForm. Choosing a method preselects its
 * default account and makes the reference required when the method needs one.
 */
export function PaymentMethodFields({ methodField = "payment_method", accountField, accountLabel = "Cash / bank account",
  referenceField = "reference" }: { methodField?: string; accountField: string; accountLabel?: string; referenceField?: string | false }) {
  const { setValue, getValues } = useFormContext();
  const methods = useOptions<Method>("payment-methods");
  const accounts = useOptions<Account>("accounts", { is_group: "false", is_active: "true" });
  const method = useWatch({ name: methodField });
  const selected = methods.data?.find((m) => m.id === method);

  useEffect(() => {
    if (!getValues(methodField) && methods.data?.length) {
      const first = methods.data.find((m) => m.is_active);
      if (first) {
        setValue(methodField, first.id);
        if (!getValues(accountField) && first.default_account) setValue(accountField, first.default_account);
      }
    }
  }, [methods.data, getValues, setValue, methodField, accountField]);

  return (
    <>
      <FormField name={methodField} label="Payment method" type="select" required
        options={(methods.data ?? []).filter((m) => m.is_active).map((m) => ({ value: m.id, label: m.name }))}
        onValueChange={(id) => {
          const m = methods.data?.find((x) => x.id === id);
          if (m?.default_account) setValue(accountField, m.default_account, { shouldDirty: true });
        }} />
      <FormField name={accountField} label={accountLabel} type="select" required
        options={(accounts.data ?? []).filter((a) => a.is_cash || a.is_bank).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} />
      {referenceField && (
        <FormField name={referenceField} label="Transaction reference" required={!!selected?.requires_reference}
          hint="Cheque, transfer or wallet reference." />
      )}
    </>
  );
}
