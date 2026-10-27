import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useGet } from "@/api/hooks";
import type { DateDisplayMode } from "@/api/types";
import { useAuth } from "@/auth/AuthContext";
import { BS_MAX_YEAR, BS_MIN_YEAR, BS_MONTH_NAMES, BS_MONTH_NAMES_NE, addDays, adToBs, todayIn, type ISODate } from "@/calendar/bs";
import { DatePicker } from "@/calendar/DatePicker";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingBlock, Spinner } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Input";
import { KeyValues, PageHeader, Panel } from "@/components/ui/Page";
import { cn } from "@/utils/cn";
import { formatDate } from "@/utils/format";

interface CalendarMeta { ad_min: string; ad_max: string; bs_min_year: number; bs_max_year: number; month_names: string[]; source: string }
interface Conversion { ad: string; bs: string; bs_month_name: string; weekday: string }
interface BsMonth { year: number; month: number; name: string; days: number; ad_start: string; ad_end: string; first_weekday: number }

const MODES: { value: DateDisplayMode; label: string }[] = [
  { value: "AD_BS", label: "AD + BS" }, { value: "BS", label: "BS only" }, { value: "AD", label: "AD only" },
];
const modeLabel = (m: string | undefined) => MODES.find((x) => x.value === m)?.label ?? "–";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const AD_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CalendarPreferencesPage() {
  const { session, dateMode, setDateMode, can } = useAuth();
  const org = session?.organization;
  const userMode = session?.user.date_display_mode ?? "";
  const meta = useGet<CalendarMeta>(["calendar", "meta"], "/calendar/meta/");
  const [saving, setSaving] = useState(false);
  const today = todayIn(org?.timezone);

  const changeMode = async (mode: DateDisplayMode) => {
    setSaving(true);
    try {
      await setDateMode(mode);
      toast.success(`Dates now shown as ${modeLabel(mode)}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Calendar preferences"
        subtitle="Dates are stored in AD and shown in Bikram Sambat, Gregorian or both. Conversion uses the same calendar table on the server and in the browser." />
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="My date display">
            <div className="space-y-3 p-4">
              <Field label="Show dates in" hint={userMode ? "Your personal choice overrides the organisation default." : "You are using the organisation default."}>
                <div className="flex items-center gap-2">
                  <Select className="w-48" value={dateMode} disabled={saving} onChange={(e) => changeMode(e.target.value as DateDisplayMode)}>
                    {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </Select>
                  {saving && <Spinner />}
                </div>
              </Field>
              <p className="text-xs text-slate-500">Today looks like: <span className="font-medium text-slate-700">{formatDate(today, dateMode)}</span></p>
            </div>
          </Panel>
          <Panel title="Organisation defaults"
            actions={can("settings.view") && <Link className="link text-xs" to="/admin/company">Company settings</Link>}>
            <KeyValues columns={2} items={[
              { label: "Default date display", value: modeLabel(org?.date_display_mode) },
              { label: "Date fields open in", value: org?.date_input_calendar === "AD" ? "Gregorian (AD)" : "Bikram Sambat (BS)" },
              { label: "Time zone", value: org?.timezone ?? "–" },
              { label: "Today (business date)", value: `BS ${formatDate(today, "BS")} · AD ${today}` },
            ]} />
          </Panel>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Converter today={today} />
          <Panel title="Supported range">
            {meta.isLoading ? <LoadingBlock /> : meta.error || !meta.data ? <ErrorState error={meta.error} onRetry={() => meta.refetch()} /> : (
              <KeyValues columns={2} items={[
                { label: "BS years", value: `${meta.data.bs_min_year} – ${meta.data.bs_max_year}` },
                { label: "AD dates", value: `${meta.data.ad_min} – ${meta.data.ad_max}` },
                { label: "Month names", value: meta.data.month_names.join(", "), wide: true },
                { label: "Calendar data", value: meta.data.source, wide: true },
              ]} />
            )}
          </Panel>
        </div>

        <MonthViewer today={today} />
      </div>
    </>
  );
}

function Converter({ today }: { today: ISODate }) {
  const [date, setDate] = useState<ISODate | "">(today);
  const query = useGet<Conversion>(["calendar", "convert", date], "/calendar/convert/", { ad: date }, !!date);
  return (
    <Panel title="BS ↔ AD converter">
      <div className="space-y-3 p-4">
        <Field label="Date" hint="Type in either calendar; switch with the AD/BS button inside the field.">
          <DatePicker value={date} onChange={setDate} className="max-w-xs" />
        </Field>
        {date && (
          query.isLoading ? <Spinner /> : query.error ? <p className="text-xs text-red-600">{errorMessage(query.error)}</p> : query.data && (
            <dl className="grid grid-cols-2 gap-3 rounded border border-line bg-surface-muted p-3">
              <div><dt className="kv-label">Bikram Sambat</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{query.data.bs}</dd>
                <dd className="text-xs text-slate-500">{Number(query.data.bs.slice(8))} {query.data.bs_month_name} {query.data.bs.slice(0, 4)}</dd></div>
              <div><dt className="kv-label">Gregorian</dt><dd className="mt-0.5 text-sm font-medium tabular-nums">{query.data.ad}</dd>
                <dd className="text-xs text-slate-500">{query.data.weekday}</dd></div>
            </dl>
          )
        )}
      </div>
    </Panel>
  );
}

function MonthViewer({ today }: { today: ISODate }) {
  const now = adToBs(today);
  const [view, setView] = useState({ year: now.year, month: now.month });
  const query = useGet<BsMonth>(["calendar", "bs-month", view.year, view.month], "/calendar/bs-month/", view);
  const shift = (delta: number) => {
    const index = view.year * 12 + (view.month - 1) + delta;
    const year = Math.floor(index / 12);
    if (year < BS_MIN_YEAR || year > BS_MAX_YEAR) return;
    setView({ year, month: (index % 12) + 1 });
  };
  const years = Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR + 1 }, (_, i) => BS_MIN_YEAR + i);
  const m = query.data;
  const cells: (ISODate | null)[] = m ? [...Array(m.first_weekday).fill(null), ...Array.from({ length: m.days }, (_, i) => addDays(m.ad_start, i))] : [];
  while (cells.length % 7) cells.push(null);

  return (
    <Panel title="BS month calendar"
      actions={<div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
        <Select aria-label="BS month" className="w-32" value={view.month} onChange={(e) => setView({ ...view, month: Number(e.target.value) })}>
          {BS_MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
        </Select>
        <Select aria-label="BS year" className="w-24" value={view.year} onChange={(e) => setView({ ...view, year: Number(e.target.value) })}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
        <Button size="sm" variant="ghost" aria-label="Next month" onClick={() => shift(1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
        <Button size="sm" onClick={() => setView({ year: now.year, month: now.month })}>Today</Button>
      </div>}>
      {query.isLoading ? <LoadingBlock /> : query.error || !m ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : (
        <div className="p-4">
          <p className="mb-3 text-[13px] text-slate-600">
            <span className="font-medium text-slate-800">{m.name} {m.year}</span> ({BS_MONTH_NAMES_NE[m.month - 1]}) · {m.days} days ·
            AD {m.ad_start} to {m.ad_end}
          </p>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded border border-line bg-line text-[13px]">
            {WEEKDAYS.map((d) => <div key={d} className="bg-surface-muted px-2 py-1.5 text-center text-2xs font-semibold uppercase text-slate-500">{d.slice(0, 3)}</div>)}
            {cells.map((iso, i) => {
              if (!iso) return <div key={`e${i}`} className="min-h-[56px] bg-surface-muted/60" />;
              const bsDay = i - m.first_weekday + 1;
              const adDay = Number(iso.slice(8));
              const showMonth = bsDay === 1 || adDay === 1;
              return (
                <div key={iso} className={cn("min-h-[56px] bg-white px-2 py-1.5", iso === today && "bg-brand-50 ring-1 ring-inset ring-brand-300",
                  i % 7 === 6 && "text-red-700")}>
                  <div className="text-base font-semibold tabular-nums">{bsDay}</div>
                  <div className="text-2xs tabular-nums text-slate-500">
                    {adDay}{showMonth && ` ${AD_MONTH_SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">Large numbers are BS days; small numbers are the AD date. Saturdays are shown in red.</p>
        </div>
      )}
    </Panel>
  );
}
