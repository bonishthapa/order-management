import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useGet } from "@/api/hooks";
import type { DateDisplayMode } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import { BaseForm, FormField, FormSection, useWatch } from "@/components/form";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { PageHeader, Panel } from "@/components/ui/Page";
import { formatDateTime, groupDigits } from "@/utils/format";

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

/** Grouping the chosen locale will use (the same rule as setNumberLocale). */
function LocalePreview() {
  const locale = (useWatch({ name: "locale" }) as string) ?? "";
  const symbol = (useWatch({ name: "currency_symbol" }) as string) ?? "";
  return <>Preview: {symbol} {groupDigits("1234567", /(NP|IN)$/i.test(locale) ? "lakh" : "thousand")}.89</>;
}

function FooterCount() {
  const footer = (useWatch({ name: "document_footer" }) as string) ?? "";
  return <>{footer.length}/300 characters. Printed at the bottom of every PDF.</>;
}

/** Checkbox with a description, bound to a boolean form field. */
function RuleToggle({ name, label, description }: { name: EditableKey; label: string; description: ReactNode }) {
  return (
    <FormField name={name} label={<span className="sr-only">{label}</span>} type="custom" span="full"
      render={({ value, onChange, disabled }) => (
        <label className={`flex items-start gap-2.5 ${disabled ? "cursor-default opacity-80" : "cursor-pointer"}`}>
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={!!value} disabled={disabled}
            onChange={(e) => onChange(e.target.checked)} />
          <span>
            <span className="block text-[13px] font-medium text-slate-800">{label}</span>
            <span className="block text-xs text-slate-500">{description}</span>
          </span>
        </label>
      )} />
  );
}

export function CompanySettingsPage() {
  const { can, reload } = useAuth();
  const queryClient = useQueryClient();
  const formId = useId();
  const query = useGet<OrganizationSettings>(["organization", "current"], "/organizations/current/");
  const canManage = can("settings.manage");

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const org = query.data;

  const applySaved = async (data: OrganizationSettings) => {
    queryClient.setQueryData(["organization", "current", {}], data);
    await queryClient.invalidateQueries({ queryKey: ["organization"] });
    await reload();
  };

  const save = async (values: FormState) => {
    const original = pick(org);
    const body: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      const v = typeof values[k] === "string" ? (values[k] as string).trim() : values[k];
      if (v !== original[k]) body[k] = v;
    }
    if (typeof body.currency === "string") body.currency = body.currency.toUpperCase();
    if (!Object.keys(body).length) {
      toast.info("No changes to save");
      return;
    }
    const { data } = await api.patch<OrganizationSettings>("/organizations/current/", body);
    await applySaved(data);
    toast.success("Company settings saved");
  };

  return (
    <>
      <PageHeader title="Company settings" subtitle={`${org.legal_name || org.name} · code ${org.code}`}
        meta={!canManage && <Badge>Read only</Badge>}
        actions={canManage && <Button type="submit" form={formId} variant="primary">Save settings</Button>} />
      {!canManage && (
        <Alert tone="info" className="mb-4">Your role can view these settings. Changes need the "Change company settings" permission.</Alert>
      )}
      <BaseForm<FormState> key={org.updated_at} id={formId} defaultValues={pick(org)} onSubmit={save} submitLabel="Save settings"
        disabled={!canManage}>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <FormSection title="Organisation profile" columns={2}>
              <FormField name="name" label="Trading name" required maxLength={200} />
              <FormField name="legal_name" label="Registered (legal) name" hint="Printed on invoices and statements." maxLength={200} />
              <FormField name="tax_id" label="PAN / VAT number" maxLength={40} />
              <FormField name="email" label="Email" type="email" />
              <FormField name="phone" label="Phone" type="tel" maxLength={40} />
              <FormField name="website" label="Website" maxLength={200} />
              <FormField name="address" label="Address" type="textarea" rows={2} span={2} />
              <FormField name="city" label="City" maxLength={100} />
              <FormField name="country" label="Country" maxLength={60} />
            </FormSection>
          </div>
          <div><LogoPanel org={org} canManage={canManage} onSaved={applySaved} /></div>
        </div>

        <FormSection title="Currency, locale and time" columns={4}>
          <FormField name="currency" label="Currency code" required maxLength={3} uppercase hint="ISO 4217, e.g. NPR."
            rules={{ pattern: { value: /^[A-Za-z]{3}$/, message: "Use the 3-letter ISO currency code, e.g. NPR." } }} />
          <FormField name="currency_symbol" label="Currency symbol" required maxLength={8} />
          <FormField name="locale" label="Number format" type="select" emptyOption={false} hint={<LocalePreview />}
            options={LOCALES.some((l) => l.value === org.locale) ? LOCALES : [{ value: org.locale, label: org.locale }, ...LOCALES]} />
          <FormField name="timezone" label="Time zone" type="select" emptyOption={false}
            hint="Decides today's business date and document timestamps."
            options={timezones(org.timezone).map((tz) => ({ value: tz, label: tz }))} />
        </FormSection>

        <FormSection title="Dates" columns={4}>
          <FormField name="date_display_mode" label="Default date display" type="select" emptyOption={false}
            hint="Used for printed documents and for users who have not chosen their own preference."
            options={(Object.keys(DATE_MODE_LABELS) as DateDisplayMode[]).map((m) => ({ value: m, label: DATE_MODE_LABELS[m] }))} />
          <FormField name="date_input_calendar" label="Default input calendar" type="select" emptyOption={false}
            hint="Calendar the date fields open in. Users can switch per field."
            options={[{ value: "BS", label: "Bikram Sambat (BS)" }, { value: "AD", label: "Gregorian (AD)" }]} />
        </FormSection>

        <FormSection title="Business rules" columns={2}>
          <FormField name="negative_stock_policy" label="Negative stock" type="select" emptyOption={false}
            hint="Allowing negative stock costs the shortfall at the last known cost; it is corrected when stock arrives."
            options={[
              { value: "DISALLOW", label: "Block postings that make stock negative" },
              { value: "ALLOW", label: "Allow negative stock (costed at last known cost)" },
            ]} />
          <RuleToggle name="require_sales_order_approval" label="Sales orders need approval"
            description="Orders are submitted for approval before they can be delivered or invoiced." />
          <RuleToggle name="require_purchase_order_approval" label="Purchase orders need approval"
            description="Orders are submitted for approval before goods can be received." />
          <RuleToggle name="require_expense_approval" label="Expenses need approval"
            description="Expenses are posted only after an approver accepts them." />
          <RuleToggle name="allow_invoice_before_delivery" label="Allow invoicing before delivery"
            description="Sales order quantities can be invoiced before they are delivered." />
        </FormSection>

        <FormSection title="Printed documents" columns={2}>
          <FormField name="terms_and_conditions" label="Terms and conditions" type="textarea" rows={6}
            hint="Printed on sales invoices and quotations." />
          <FormField name="document_footer" label="Document footer" type="textarea" rows={3} maxLength={300} hint={<FooterCount />} />
        </FormSection>
      </BaseForm>
      <p className="mt-4 text-xs text-slate-400">Last changed {formatDateTime(org.updated_at, org.timezone)}</p>
    </>
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
