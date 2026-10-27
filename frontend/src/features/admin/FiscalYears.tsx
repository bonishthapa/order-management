import { CheckCircle2, Lock, LockOpen, Pencil, Plus, RefreshCw, XCircle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useDetail, useGet, useOptions } from "@/api/hooks";
import type { AccountingPeriod, FiscalYear } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import {
  BS_MAX_YEAR, BS_MIN_YEAR, BS_MONTH_NAMES, BSDateError, addDays, adToBs, adToBsString, bsToAd, daysInBsMonth, isoToUtc, todayIn,
  utcToIso, type ISODate,
} from "@/calendar/bs";
import { DateText } from "@/calendar/DateText";
import { BaseForm, FormDialog, FormField, FormGrid, FormSection, useFormContext, useWatch } from "@/components/form";
import { BaseTable, DataGrid, col, type TableColumn } from "@/components/table";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock, Spinner } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { NumberInput, Select } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { cn } from "@/utils/cn";
import { formatAmount, formatDateTime, toNumber } from "@/utils/format";

/* ------------------------------------------------------------------------------------------------
 * Shared helpers
 * ---------------------------------------------------------------------------------------------- */

export const PERIOD_TYPES = [
  { value: "BS_MONTHLY", label: "Monthly (BS months)" },
  { value: "AD_MONTHLY", label: "Monthly (AD months)" },
  { value: "SINGLE", label: "Single period" },
] as const;
type PeriodType = (typeof PERIOD_TYPES)[number]["value"];

const periodTypeLabel = (v: string) => PERIOD_TYPES.find((p) => p.value === v)?.label ?? v;

const OPENING_LABELS: Record<string, string> = { PENDING: "Pending", POSTED: "Posted", CARRIED_FORWARD: "Carried forward" };
const CLOSING_LABELS: Record<string, string> = { OPEN: "Not closed", CLOSED: "Closed" };

const AD_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** BS and AD shown together, regardless of the user's display preference (fiscal boundaries need both). */
function BothDates({ ad, bs }: { ad: string | null | undefined; bs?: string | null }) {
  if (!ad) return <span>–</span>;
  return (
    <span className="tabular-nums">
      <span className="text-slate-800">BS {bs || adToBsString(ad)}</span>
      <span className="text-slate-400"> · AD {ad.slice(0, 10)}</span>
    </span>
  );
}

const daysBetween = (a: ISODate, b: ISODate) => Math.round((isoToUtc(b) - isoToUtc(a)) / 86_400_000);

export interface PeriodPreview { number: number; name: string; start: ISODate; end: ISODate }

/** Mirrors backend services.build_periods so the form can preview the periods it will create. */
export function buildPeriods(start: ISODate, end: ISODate, type: PeriodType): PeriodPreview[] {
  if (!start || !end || end < start) return [];
  if (type === "SINGLE") return [{ number: 1, name: "Full year", start, end }];
  const periods: PeriodPreview[] = [];
  let cursor = start;
  while (cursor <= end && periods.length < 40) {
    let monthEnd: ISODate;
    let name: string;
    if (type === "BS_MONTHLY") {
      const bs = adToBs(cursor);
      monthEnd = bsToAd({ year: bs.year, month: bs.month, day: daysInBsMonth(bs.year, bs.month) });
      name = `${BS_MONTH_NAMES[bs.month - 1]} ${bs.year}`;
    } else {
      const [y, m] = [Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7))];
      monthEnd = utcToIso(Date.UTC(y, m, 0));
      name = `${AD_MONTHS[m - 1]} ${y}`;
    }
    const periodEnd = monthEnd < end ? monthEnd : end;
    periods.push({ number: periods.length + 1, name, start: cursor, end: periodEnd });
    cursor = addDays(periodEnd, 1);
  }
  return periods;
}

/** First and last day of the Nepali fiscal year that starts on 1 Shrawan of ``bsYear``. */
export function nepaliFiscalYear(bsYear: number) {
  const start = bsToAd({ year: bsYear, month: 4, day: 1 });
  const end = bsToAd({ year: bsYear + 1, month: 3, day: daysInBsMonth(bsYear + 1, 3) });
  const code = `${bsYear}/${String((bsYear + 1) % 100).padStart(2, "0")}`;
  return { start, end, code };
}

