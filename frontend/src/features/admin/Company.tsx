import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useGet } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { formatDateTime, groupDigits } from "@/utils/format";
import type { DateDisplayMode } from "@/api/types";

export interface OrganizationSettings {
  id: number;
  name: string;
  legal_name: string;
  code: string;
  logo: string | null;
  address: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  website: string;
  tax_id: string;
  currency: string;
  currency_symbol: string;
  locale: string;
  timezone: string;
  date_display_mode: DateDisplayMode;
  date_input_calendar: "AD" | "BS";
  negative_stock_policy: "DISALLOW" | "ALLOW";
  allow_invoice_before_delivery: boolean;
  require_sales_order_approval: boolean;
  require_purchase_order_approval: boolean;
  require_expense_approval: boolean;
  terms_and_conditions: string;
  document_footer: string;
  updated_at: string;
}

type EditableKey = Exclude<keyof OrganizationSettings, "id" | "code" | "logo" | "updated_at">;
type FormState = Pick<OrganizationSettings, EditableKey>;

const EDITABLE: EditableKey[] = [
  "name", "legal_name", "address", "city", "country", "email", "phone", "website", "tax_id", "currency", "currency_symbol",
  "locale", "timezone", "date_display_mode", "date_input_calendar", "negative_stock_policy", "allow_invoice_before_delivery",
  "require_sales_order_approval", "require_purchase_order_approval", "require_expense_approval", "terms_and_conditions",
  "document_footer",
];

const LOCALES = [
  { value: "en-NP", label: "English (Nepal) – lakh grouping 12,34,567.00" },
  { value: "ne-NP", label: "Nepali (Nepal) – lakh grouping 12,34,567.00" },
  { value: "en-IN", label: "English (India) – lakh grouping 12,34,567.00" },
  { value: "en-US", label: "English (US) – thousand grouping 1,234,567.00" },
  { value: "en-GB", label: "English (UK) – thousand grouping 1,234,567.00" },
];

export const DATE_MODE_LABELS: Record<DateDisplayMode, string> = { AD_BS: "AD + BS", BS: "BS only", AD: "AD only" };

const MAX_LOGO_BYTES = 1024 * 1024;

function timezones(current: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const list = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["Asia/Kathmandu", "Asia/Kolkata", "UTC"];
  return list.includes(current) ? list : [current, ...list];
}

function pick(org: OrganizationSettings): FormState {
  return Object.fromEntries(EDITABLE.map((k) => [k, org[k]])) as FormState;
}

