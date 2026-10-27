import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { CheckCircle2, Lock, LockOpen, Pencil, Plus, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useDetail, useGet, useOptions } from "@/api/hooks";
import type { AccountingPeriod, FiscalYear } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import {
  BS_MAX_YEAR, BS_MIN_YEAR, BS_MONTH_NAMES, BSDateError, addDays, adToBs, adToBsString, bsToAd, daysInBsMonth, isoToUtc, todayIn,
  utcToIso, type ISODate,
} from "@/calendar/bs";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { DataTable } from "@/components/data/DataTable";
import { col } from "@/components/data/columns";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock, Spinner } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select, Textarea } from "@/components/ui/Input";
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

export function FiscalYearList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const query = useOptions<FiscalYear>("fiscal-years");
  const columns = useMemo<ColDef[]>(() => [
    {
      field: "name", headerName: "Fiscal year", minWidth: 130, pinned: "left",
      cellRenderer: (p: ICellRendererParams<FiscalYear>) => <span className="font-medium text-brand-700">{p.value}</span>,
    },
    col.text("code", "Code", { minWidth: 100, maxWidth: 120 }),
    { colId: "start", headerName: "Starts", minWidth: 220, cellRenderer: (p: ICellRendererParams<FiscalYear>) => p.data ? <BothDates ad={p.data.start_date} bs={p.data.start_date_bs} /> : null },
    { colId: "end", headerName: "Ends", minWidth: 220, cellRenderer: (p: ICellRendererParams<FiscalYear>) => p.data ? <BothDates ad={p.data.end_date} bs={p.data.end_date_bs} /> : null },
    col.text("period_type", "Periods", { minWidth: 150, valueFormatter: (p) => periodTypeLabel(p.value) }),
    col.status("status", "Status", "status_label", { minWidth: 170, maxWidth: 210 }),
    col.status("opening_balance_status", "Opening balances", undefined, {
      cellRenderer: (p: ICellRendererParams<FiscalYear>) => <StatusBadge status={p.value} label={OPENING_LABELS[p.value]} />,
    }),
    col.status("closing_status", "Year-end close", undefined, {
      cellRenderer: (p: ICellRendererParams<FiscalYear>) => <StatusBadge status={p.value} label={CLOSING_LABELS[p.value]} />,
    }),
  ], []);
  return (
    <>
      <PageHeader title="Fiscal years"
        subtitle="Each fiscal year is split into accounting periods. Activating a year makes it current; the previous year stays open until its year-end close."
        actions={can("fiscal.manage") && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => navigate("/admin/fiscal-years/new")}>New fiscal year</Button>
        )} />
      <div className="panel overflow-hidden">
        <DataTable<FiscalYear> id="admin-fiscal-years" columns={columns} rows={query.data} loading={query.isLoading} error={query.error}
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

export function FiscalYearForm() {
  const { id } = useParams();
  const editing = !!id && id !== "new";
  const query = useDetail<FiscalYear>("fiscal-years", editing ? id : undefined);
  if (editing && query.isLoading) return <LoadingBlock />;
  if (editing && (query.error || !query.data)) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return <FiscalYearEditor key={id ?? "new"} existing={editing ? query.data! : null} />;
}

