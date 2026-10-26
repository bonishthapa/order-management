import { useEffect } from "react";
import { useOptions } from "@/api/hooks";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Input";

interface Method { id: number; name: string; kind: string; default_account: number | null; requires_reference: boolean; is_active: boolean }
interface Account { id: number; code: string; name: string; is_cash: boolean; is_bank: boolean; is_active: boolean; is_group: boolean }

/** Payment method + cash/bank account pair. Choosing a method preselects its default account. */
export function PaymentFields({ method, account, onMethod, onAccount, accountLabel = "Cash / bank account", errors = {} }: {
  method: number | null; account: number | null; onMethod: (id: number | null) => void; onAccount: (id: number | null) => void;
  accountLabel?: string; errors?: { method?: string; account?: string };
}) {
  const methods = useOptions<Method>("payment-methods");
  const accounts = useOptions<Account>("accounts", { is_group: "false", is_active: "true" });
  const cashBank = (accounts.data ?? []).filter((a) => a.is_cash || a.is_bank);
  useEffect(() => {
    if (!method && methods.data?.length) {
      const first = methods.data.find((m) => m.is_active);
      if (first) { onMethod(first.id); if (!account && first.default_account) onAccount(first.default_account); }
    }
  }, [methods.data]); // preselect once when methods load
  return (
    <>
      <Field label="Payment method" required error={errors.method}>
        <Select value={method ?? ""} onChange={(e) => {
          const id = e.target.value ? Number(e.target.value) : null;
          onMethod(id);
          const m = methods.data?.find((x) => x.id === id);
          if (m?.default_account) onAccount(m.default_account);
        }}>
          <option value="">Choose…</option>
          {methods.data?.filter((m) => m.is_active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </Field>
      <Field label={accountLabel} required error={errors.account}>
        <Select value={account ?? ""} onChange={(e) => onAccount(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose…</option>
          {cashBank.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
        </Select>
      </Field>
    </>
  );
}

export function useMethodRequiresReference(method: number | null) {
  const methods = useOptions<Method>("payment-methods");
  return !!methods.data?.find((m) => m.id === method)?.requires_reference;
}