function useInvalidateFiscal() {
  const queryClient = useQueryClient();
  return () => ["fiscal-years", "accounting-periods", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
}

/* ------------------------------------------------------------------------------------------------
 * List
 * ---------------------------------------------------------------------------------------------- */

const FY_COLUMNS: TableColumn<FiscalYear>[] = [
  col.custom<FiscalYear>("name", "Fiscal year", (r) => <span className="font-medium text-brand-700">{r.name}</span>, { minWidth: 130, pinned: true }),
  col.text<FiscalYear>("code", "Code", { minWidth: 100 }),
  col.custom<FiscalYear>("start_date", "Starts", (r) => <BothDates ad={r.start_date} bs={r.start_date_bs} />, { minWidth: 220 }),
  col.custom<FiscalYear>("end_date", "Ends", (r) => <BothDates ad={r.end_date} bs={r.end_date_bs} />, { minWidth: 220 }),
  col.text<FiscalYear>("period_type", "Periods", { minWidth: 150, value: (r) => periodTypeLabel(r.period_type) }),
  col.status<FiscalYear>("status", "Status", "status_label", { minWidth: 170 }),
  col.custom<FiscalYear>("opening_balance_status", "Opening balances",
    (r) => <StatusBadge status={r.opening_balance_status} label={OPENING_LABELS[r.opening_balance_status]} />, { minWidth: 120 }),
  col.custom<FiscalYear>("closing_status", "Year-end close",
    (r) => <StatusBadge status={r.closing_status} label={CLOSING_LABELS[r.closing_status]} />, { minWidth: 120 }),
];

export function FiscalYearList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const query = useOptions<FiscalYear>("fiscal-years");
  return (
    <>
      <PageHeader title="Fiscal years"
        subtitle="Each fiscal year is split into accounting periods. Activating a year makes it current; the previous year stays open until its year-end close."
        actions={can("fiscal.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/admin/fiscal-years/new")}>New fiscal year</Button>
        )} />
      <div className="panel overflow-hidden">
        <DataGrid<FiscalYear> id="admin-fiscal-years" columns={FY_COLUMNS} rows={query.data} loading={query.isLoading} error={query.error}
          onRetry={() => query.refetch()} onRowClick={(r) => navigate(`/admin/fiscal-years/${r.id}`)}
          empty={{
            title: "No fiscal years yet", description: "Create the first fiscal year before posting any transaction.",
            action: can("fiscal.manage") ? <Button variant="primary" onClick={() => navigate("/admin/fiscal-years/new")}>New fiscal year</Button> : undefined,
          }} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Form (create / edit draft)
 * ---------------------------------------------------------------------------------------------- */

interface FiscalYearValues {
  name: string;
  code: string;
  start_date: string;
  end_date: string;
  period_type: PeriodType;
  notes: string;
}