function FiscalYearEditor({ existing }: { existing: FiscalYear | null }) {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const invalidate = useInvalidateFiscal();
  const years = useOptions<FiscalYear>("fiscal-years");
  const tz = session?.organization?.timezone;

  const suggestedBsYear = useMemo(() => {
    const latest = (years.data ?? []).reduce<FiscalYear | null>((a, b) => (!a || b.end_date > a.end_date ? b : a), null);
    try {
      if (latest) {
        const next = adToBs(addDays(latest.end_date, 1));
        return next.month >= 4 ? next.year : next.year - 1;
      }
      const today = adToBs(todayIn(tz));
      return today.month >= 4 ? today.year : today.year - 1;
    } catch {
      return BS_MIN_YEAR;
    }
  }, [years.data, tz]);

  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.code ?? "");
  const [start, setStart] = useState<ISODate | "">(existing?.start_date ?? "");
  const [end, setEnd] = useState<ISODate | "">(existing?.end_date ?? "");
  const [periodType, setPeriodType] = useState<PeriodType>((existing?.period_type as PeriodType) ?? "BS_MONTHLY");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [bsYear, setBsYear] = useState<number | null>(null);
  const [adYear, setAdYear] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const fillBsYear = bsYear ?? suggestedBsYear;
  useEffect(() => {
    if (!adYear) setAdYear(String(Number(todayIn(tz).slice(0, 4)) + ((years.data?.length ?? 0) > 0 ? 1 : 0)));
  }, [tz, years.data, adYear]);

  const applyNepali = () => {
    try {
      const fy = nepaliFiscalYear(fillBsYear);
      setStart(fy.start); setEnd(fy.end); setName(fy.code); setCode(fy.code); setPeriodType("BS_MONTHLY");
      setErrors({});
    } catch (e) {
      toast.error(e instanceof BSDateError ? e.message : "That BS year is outside the supported calendar.");
    }
  };
  const applyCalendar = () => {
    const y = Number(adYear);
    if (!Number.isInteger(y) || y < 1919 || y > 2043) return toast.error("Enter an AD year between 1919 and 2043.");
    setStart(`${y}-01-01`); setEnd(`${y}-12-31`); setName(String(y)); setCode(String(y)); setPeriodType("AD_MONTHLY");
    setErrors({});
  };

  const preview = useMemo(() => {
    try {
      return { periods: start && end ? buildPeriods(start, end, periodType) : [], error: null as string | null };
    } catch (e) {
      return { periods: [], error: e instanceof Error ? e.message : "Cannot build periods for these dates." };
    }
  }, [start, end, periodType]);

  const overlaps = useMemo(() => (years.data ?? []).filter((fy) => fy.id !== existing?.id && start && end
    && fy.start_date <= end && fy.end_date >= start), [years.data, start, end, existing]);
  const length = start && end && end >= start ? daysBetween(start, end) + 1 : null;

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

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Enter a name, e.g. 2083/84.";
    if (!code.trim()) e.code = "Enter the code used in document numbers.";
    if (!start) e.start_date = "Choose the first day.";
    if (!end) e.end_date = "Choose the last day.";
    if (start && end && end <= start) e.end_date = "The end date must be after the start date.";
    if (length && length > 400) e.end_date = "A fiscal year cannot be longer than 400 days.";
    if (overlaps.length) e.end_date = `These dates overlap ${overlaps.map((o) => o.name).join(", ")}.`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body = { name: name.trim(), code: code.trim(), start_date: start, end_date: end, period_type: periodType, notes };
    try {
      const { data } = existing
        ? await api.patch<FiscalYear>(`/fiscal-years/${existing.id}/`, body)
        : await api.post<FiscalYear>("/fiscal-years/", body);
      invalidate();
      toast.success(existing ? `Fiscal year ${data.name} updated` : `Fiscal year ${data.name} created as draft`);
      navigate(`/admin/fiscal-years/${data.id}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const bsYears = Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR }, (_, i) => BS_MIN_YEAR + i);
  return (
    <>
      <PageHeader title={existing ? `Edit fiscal year ${existing.name}` : "New fiscal year"}
        back={existing ? { to: `/admin/fiscal-years/${existing.id}`, label: existing.name } : { to: "/admin/fiscal-years", label: "Fiscal years" }}
        subtitle="The year is saved as a draft with its accounting periods. Postings are allowed once it is activated." />
      <div className="space-y-4">
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
                <NumberInput className="w-24" value={adYear} onChange={(e) => setAdYear(e.target.value.replace(/\D/g, "").slice(0, 4))} />
              </Field>
              <Button onClick={applyCalendar}>Calendar year (AD)</Button>
            </div>
          </div>
        </Panel>

        <Panel title="Fiscal year">
          <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name" required error={errors.name} hint="Shown in menus and reports.">
              <Input value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} />
            </Field>
            <Field label="Code" required error={errors.code} hint="Used in document numbers, e.g. SI-2083/84-000001.">
              <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} invalid={!!errors.code} />
            </Field>
            <Field label="First day" required error={errors.start_date}>
              <DatePicker value={start} onChange={setStart} invalid={!!errors.start_date} />
            </Field>
            <Field label="Last day" required error={errors.end_date}>
              <DatePicker value={end} onChange={setEnd} min={start || undefined} invalid={!!errors.end_date} />
            </Field>
            <Field label="Accounting periods" error={errors.period_type}>
              <Select value={periodType} onChange={(e) => setPeriodType(e.target.value as PeriodType)}>
                {PERIOD_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Notes" error={errors.notes} className="sm:col-span-2 lg:col-span-3">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          {start && end && (
            <div className="border-t border-line px-4 py-2.5 text-[13px] text-slate-600">
              <BothDates ad={start} /> <span className="mx-1 text-slate-400">to</span> <BothDates ad={end} />
              {length !== null && <span className="ml-2 text-slate-500">({length} days)</span>}
            </div>
          )}
          {overlaps.length > 0 && (
            <Alert tone="error" className="mx-4 mb-4">These dates overlap {overlaps.map((o) => o.name).join(", ")}.</Alert>
          )}
        </Panel>

        <Panel title="Periods that will be created" actions={<span className="text-xs text-slate-500">Preview – generated by the server on save</span>}>
          {preview.error ? <Alert tone="error" className="m-4">{preview.error}</Alert>
            : !preview.periods.length ? <p className="p-4 text-xs text-slate-500">Choose the first and last day to preview the periods.</p>
              : <PeriodPreviewTable periods={preview.periods} />}
        </Panel>

        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={submit}>{existing ? "Save draft" : "Create fiscal year"}</Button>
        </div>
      </div>
    </>
  );
}

function PeriodPreviewTable({ periods }: { periods: PeriodPreview[] }) {
  return (
    <table className="w-full text-[13px]">
      <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
        <tr><th className="w-12 px-4 py-2">#</th><th className="px-4 py-2">Period</th><th className="px-4 py-2">From</th><th className="px-4 py-2">To</th><th className="px-4 py-2 text-right">Days</th></tr>
      </thead>
      <tbody>
        {periods.map((p) => (
          <tr key={p.number} className="border-b border-line last:border-0">
            <td className="px-4 py-1.5 text-slate-500">{p.number}</td>
            <td className="px-4 py-1.5 font-medium text-slate-800">{p.name}</td>
            <td className="px-4 py-1.5"><BothDates ad={p.start} /></td>
            <td className="px-4 py-1.5"><BothDates ad={p.end} /></td>
            <td className="num px-4 py-1.5">{daysBetween(p.start, p.end) + 1}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const canLock = can("fiscal.manage");
  const canUnlock = can("fiscal.reopen");
  const closed = fiscalYear.status === "CLOSED";

  const run = async () => {
    if (!action) return;
    if (action.kind === "unlock" && !reason.trim()) return;
    setBusy(true);
    try {
      await api.post(`/accounting-periods/${action.period.id}/${action.kind}/`, { reason: reason.trim() });
      invalidate();
      toast.success(action.kind === "lock" ? `${action.period.name} locked` : `${action.period.name} reopened`);
      setAction(null);
      setReason("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[13px]">
          <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
            <tr>
              <th className="w-10 px-4 py-2">#</th><th className="px-4 py-2">Period</th><th className="px-4 py-2">From</th><th className="px-4 py-2">To</th>
              <th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Journals</th><th className="px-4 py-2">Locked by</th><th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-muted">
                <td className="px-4 py-1.5 text-slate-500">{p.number}</td>
                <td className="px-4 py-1.5 font-medium text-slate-800">{p.name}</td>
                <td className="px-4 py-1.5"><BothDates ad={p.start_date} bs={p.start_date_bs} /></td>
                <td className="px-4 py-1.5"><BothDates ad={p.end_date} bs={p.end_date_bs} /></td>
                <td className="px-4 py-1.5"><StatusBadge status={p.status} /></td>
                <td className="num px-4 py-1.5">{p.journal_count ?? "–"}</td>
                <td className="px-4 py-1.5 text-xs text-slate-500">
                  {p.status === "LOCKED" && p.locked_by_name ? (
                    <span title={p.lock_reason || undefined}>{p.locked_by_name} · {formatDateTime(p.locked_at)}{p.lock_reason && <span className="block text-slate-400">{p.lock_reason}</span>}</span>
                  ) : "–"}
                </td>
                <td className="px-4 py-1.5 text-right">
                  {p.status === "OPEN" && canLock && !closed && (
                    <Button size="sm" icon={<Lock className="h-3 w-3" />} onClick={() => { setReason(""); setAction({ period: p, kind: "lock" }); }}>Lock</Button>
                  )}
                  {p.status === "LOCKED" && canUnlock && !closed && (
                    <Button size="sm" icon={<LockOpen className="h-3 w-3" />} onClick={() => { setReason(""); setAction({ period: p, kind: "unlock" }); }}>Unlock</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {closed && <p className="border-t border-line px-4 py-2 text-xs text-slate-500">{fiscalYear.name} is closed. Reopen the fiscal year before unlocking its periods.</p>}
      <Dialog open={!!action} onOpenChange={(o) => { if (!o) { setAction(null); setReason(""); } }} size="sm"
        title={action ? `${action.kind === "lock" ? "Lock" : "Unlock"} ${action.period.name}?` : ""}
        footer={<>
          <Button onClick={() => setAction(null)}>Cancel</Button>
          <Button variant={action?.kind === "unlock" ? "danger" : "primary"} loading={busy}
            disabled={action?.kind === "unlock" && !reason.trim()} onClick={run}>
            {action?.kind === "lock" ? "Lock period" : "Unlock period"}
          </Button>
        </>}>
        {action && (
          <div className="space-y-3">
            <p className="text-[13px] text-slate-600">
              {action.kind === "lock"
                ? <>No document dated between <DateText value={action.period.start_date} bs={action.period.start_date_bs} /> and <DateText value={action.period.end_date} bs={action.period.end_date_bs} /> can be posted, reversed or changed while the period is locked.</>
                : <>Postings dated inside {action.period.name} will be accepted again. Lock it again once the corrections are posted.</>}
            </p>
            <Field label={action.kind === "lock" ? "Reason (optional)" : "Reason"} required={action.kind === "unlock"}>
              <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={action.kind === "lock" ? "e.g. Month-end close" : "e.g. Post missing supplier bill"} />
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Detail
 * ---------------------------------------------------------------------------------------------- */

interface ClosingCheck { check: string; message: string; count?: number }
interface ClosingPreview {
  fiscal_year: { id: number; name: string; start_date: string; end_date: string; start_date_bs: string; end_date_bs: string };
  can_close: boolean;
  blockers: ClosingCheck[];
  warnings: ClosingCheck[];
  totals: Record<"ledger_debit" | "ledger_credit" | "inventory_gl" | "inventory_stock" | "receivables" | "payables" | "grni" | "income" | "expenses" | "net_profit", string>;
  cash_and_bank: { account: string; balance: string }[];
  closing_entries: { account_id: number; code: string; name: string; type: "INCOME" | "EXPENSE"; balance: string }[];
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

function YearEndClose({ fy }: { fy: FiscalYear }) {
  const { can } = useAuth();
  const invalidate = useInvalidateFiscal();
  const queryClient = useQueryClient();
  const [requested, setRequested] = useState(false);
  const [closing, setClosing] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
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

  const close = async () => {
    setBusy(true);
    try {
      await api.post(`/fiscal-years/${fy.id}/close/`, { confirmation: typed.trim() });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["fiscal-years", "closings", fy.id] });
      toast.success(`${fy.name} closed`);
      setClosing(false);
      setTyped("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

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
          {!p.cash_and_bank.length ? <p className="p-4 text-xs text-slate-500">No cash or bank accounts.</p> : (
            <table className="w-full text-[13px]">
              <tbody>
                {p.cash_and_bank.map((c) => (
                  <tr key={c.account} className="border-b border-line last:border-0">
                    <td className="px-4 py-1.5">{c.account}</td>
                    <td className={cn("num px-4 py-1.5", toNumber(c.balance) < 0 && "text-red-700")}>{formatAmount(c.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Closing entries"
        actions={<span className="text-xs text-slate-500">Posted as one journal dated <DateText value={p.fiscal_year.end_date} bs={p.fiscal_year.end_date_bs} /></span>}>
        {!p.closing_entries.length ? <p className="p-4 text-xs text-slate-500">No income or expense balances to close.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
                <tr><th className="px-4 py-2">Account</th><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right">Debit</th><th className="px-4 py-2 text-right">Credit</th></tr>
              </thead>
              <tbody>
                {p.closing_entries.map((e) => {
                  const net = toNumber(e.balance);
                  return (
                    <tr key={e.account_id} className="border-b border-line">
                      <td className="px-4 py-1.5"><span className="text-slate-500">{e.code}</span> {e.name}</td>
                      <td className="px-4 py-1.5 text-xs text-slate-500">{e.type === "INCOME" ? "Income" : "Expense"}</td>
                      <td className="num px-4 py-1.5">{net < 0 ? formatAmount(-net) : ""}</td>
                      <td className="num px-4 py-1.5">{net > 0 ? formatAmount(net) : ""}</td>
                    </tr>
                  );
                })}
                <tr className="border-b border-line bg-surface-muted font-medium">
                  <td className="px-4 py-1.5">Retained earnings – net result for the year</td>
                  <td className="px-4 py-1.5 text-xs text-slate-500">Equity</td>
                  <td className="num px-4 py-1.5">{netProfit < 0 ? formatAmount(-netProfit) : ""}</td>
                  <td className="num px-4 py-1.5">{netProfit > 0 ? formatAmount(netProfit) : ""}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
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
            <Button variant="danger" disabled={!p.can_close} onClick={() => { setTyped(""); setClosing(true); }}>Close {fy.name}</Button>
          </div>
        </Panel>
      ) : (
        <Alert tone="info">Running the year-end close needs the "Run year-end closing" permission.</Alert>
      )}

      <Dialog open={closing} onOpenChange={setClosing} size="sm" title={`Close fiscal year ${fy.name}?`}
        description="This posts the closing journal and locks every period."
        footer={<>
          <Button onClick={() => setClosing(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={typed.trim() !== fy.code} onClick={close}>Close fiscal year</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-[13px] text-slate-600">
            {netProfit < 0 ? "A net loss" : "A net profit"} of <strong>{formatAmount(Math.abs(netProfit))}</strong> will be transferred to retained earnings.
          </p>
          <Field label={<>Type <code className="rounded bg-surface-sunken px-1 font-mono text-slate-800">{fy.code}</code> to confirm</>}>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function ClosingHistory({ fy }: { fy: FiscalYear }) {
  const { session } = useAuth();
  const query = useGet<ClosingRecord[]>(["fiscal-years", "closings", fy.id], `/fiscal-years/${fy.id}/closings/`);
  if (query.isLoading) return <LoadingBlock />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const rows = query.data ?? [];
  return (
    <Panel title="Closing history">
      {!rows.length ? <EmptyState title="Not closed yet" description={`${fy.name} has never been closed.`} /> : (
        <table className="w-full text-[13px]">
          <thead className="border-b border-line bg-surface-muted text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2">Closed</th><th className="px-4 py-2">By</th><th className="px-4 py-2">Closing journal</th>
              <th className="px-4 py-2 text-right">Net result</th><th className="px-4 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const net = r.summary?.totals?.net_profit;
              return (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-1.5">{formatDateTime(r.created_at, session?.organization?.timezone)}</td>
                  <td className="px-4 py-1.5">{r.closed_by_name}</td>
                  <td className="px-4 py-1.5">
                    {r.closing_journal ? <Link className="link" to={`/finance/journals/${r.closing_journal}`}>{r.closing_journal_number ?? `#${r.closing_journal}`}</Link> : "–"}
                  </td>
                  <td className={cn("num px-4 py-1.5", toNumber(net) < 0 && "text-red-700")}>{net !== undefined ? formatAmount(net) : "–"}</td>
                  <td className="px-4 py-1.5">
                    {r.reopened_at ? <Badge tone="amber">Reopened {formatDateTime(r.reopened_at, session?.organization?.timezone)}</Badge> : <Badge tone="green">In effect</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