export function CompanySettingsPage() {
  const { can, reload } = useAuth();
  const queryClient = useQueryClient();
  const query = useGet<OrganizationSettings>(["organization", "current"], "/organizations/current/");
  const canManage = can("settings.manage");
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.data) setForm(pick(query.data));
  }, [query.data]);

  const dirtyKeys = useMemo(() => {
    if (!form || !query.data) return [] as EditableKey[];
    return EDITABLE.filter((k) => form[k] !== query.data![k]);
  }, [form, query.data]);

  if (query.isLoading || (query.data && !form)) return <LoadingBlock />;
  if (query.error || !query.data || !form) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const org = query.data;

  const set = <K extends EditableKey>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const text = (key: EditableKey) => ({
    value: String(form[key] ?? ""),
    disabled: !canManage,
    invalid: !!errors[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
  });

  const applySaved = async (data: OrganizationSettings) => {
    queryClient.setQueryData(["organization", "current", {}], data);
    await queryClient.invalidateQueries({ queryKey: ["organization"] });
    await reload();
  };

  const save = async () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Enter the organisation name.";
    if (!form.currency.trim() || form.currency.trim().length !== 3) e.currency = "Use the 3-letter ISO currency code, e.g. NPR.";
    if (!form.currency_symbol.trim()) e.currency_symbol = "Enter the symbol printed before amounts.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = Object.fromEntries(dirtyKeys.map((k) => [k, typeof form[k] === "string" ? (form[k] as string).trim() : form[k]]));
      if ("currency" in body) body.currency = String(body.currency).toUpperCase();
      const { data } = await api.patch<OrganizationSettings>("/organizations/current/", body);
      await applySaved(data);
      toast.success("Company settings saved");
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Company settings" subtitle={`${org.legal_name || org.name} · code ${org.code}`}
        meta={!canManage && <Badge>Read only</Badge>}
        actions={canManage && (<>
          <Button disabled={!dirtyKeys.length || saving} onClick={() => { setForm(pick(org)); setErrors({}); }}>Discard changes</Button>
          <Button variant="primary" loading={saving} disabled={!dirtyKeys.length} onClick={save}>Save settings</Button>
        </>)} />
      {!canManage && (
        <Alert tone="info" className="mb-4">Your role can view these settings. Changes need the "Change company settings" permission.</Alert>
      )}
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Organisation profile" className="lg:col-span-2">
            <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2">
              <Field label="Trading name" required error={errors.name}><Input {...text("name")} /></Field>
              <Field label="Registered (legal) name" error={errors.legal_name} hint="Printed on invoices and statements.">
                <Input {...text("legal_name")} />
              </Field>
              <Field label="PAN / VAT number" error={errors.tax_id}><Input {...text("tax_id")} /></Field>
              <Field label="Email" error={errors.email}><Input type="email" {...text("email")} /></Field>
              <Field label="Phone" error={errors.phone}><Input {...text("phone")} /></Field>
              <Field label="Website" error={errors.website}><Input {...text("website")} /></Field>
              <Field label="Address" error={errors.address} className="sm:col-span-2">
                <Textarea rows={2} {...text("address")} />
              </Field>
              <Field label="City" error={errors.city}><Input {...text("city")} /></Field>
              <Field label="Country" error={errors.country}><Input {...text("country")} /></Field>
            </div>
          </Panel>
          <LogoPanel org={org} canManage={canManage} onSaved={applySaved} />
        </div>

        <Panel title="Currency, locale and time">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Currency code" required error={errors.currency} hint="ISO 4217, e.g. NPR.">
              <Input maxLength={3} {...text("currency")} />
            </Field>
            <Field label="Currency symbol" required error={errors.currency_symbol}><Input maxLength={8} {...text("currency_symbol")} /></Field>
            <Field label="Number format" error={errors.locale}
              hint={`Preview: ${form.currency_symbol} ${previewAmount(form.locale)}`}>
              <Select {...text("locale")}>
                {!LOCALES.some((l) => l.value === form.locale) && <option value={form.locale}>{form.locale}</option>}
                {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </Select>
            </Field>
            <Field label="Time zone" error={errors.timezone} hint="Decides today's business date and document timestamps.">
              <Select {...text("timezone")}>
                {timezones(form.timezone).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel title="Dates">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Default date display" error={errors.date_display_mode}
              hint="Used for printed documents and for users who have not chosen their own preference.">
              <Select {...text("date_display_mode")}>
                {(Object.keys(DATE_MODE_LABELS) as DateDisplayMode[]).map((m) => <option key={m} value={m}>{DATE_MODE_LABELS[m]}</option>)}
              </Select>
            </Field>
            <Field label="Default input calendar" error={errors.date_input_calendar}
              hint="Calendar the date fields open in. Users can switch per field.">
              <Select {...text("date_input_calendar")}>
                <option value="BS">Bikram Sambat (BS)</option>
                <option value="AD">Gregorian (AD)</option>
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel title="Business rules">
          <div className="grid gap-x-6 gap-y-4 p-4 lg:grid-cols-2">
            <Field label="Negative stock" error={errors.negative_stock_policy}
              hint="Allowing negative stock costs the shortfall at the last known cost; it is corrected when stock arrives.">
              <Select {...text("negative_stock_policy")}>
                <option value="DISALLOW">Block postings that make stock negative</option>
                <option value="ALLOW">Allow negative stock (costed at last known cost)</option>
              </Select>
            </Field>
            <div className="space-y-2.5">
              <Toggle label="Sales orders need approval" checked={form.require_sales_order_approval} disabled={!canManage}
                description="Orders are submitted for approval before they can be delivered or invoiced."
                onChange={(v) => set("require_sales_order_approval", v)} />
              <Toggle label="Purchase orders need approval" checked={form.require_purchase_order_approval} disabled={!canManage}
                description="Orders are submitted for approval before goods can be received."
                onChange={(v) => set("require_purchase_order_approval", v)} />
              <Toggle label="Expenses need approval" checked={form.require_expense_approval} disabled={!canManage}
                description="Expenses are posted only after an approver accepts them."
                onChange={(v) => set("require_expense_approval", v)} />
              <Toggle label="Allow invoicing before delivery" checked={form.allow_invoice_before_delivery} disabled={!canManage}
                description="Sales order quantities can be invoiced before they are delivered."
                onChange={(v) => set("allow_invoice_before_delivery", v)} />
            </div>
          </div>
        </Panel>

        <Panel title="Printed documents">
          <div className="grid gap-x-4 gap-y-3 p-4 lg:grid-cols-2">
            <Field label="Terms and conditions" error={errors.terms_and_conditions} hint="Printed on sales invoices and quotations.">
              <Textarea rows={6} {...text("terms_and_conditions")} />
            </Field>
            <Field label="Document footer" error={errors.document_footer} hint={`${form.document_footer.length}/300 characters. Printed at the bottom of every PDF.`}>
              <Textarea rows={3} maxLength={300} {...text("document_footer")} />
            </Field>
          </div>
        </Panel>

        <p className="text-xs text-slate-400">Last changed {formatDateTime(org.updated_at, org.timezone)}</p>
      </div>
    </>
  );
}

/** Grouping the chosen locale will use (the same rule as setNumberLocale). */
function previewAmount(locale: string) {
  return `${groupDigits("1234567", /(NP|IN)$/i.test(locale) ? "lakh" : "thousand")}.89`;
}

export function Toggle({ label, description, checked, onChange, disabled }: {
  label: ReactNode; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? "cursor-default opacity-80" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-[13px] font-medium text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

function LogoPanel({ org, canManage, onSaved }: {
  org: OrganizationSettings; canManage: boolean; onSaved: (data: OrganizationSettings) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return setError("Choose a PNG, JPEG, GIF or WebP image.");
    if (f.size > MAX_LOGO_BYTES) return setError("The logo must be smaller than 1 MB.");
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const clear = () => {
    setFile(null);
    setPreview(null);
    if (input.current) input.current.value = "";
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.append("logo", file);
      const { data } = await api.patch<OrganizationSettings>("/organizations/current/", body);
      await onSaved(data);
      clear();
      toast.success("Logo updated");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const { data } = await api.patch<OrganizationSettings>("/organizations/current/", { logo: null });
      await onSaved(data);
      setConfirmRemove(false);
      toast.success("Logo removed");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  const shown = preview ?? org.logo;
  return (
    <Panel title="Logo">
      <div className="space-y-3 p-4">
        <div className="flex h-36 items-center justify-center rounded border border-dashed border-line-strong bg-surface-muted">
          {shown ? <img src={shown} alt={`${org.name} logo`} className="max-h-32 max-w-full object-contain" />
            : <span className="text-xs text-slate-400">No logo uploaded</span>}
        </div>
        {preview && <p className="text-xs text-amber-700">Preview – not saved yet.</p>}
        {error && <Alert tone="error">{error}</Alert>}
        <p className="text-xs text-slate-500">Printed on invoices, receipts and reports. PNG or JPEG, up to 1 MB; a wide image about 600 × 200 px prints best.</p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden"
              onChange={(e) => choose(e.target.files?.[0])} />
            {file ? (<>
              <Button variant="primary" size="sm" loading={uploading} onClick={upload}>Upload logo</Button>
              <Button size="sm" disabled={uploading} onClick={clear}>Cancel</Button>
            </>) : (<>
              <Button size="sm" icon={<ImageUp className="h-3.5 w-3.5" />} onClick={() => input.current?.click()}>
                {org.logo ? "Replace logo" : "Choose image"}
              </Button>
              {org.logo && <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmRemove(true)}>Remove</Button>}
            </>)}
          </div>
        )}
      </div>
      <ConfirmDialog open={confirmRemove} onOpenChange={setConfirmRemove} title="Remove the logo?" tone="danger" confirmLabel="Remove logo"
        loading={removing} description="Documents printed from now on will not show a logo. Already issued PDFs are not affected."
        onConfirm={remove} />
    </Panel>
  );
}