export function FiscalYearForm() {
  const { id } = useParams();
  const editing = !!id && id !== "new";
  const query = useDetail<FiscalYear>("fiscal-years", editing ? id : undefined);
  if (editing && query.isLoading) return <LoadingBlock />;
  if (editing && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <FiscalYearEditor key={id ?? "new"} existing={editing ? query.data! : null} />;
}

function FiscalYearEditor({ existing }: { existing: FiscalYear | null }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const invalidate = useInvalidateFiscal();
  const years = useOptions<FiscalYear>("fiscal-years");

  if (existing && existing.status !== "DRAFT") {
    return (
      <>
        <PageHeader title={`Edit ${existing.name}`} back={{ to: `/admin/fiscal-years/${existing.id}`, label: existing.name }} />
        <Alert tone="warning" title="This fiscal year can no longer be edited">
          Only draft fiscal years can be changed. {existing.name} is {existing.status_label.toLowerCase()}.
        </Alert>
      </>
    );
  }
  if (!can("fiscal.manage")) {
    return (
      <>
        <PageHeader title="Fiscal year" back={{ to: "/admin/fiscal-years", label: "Fiscal years" }} />
        <Alert tone="warning">Your role cannot create or edit fiscal years.</Alert>
      </>
    );
  }

  const others = (years.data ?? []).filter((fy) => fy.id !== existing?.id);
  const overlapsWith = (start: string, end: string) => others.filter((fy) => start && end && fy.start_date <= end && fy.end_date >= start);

  const submit = async (v: FiscalYearValues) => {
    const body = { name: v.name.trim(), code: v.code.trim(), start_date: v.start_date, end_date: v.end_date, period_type: v.period_type, notes: v.notes };
    const { data } = existing
      ? await api.patch<FiscalYear>(`/fiscal-years/${existing.id}/`, body)
      : await api.post<FiscalYear>("/fiscal-years/", body);
    invalidate();
    toast.success(existing ? `Fiscal year ${data.name} updated` : `Fiscal year ${data.name} created as draft`);
    navigate(`/admin/fiscal-years/${data.id}`);
  };

  return (
    <>
      <PageHeader title={existing ? `Edit fiscal year ${existing.name}` : "New fiscal year"}
        back={existing ? { to: `/admin/fiscal-years/${existing.id}`, label: existing.name } : { to: "/admin/fiscal-years", label: "Fiscal years" }}
        subtitle="The year is saved as a draft with its accounting periods. Postings are allowed once it is activated." />
      <BaseForm<FiscalYearValues>
        defaultValues={{
          name: existing?.name ?? "", code: existing?.code ?? "", start_date: existing?.start_date ?? "", end_date: existing?.end_date ?? "",
          period_type: (existing?.period_type as PeriodType) ?? "BS_MONTHLY", notes: existing?.notes ?? "",
        }}
        onSubmit={submit} submitLabel={existing ? "Save draft" : "Create fiscal year"} onCancel={() => navigate(-1)}>
        <QuickFill years={years.data ?? []} />
        <FormSection title="Fiscal year" columns={4}>
          <FormField name="name" label="Name" required maxLength={60} hint="Shown in menus and reports." />
          <FormField name="code" label="Code" required maxLength={20} hint="Used in document numbers, e.g. SI-2083/84-000001." />
          <FormField name="start_date" label="First day" type="date" required />
          <EndDateField overlapsWith={overlapsWith} />
          <FormField name="period_type" label="Accounting periods" type="select" emptyOption={false}
            options={PERIOD_TYPES.map((p) => ({ value: p.value, label: p.label }))} />
          <FormField name="notes" label="Notes" type="textarea" rows={2} span={3} />
          <RangeSummary overlapsWith={overlapsWith} />
        </FormSection>
        <PeriodPreviewPanel />
      </BaseForm>
    </>
  );
}

function EndDateField({ overlapsWith }: { overlapsWith: (start: string, end: string) => FiscalYear[] }) {
  const start = useWatch({ name: "start_date" }) as string;
  return (
    <FormField name="end_date" label="Last day" type="date" required min={start || undefined}
      rules={{
        validate: (end: string, formValues) => {
          const values = formValues as FiscalYearValues;
          if (!end || !values.start_date) return true;
          if (end <= values.start_date) return "The end date must be after the start date.";
          if (daysBetween(values.start_date, end) + 1 > 400) return "A fiscal year cannot be longer than 400 days.";
          const clash = overlapsWith(values.start_date, end);
          return clash.length ? `These dates overlap ${clash.map((o) => o.name).join(", ")}.` : true;
        },
      }} />
  );
}

function RangeSummary({ overlapsWith }: { overlapsWith: (start: string, end: string) => FiscalYear[] }) {
  const [start, end] = useWatch({ name: ["start_date", "end_date"] }) as [string, string];
  if (!start || !end) return null;
  const length = end >= start ? daysBetween(start, end) + 1 : null;
  const clash = overlapsWith(start, end);
  return (
    <div className="col-span-full space-y-2 border-t border-line pt-3 text-[13px] text-slate-600">
      <div>
        <BothDates ad={start} /> <span className="mx-1 text-slate-400">to</span> <BothDates ad={end} />
        {length !== null && <span className="ml-2 text-slate-500">({length} days)</span>}
      </div>
      {clash.length > 0 && <Alert tone="error">These dates overlap {clash.map((o) => o.name).join(", ")}.</Alert>}
    </div>
  );
}

function QuickFill({ years }: { years: FiscalYear[] }) {
  const { session } = useAuth();
  const { setValue } = useFormContext<FiscalYearValues>();
  const tz = session?.organization?.timezone;
  const suggestedBsYear = useMemo(() => {
    const latest = years.reduce<FiscalYear | null>((a, b) => (!a || b.end_date > a.end_date ? b : a), null);
    try {
      const ref = latest ? adToBs(addDays(latest.end_date, 1)) : adToBs(todayIn(tz));
      return ref.month >= 4 ? ref.year : ref.year - 1;
    } catch {
      return BS_MIN_YEAR;
    }
  }, [years, tz]);
  const [bsYear, setBsYear] = useState<number | null>(null);
  const [adYear, setAdYear] = useState<string | null>(null);
  const fillBsYear = bsYear ?? suggestedBsYear;
  const fillAdYear = adYear ?? String(Number(todayIn(tz).slice(0, 4)) + (years.length > 0 ? 1 : 0));

  const fill = (v: Partial<FiscalYearValues>) => {
    for (const [k, value] of Object.entries(v)) {
      setValue(k as keyof FiscalYearValues, value as never, { shouldDirty: true, shouldValidate: true });
    }
  };
  const applyNepali = () => {
    try {
      const fy = nepaliFiscalYear(fillBsYear);
      fill({ start_date: fy.start, end_date: fy.end, name: fy.code, code: fy.code, period_type: "BS_MONTHLY" });
    } catch (e) {
      toast.error(e instanceof BSDateError ? e.message : "That BS year is outside the supported calendar.");
    }
  };
  const applyCalendar = () => {
    const y = Number(fillAdYear);
    if (!Number.isInteger(y) || y < 1919 || y > 2043) return toast.error("Enter an AD year between 1919 and 2043.");
    fill({ start_date: `${y}-01-01`, end_date: `${y}-12-31`, name: String(y), code: String(y), period_type: "AD_MONTHLY" });
  };
  const bsYears = Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR }, (_, i) => BS_MIN_YEAR + i);

  return (
    <Panel title="Quick fill">
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="BS year starting 1 Shrawan">
            <Select className="w-32" value={fillBsYear} onChange={(e) => setBsYear(Number(e.target.value))}>
              {bsYears.map((y) => <option key={y} value={y}>{y}/{String((y + 1) % 100).padStart(2, "0")}</option>)}
            </Select>
          </Field>
          <Button onClick={applyNepali}>Nepali fiscal year (1 Shrawan – end of Ashadh)</Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="AD year">
            <NumberInput className="w-24" value={fillAdYear} onChange={(e) => setAdYear(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </Field>
          <Button onClick={applyCalendar}>Calendar year (AD)</Button>
        </div>
      </div>
    </Panel>
  );
}

const PREVIEW_COLUMNS: TableColumn<PeriodPreview>[] = [
  col.number<PeriodPreview>("number", "#", { width: 48, align: "left", className: "text-slate-500" }),
  col.custom<PeriodPreview>("name", "Period", (p) => <span className="font-medium text-slate-800">{p.name}</span>),
  col.custom<PeriodPreview>("start", "From", (p) => <BothDates ad={p.start} />),
  col.custom<PeriodPreview>("end", "To", (p) => <BothDates ad={p.end} />),
  col.number<PeriodPreview>("days", "Days", { value: (p) => daysBetween(p.start, p.end) + 1 }),
];

function PeriodPreviewPanel() {
  const [start, end, type] = useWatch({ name: ["start_date", "end_date", "period_type"] }) as [string, string, PeriodType];
  const preview = useMemo(() => {
    try {
      return { periods: start && end ? buildPeriods(start, end, type) : [], error: null as string | null };
    } catch (e) {
      return { periods: [], error: e instanceof Error ? e.message : "Cannot build periods for these dates." };
    }
  }, [start, end, type]);
  return (
    <Panel title="Periods that will be created" actions={<span className="text-xs text-slate-500">Preview – generated by the server on save</span>}>
      {preview.error ? <Alert tone="error" className="m-4">{preview.error}</Alert> : (
        <BaseTable<PeriodPreview> columns={PREVIEW_COLUMNS} rows={preview.periods} density="compact" rowKey={(p) => p.number}
          empty={<p className="p-4 text-xs text-slate-500">Choose the first and last day to preview the periods.</p>} />
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Periods table with lock / unlock (also used by the Accounting periods page)
 * ---------------------------------------------------------------------------------------------- */

export function PeriodTable({ fiscalYear }: { fiscalYear: Pick<FiscalYear, "id" | "name" | "status"> }) {
  const { can } = useAuth();
  const invalidate = useInvalidateFiscal();
  const query = useGet<AccountingPeriod[]>(["accounting-periods", "by-year", fiscalYear.id], "/accounting-periods/", { fiscal_year: fiscalYear.id });
  const [action, setAction] = useState<{ period: AccountingPeriod; kind: "lock" | "unlock" } | null>(null);
  const canLock = can("fiscal.manage");
  const canUnlock = can("fiscal.reopen");
  const closed = fiscalYear.status === "CLOSED";

  const columns = useMemo<TableColumn<AccountingPeriod>[]>(() => [
    col.number<AccountingPeriod>("number", "#", { width: 40, align: "left", className: "text-slate-500" }),
    col.custom<AccountingPeriod>("name", "Period", (p) => <span className="font-medium text-slate-800">{p.name}</span>),
    col.custom<AccountingPeriod>("start_date", "From", (p) => <BothDates ad={p.start_date} bs={p.start_date_bs} />),
    col.custom<AccountingPeriod>("end_date", "To", (p) => <BothDates ad={p.end_date} bs={p.end_date_bs} />),
    col.status<AccountingPeriod>("status"),
    col.number<AccountingPeriod>("journal_count", "Journals", { value: (p) => p.journal_count ?? "–" }),
    col.custom<AccountingPeriod>("locked_by_name", "Locked by", (p) => (p.status === "LOCKED" && p.locked_by_name ? (
      <span className="text-xs text-slate-500" title={p.lock_reason || undefined}>
        {p.locked_by_name} · {formatDateTime(p.locked_at)}
        {p.lock_reason && <span className="block text-slate-400">{p.lock_reason}</span>}
      </span>
    ) : <span className="text-xs text-slate-500">–</span>)),
    col.custom<AccountingPeriod>("actions", "", (p) => (
      <>
        {p.status === "OPEN" && canLock && !closed && (
          <Button size="sm" icon={<Lock className="h-3 w-3" />} onClick={() => setAction({ period: p, kind: "lock" })}>Lock</Button>
        )}
        {p.status === "LOCKED" && canUnlock && !closed && (
          <Button size="sm" icon={<LockOpen className="h-3 w-3" />} onClick={() => setAction({ period: p, kind: "unlock" })}>Unlock</Button>
        )}
      </>
    ), { align: "right" }),
  ], [canLock, canUnlock, closed]);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const periods = query.data ?? [];
  if (!periods.length) return <EmptyState title="No periods" description="Periods are generated when the fiscal year is saved." />;
  const locked = periods.filter((p) => p.status === "LOCKED").length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-slate-500">
        <span>{periods.length} periods · {locked} locked · {periods.length - locked} open</span>
        <span className="ml-auto">Locked periods reject postings dated inside them. Unlocking requires a reason for the audit trail.</span>
      </div>
      <BaseTable<AccountingPeriod> columns={columns} rows={periods} density="compact" minWidth={860} />
      {closed && <p className="border-t border-line px-4 py-2 text-xs text-slate-500">{fiscalYear.name} is closed. Reopen the fiscal year before unlocking its periods.</p>}
      {action && (
        <FormDialog<{ reason: string }> open onOpenChange={(o) => !o && setAction(null)} size="sm"
          title={`${action.kind === "lock" ? "Lock" : "Unlock"} ${action.period.name}?`}
          submitLabel={action.kind === "lock" ? "Lock period" : "Unlock period"}
          defaultValues={{ reason: "" }}
          onSubmit={async (v) => {
            await api.post(`/accounting-periods/${action.period.id}/${action.kind}/`, { reason: v.reason.trim() });
            invalidate();
            toast.success(action.kind === "lock" ? `${action.period.name} locked` : `${action.period.name} reopened`);
          }}>
          <FormGrid columns={1}>
            <p className="text-[13px] text-slate-600">
              {action.kind === "lock"
                ? <>No document dated between <DateText value={action.period.start_date} bs={action.period.start_date_bs} /> and <DateText value={action.period.end_date} bs={action.period.end_date_bs} /> can be posted, reversed or changed while the period is locked.</>
                : <>Postings dated inside {action.period.name} will be accepted again. Lock it again once the corrections are posted.</>}
            </p>
            <FormField name="reason" label={action.kind === "lock" ? "Reason (optional)" : "Reason"} type="textarea" rows={3} autoFocus
              required={action.kind === "unlock"}
              placeholder={action.kind === "lock" ? "e.g. Month-end close" : "e.g. Post missing supplier bill"} />
          </FormGrid>
        </FormDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Detail
 * ---------------------------------------------------------------------------------------------- */

interface ClosingCheck { check: string; message: string; count?: number }
interface ClosingEntry { account_id: number; code: string; name: string; type: "INCOME" | "EXPENSE" | "EQUITY"; balance: string }
interface ClosingPreview {
  fiscal_year: { id: number; name: string; start_date: string; end_date: string; start_date_bs: string; end_date_bs: string };
  can_close: boolean;
  blockers: ClosingCheck[];
  warnings: ClosingCheck[];
  totals: Record<"ledger_debit" | "ledger_credit" | "inventory_gl" | "inventory_stock" | "receivables" | "payables" | "grni" | "income" | "expenses" | "net_profit", string>;
  cash_and_bank: { account: string; balance: string }[];
  closing_entries: ClosingEntry[];
  next_fiscal_year: { id: number; name: string } | null;
}
interface ClosingRecord {
  id: number;
  summary: Partial<ClosingPreview>;
  closing_journal: number | null;
  closing_journal_number: string | null;
  closed_by_name: string;
  created_at: string;
  reopened_at: string | null;
}

export function FiscalYearDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, session } = useAuth();
  const invalidate = useInvalidateFiscal();
  const query = useDetail<FiscalYear>("fiscal-years", id);
  const years = useOptions<FiscalYear>("fiscal-years");
  const [tab, setTab] = useState("overview");
  const [confirm, setConfirm] = useState<null | "activate" | "reopen">(null);
  const [busy, setBusy] = useState(false);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const fy = query.data;
  const currentActive = (years.data ?? []).find((y) => y.status === "ACTIVE" && y.id !== fy.id) ?? null;
  const closable = ["ACTIVE", "CLOSING", "REOPENED", "CLOSED"].includes(fy.status);

  const act = async (kind: "activate" | "reopen", reason?: string) => {
    setBusy(true);
    try {
      await api.post(`/fiscal-years/${fy.id}/${kind}/`, kind === "reopen" ? { reason } : {});
      invalidate();
      toast.success(kind === "activate" ? `${fy.name} is now the active fiscal year` : `${fy.name} reopened`);
      setConfirm(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader back={{ to: "/admin/fiscal-years", label: "Fiscal years" }} title={`Fiscal year ${fy.name}`}
        meta={<StatusBadge status={fy.status} label={fy.status_label} />}
        subtitle={<><BothDates ad={fy.start_date} bs={fy.start_date_bs} /> <span className="text-slate-400">to</span> <BothDates ad={fy.end_date} bs={fy.end_date_bs} /></>}
        actions={<>
          {fy.status === "DRAFT" && can("fiscal.manage") && (
            <Button icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/admin/fiscal-years/${fy.id}/edit`)}>Edit draft</Button>
          )}
          {fy.status === "DRAFT" && can("fiscal.manage") && (
            <Button variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setConfirm("activate")}>Activate</Button>
          )}
          {fy.status === "CLOSED" && can("fiscal.reopen") && (
            <Button variant="danger" onClick={() => setConfirm("reopen")}>Reopen fiscal year</Button>
          )}
        </>} />
      {fy.status === "CLOSING" && (
        <Alert tone="warning" className="mb-4" title="Open – pending year-end">
          A later fiscal year is active. Postings dated in {fy.name} are still accepted until the year-end close is run.
        </Alert>
      )}
      {fy.status === "REOPENED" && (
        <Alert tone="warning" className="mb-4" title="Reopened">The closing journal was reversed. Run the year-end close again after the corrections.</Alert>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabList className="mb-4" tabs={[
          { value: "overview", label: "Overview and periods" },
          ...(closable ? [{ value: "close", label: "Year-end close" }] : []),
          { value: "history", label: "Closing history" },
        ]} />
        <TabPanel value="overview">
          <div className="space-y-4">
            <Panel title="Summary">
              <p className="border-b border-line px-4 py-2 text-[13px] text-slate-600">{fy.label}</p>
              <KeyValues items={[
                { label: "Name", value: fy.name },
                { label: "Code", value: fy.code },
                { label: "Period type", value: periodTypeLabel(fy.period_type) },
                { label: "Status", value: <StatusBadge status={fy.status} label={fy.status_label} /> },
                { label: "Starts", value: <BothDates ad={fy.start_date} bs={fy.start_date_bs} /> },
                { label: "Ends", value: <BothDates ad={fy.end_date} bs={fy.end_date_bs} /> },
                { label: "Opening balances", value: <StatusBadge status={fy.opening_balance_status} label={OPENING_LABELS[fy.opening_balance_status]} /> },
                { label: "Year-end close", value: <StatusBadge status={fy.closing_status} label={CLOSING_LABELS[fy.closing_status]} /> },
                { label: "Created by", value: fy.created_by_name ? `${fy.created_by_name} · ${formatDateTime(fy.created_at, session?.organization?.timezone)}` : "–" },
                { label: "Activated by", value: fy.approved_by_name ? `${fy.approved_by_name} · ${formatDateTime(fy.approved_at, session?.organization?.timezone)}` : "–" },
                { label: "Closed by", value: fy.closed_by_name ? `${fy.closed_by_name} · ${formatDateTime(fy.closed_at, session?.organization?.timezone)}` : "–" },
                { label: "Notes", value: fy.notes || "–" },
              ]} />
            </Panel>
            <Panel title="Accounting periods"><PeriodTable fiscalYear={fy} /></Panel>
          </div>
        </TabPanel>
        {closable && <TabPanel value="close"><YearEndClose fy={fy} /></TabPanel>}
        <TabPanel value="history"><ClosingHistory fy={fy} /></TabPanel>
      </Tabs>

      <ConfirmDialog open={confirm === "activate"} onOpenChange={(o) => !o && setConfirm(null)} loading={busy}
        title={`Activate ${fy.name}?`} confirmLabel="Activate fiscal year"
        description={<div className="space-y-2">
          <p>{fy.name} becomes the current fiscal year. New documents default to it and its periods accept postings.</p>
          {currentActive
            ? <p>The currently active year, <strong>{currentActive.name}</strong>, changes to <strong>Open – pending year-end</strong>: it still accepts postings for late entries until you run its year-end close.</p>
            : <p>No other fiscal year is active at the moment.</p>}
          <p>After activation the dates and periods can no longer be edited.</p>
        </div>}
        onConfirm={() => act("activate")} />
      <ConfirmDialog open={confirm === "reopen"} onOpenChange={(o) => !o && setConfirm(null)} loading={busy} tone="danger"
        title={`Reopen ${fy.name}?`} confirmLabel="Reopen fiscal year" requireReason reasonLabel="Reason for reopening"
        description="The closing journal is reversed and the next year's opening balances are marked pending again. Periods stay locked until you unlock them one by one."
        onConfirm={(reason) => act("reopen", reason)} />
    </>
  );
}

function CheckRow({ label, ok, children }: { label: string; ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border-b border-line px-4 py-2.5 last:border-0">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Passed" />
        : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-label="Failed" />}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-slate-800">{label}</div>
        <div className="text-xs text-slate-500">{children}</div>
      </div>
    </div>
  );
}

const CASH_COLUMNS: TableColumn<{ account: string; balance: string }>[] = [
  col.text("account", "Account"),
  col.money("balance", "Balance", { render: (c) => <span className={cn(toNumber(c.balance) < 0 && "text-red-700")}>{formatAmount(c.balance)}</span> }),
];

const debitOf = (e: ClosingEntry) => (toNumber(e.balance) < 0 ? formatAmount(-toNumber(e.balance)) : "");
const creditOf = (e: ClosingEntry) => (toNumber(e.balance) > 0 ? formatAmount(toNumber(e.balance)) : "");
const CLOSING_COLUMNS: TableColumn<ClosingEntry>[] = [
  col.custom<ClosingEntry>("name", "Account", (e) => (e.code ? <><span className="text-slate-500">{e.code}</span> {e.name}</> : e.name)),
  col.custom<ClosingEntry>("type", "Type", (e) => <span className="text-xs text-slate-500">{e.type === "INCOME" ? "Income" : e.type === "EXPENSE" ? "Expense" : "Equity"}</span>),
  col.money<ClosingEntry>("debit", "Debit", { render: debitOf, value: debitOf }),
  col.money<ClosingEntry>("credit", "Credit", { render: creditOf, value: creditOf }),
];

function YearEndClose({ fy }: { fy: FiscalYear }) {
  const { can } = useAuth();
  const invalidate = useInvalidateFiscal();
  const queryClient = useQueryClient();
  const [requested, setRequested] = useState(false);
  const [closing, setClosing] = useState(false);
  const preview = useQuery<ClosingPreview>({
    queryKey: ["fiscal-years", "closing-preview", fy.id],
    queryFn: async () => (await api.get<ClosingPreview>(`/fiscal-years/${fy.id}/closing-preview/`)).data,
    enabled: requested,
    staleTime: 0,
  });

  if (fy.status === "CLOSED") {
    return (
      <Alert tone="success" title={`${fy.name} is closed`}>
        Closed by {fy.closed_by_name ?? "–"} on {formatDateTime(fy.closed_at)}. Income and expense balances were transferred to retained earnings.
        See the closing history for the closing journal.
      </Alert>
    );
  }

  if (!requested) {
    return (
      <Panel title="Year-end close">
        <div className="space-y-3 p-4 text-[13px] text-slate-600">
          <p>The close checks that every document in {fy.name} is posted, the ledger balances and the control accounts agree with their sub-ledgers.
            It then posts one closing journal that moves income and expense balances to retained earnings and locks every period.</p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-500">
            <li>Run the check and resolve every blocker.</li>
            <li>Review the warnings, cash and bank balances and the closing entries.</li>
            <li>Type the fiscal year code to confirm the close.</li>
          </ol>
          <Button variant="primary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRequested(true)}>Run closing check</Button>
        </div>
      </Panel>
    );
  }
  if (preview.isLoading) return <LoadingBlock label="Checking the fiscal year…" />;
  if (preview.error || !preview.data) return <ErrorState error={preview.error} onRetry={() => preview.refetch()} />;
  const p = preview.data;
  const t = p.totals;
  const blockedBy = (name: string) => p.blockers.some((b) => b.check === name);
  const documentBlockers = p.blockers.filter((b) => b.count !== undefined);
  const netProfit = toNumber(t.net_profit);
  const closingRows: ClosingEntry[] = p.closing_entries.length ? [
    ...p.closing_entries,
    { account_id: 0, code: "", name: "Retained earnings – net result for the year", type: "EQUITY", balance: String(-netProfit) },
  ] : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {p.can_close
          ? <Alert tone="success" className="flex-1" title="Ready to close">No blockers were found. Review the figures below before closing.</Alert>
          : <Alert tone="error" className="flex-1" title={`${p.blockers.length} blocker${p.blockers.length === 1 ? "" : "s"} must be resolved`}>
            The fiscal year cannot be closed until every blocker below is cleared.</Alert>}
        <Button icon={preview.isFetching ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
          disabled={preview.isFetching} onClick={() => preview.refetch()}>Run check again</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Blockers" actions={<Badge tone={p.blockers.length ? "red" : "green"}>{p.blockers.length}</Badge>}>
          {!p.blockers.length ? <p className="p-4 text-xs text-slate-500">None.</p> : (
            <ul>
              {p.blockers.map((b, i) => (
                <li key={i} className="flex items-start gap-2 border-b border-line px-4 py-2 last:border-0">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-slate-800">
                      {b.check}{b.count !== undefined && <Badge tone="red">{b.count}</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">{b.message}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Warnings" actions={<Badge tone={p.warnings.length ? "amber" : "green"}>{p.warnings.length}</Badge>}>
          {!p.warnings.length ? <p className="p-4 text-xs text-slate-500">None.</p> : (
            <ul>
              {p.warnings.map((w, i) => (
                <li key={i} className="border-b border-line px-4 py-2 last:border-0">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-slate-800">
                    {w.check}{w.count !== undefined && <Badge tone="amber">{w.count}</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">{w.message}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Checks">
          <CheckRow label="Unposted documents" ok={!documentBlockers.length}>
            {documentBlockers.length ? `${documentBlockers.reduce((s, b) => s + (b.count ?? 0), 0)} documents dated in the year are not posted.` : "Every document dated in the year is posted."}
          </CheckRow>
          <CheckRow label="Ledger balances" ok={!blockedBy("Trial balance")}>
            Debits {formatAmount(t.ledger_debit)} · credits {formatAmount(t.ledger_credit)}
          </CheckRow>
          <CheckRow label="Inventory valuation" ok={!blockedBy("Inventory valuation")}>
            Inventory account {formatAmount(t.inventory_gl)} · stock valuation {formatAmount(t.inventory_stock)}
          </CheckRow>
          <CheckRow label="Receivables" ok={!blockedBy("Receivables")}>
            AR control account agrees with customer ledgers: {formatAmount(t.receivables)}
          </CheckRow>
          <CheckRow label="Payables" ok={!blockedBy("Payables")}>
            AP control account agrees with supplier ledgers: {formatAmount(t.payables)}
          </CheckRow>
          <CheckRow label="Earlier fiscal years" ok={!blockedBy("Earlier years")}>
            {p.blockers.find((b) => b.check === "Earlier years")?.message ?? "All earlier fiscal years are closed."}
          </CheckRow>
          <div className="border-t border-line px-4 py-2 text-xs text-slate-500">
            Goods received not invoiced: {formatAmount(t.grni)} (carried forward as a liability).
          </div>
        </Panel>
        <Panel title="Cash and bank balances at year end">
          <BaseTable columns={CASH_COLUMNS} rows={p.cash_and_bank} density="compact" rowKey={(c) => c.account}
            empty={<p className="p-4 text-xs text-slate-500">No cash or bank accounts.</p>} />
        </Panel>
      </div>

      <Panel title="Closing entries"
        actions={<span className="text-xs text-slate-500">Posted as one journal dated <DateText value={p.fiscal_year.end_date} bs={p.fiscal_year.end_date_bs} /></span>}>
        <BaseTable<ClosingEntry> columns={CLOSING_COLUMNS} rows={closingRows} density="compact" minWidth={640}
          rowKey={(e) => e.account_id || "retained"}
          rowClassName={(e) => (e.type === "EQUITY" ? "bg-surface-muted font-medium" : undefined)}
          empty={<p className="p-4 text-xs text-slate-500">No income or expense balances to close.</p>} />
        <KeyValues columns={4} items={[
          { label: "Income", value: formatAmount(t.income) },
          { label: "Expenses", value: formatAmount(t.expenses) },
          { label: netProfit < 0 ? "Net loss" : "Net profit", value: <strong className={netProfit < 0 ? "text-red-700" : "text-emerald-700"}>{formatAmount(Math.abs(netProfit))}</strong> },
          { label: "Next fiscal year", value: p.next_fiscal_year
            ? <Link className="link" to={`/admin/fiscal-years/${p.next_fiscal_year.id}`}>{p.next_fiscal_year.name}</Link>
            : <span className="text-amber-700">Not configured</span> },
        ]} />
      </Panel>

      {can("fiscal.close") ? (
        <Panel title="Close the fiscal year">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="max-w-2xl text-[13px] text-slate-600">
              Closing posts the closing journal, locks every period of {fy.name} and carries balances forward
              {p.next_fiscal_year ? ` to ${p.next_fiscal_year.name}` : ""}. It can be undone only by reopening the year, which needs a reason.
            </p>
            <Button variant="danger" disabled={!p.can_close} onClick={() => setClosing(true)}>Close {fy.name}</Button>
          </div>
        </Panel>
      ) : (
        <Alert tone="info">Running the year-end close needs the "Run year-end closing" permission.</Alert>
      )}

      <FormDialog<{ confirmation: string }> open={closing} onOpenChange={setClosing} size="sm" title={`Close fiscal year ${fy.name}?`}
        description="This posts the closing journal and locks every period." submitLabel="Close fiscal year"
        defaultValues={{ confirmation: "" }}
        onSubmit={async (v) => {
          await api.post(`/fiscal-years/${fy.id}/close/`, { confirmation: v.confirmation.trim() });
          invalidate();
          queryClient.invalidateQueries({ queryKey: ["fiscal-years", "closings", fy.id] });
          toast.success(`${fy.name} closed`);
        }}>
        <FormGrid columns={1}>
          <p className="text-[13px] text-slate-600">
            {netProfit < 0 ? "A net loss" : "A net profit"} of <strong>{formatAmount(Math.abs(netProfit))}</strong> will be transferred to retained earnings.
          </p>
          <FormField name="confirmation" label={<>Type <code className="rounded bg-surface-sunken px-1 font-mono text-slate-800">{fy.code}</code> to confirm</>}
            required autoFocus rules={{ validate: (v: string) => v.trim() === fy.code || `Type ${fy.code} exactly.` }} />
        </FormGrid>
      </FormDialog>
    </div>
  );
}

function ClosingHistory({ fy }: { fy: FiscalYear }) {
  const { session } = useAuth();
  const tz = session?.organization?.timezone;
  const query = useGet<ClosingRecord[]>(["fiscal-years", "closings", fy.id], `/fiscal-years/${fy.id}/closings/`);
  const columns: TableColumn<ClosingRecord>[] = [
    col.custom<ClosingRecord>("created_at", "Closed", (r) => formatDateTime(r.created_at, tz)),
    col.text<ClosingRecord>("closed_by_name", "By"),
    col.custom<ClosingRecord>("closing_journal", "Closing journal", (r) => (r.closing_journal
      ? <Link className="link" to={`/finance/journals/${r.closing_journal}`}>{r.closing_journal_number ?? `#${r.closing_journal}`}</Link> : "–")),
    col.money<ClosingRecord>("net", "Net result", {
      value: (r) => r.summary?.totals?.net_profit,
      render: (r) => {
        const net = r.summary?.totals?.net_profit;
        return <span className={cn(toNumber(net) < 0 && "text-red-700")}>{net !== undefined ? formatAmount(net) : "–"}</span>;
      },
    }),
    col.custom<ClosingRecord>("reopened_at", "State", (r) => (r.reopened_at
      ? <Badge tone="amber">Reopened {formatDateTime(r.reopened_at, tz)}</Badge> : <Badge tone="green">In effect</Badge>)),
  ];
  return (
    <Panel title="Closing history">
      <BaseTable<ClosingRecord> columns={columns} rows={query.data} loading={query.isLoading} error={query.error} onRetry={() => query.refetch()}
        density="compact" empty={{ title: "Not closed yet", description: `${fy.name} has never been closed.` }} />
    </Panel>
  );
}
