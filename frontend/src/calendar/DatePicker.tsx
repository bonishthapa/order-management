import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAuth } from "@/auth/AuthContext";
import { cn } from "@/utils/cn";
import {
  BS_MONTH_NAMES, BSDateError, addDays, adToBs, adToBsString, bsToAd, daysInBsMonth, formatBs, isoToUtc, parseBs, todayIn,
  weekdayOf, type ISODate,
} from "./bs";

type Calendar = "AD" | "BS";

export interface DatePickerProps {
  value: ISODate | "" | null | undefined;
  onChange: (value: ISODate | "") => void;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  min?: ISODate;
  max?: ISODate;
  placeholder?: string;
  className?: string;
  /** Hide the converted date shown under the input (e.g. inside compact filters). */
  compact?: boolean;
  onBlur?: () => void;
}

const AD_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function parseInput(text: string, calendar: Calendar): ISODate {
  const trimmed = text.trim().replace(/[/.]/g, "-");
  if (calendar === "BS") return bsToAd(parseBs(trimmed));
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!m) throw new BSDateError("Enter the AD date as YYYY-MM-DD.");
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  isoToUtc(iso);
  adToBs(iso); // must be inside the supported calendar range
  return iso;
}

function display(value: ISODate | "" | null | undefined, calendar: Calendar) {
  if (!value) return "";
  return calendar === "BS" ? adToBsString(value) : value;
}

export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { value, onChange, id, required, disabled, invalid, min, max, placeholder, className, compact, onBlur }, ref,
) {
  const { session } = useAuth();
  const preferred = (session?.organization?.date_input_calendar ?? "BS") as Calendar;
  const [calendar, setCalendar] = useState<Calendar>(preferred);
  const [text, setText] = useState(display(value, calendar));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setText(display(value, calendar));
    setError(null);
  }, [value, calendar]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      setError(null);
      if (value) onChange("");
      return;
    }
    try {
      const iso = parseInput(raw, calendar);
      if (min && iso < min) throw new BSDateError(`The date cannot be before ${display(min, calendar)}.`);
      if (max && iso > max) throw new BSDateError(`The date cannot be after ${display(max, calendar)}.`);
      setError(null);
      if (iso !== value) onChange(iso);
      setText(display(iso, calendar));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid date");
    }
  };

  const other: Calendar = calendar === "BS" ? "AD" : "BS";
  const hint = value ? `${other} ${display(value, other)}` : calendar === "BS" ? "YYYY-MM-DD (BS)" : "YYYY-MM-DD (AD)";
  const tz = session?.organization?.timezone ?? "Asia/Kathmandu";

  return (
    <div className={cn("min-w-0", className)}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div className={cn("control flex items-center gap-1 px-0 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100",
          (invalid || error) && "control-invalid", disabled && "bg-surface-sunken")}>
          <input
            ref={ref}
            id={id}
            value={text}
            disabled={disabled}
            required={required}
            aria-invalid={invalid || !!error || undefined}
            aria-describedby={id ? `${id}-hint` : undefined}
            placeholder={placeholder ?? (calendar === "BS" ? "BS YYYY-MM-DD" : "AD YYYY-MM-DD")}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-[13px] tabular-nums outline-none"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { commit(text); onBlur?.(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(text); }
              if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); setOpen(true); }
              if (e.key.toLowerCase() === "t" && e.altKey) { e.preventDefault(); onChange(todayIn(tz)); }
            }}
          />
          <button type="button" disabled={disabled} onClick={() => setCalendar(other)} title={`Enter in ${other}`}
            className="rounded px-1 text-2xs font-semibold text-slate-500 hover:bg-surface-sunken hover:text-brand-700">
            {calendar}
          </button>
          <Popover.Trigger asChild>
            <button type="button" disabled={disabled} aria-label="Open calendar" className="mr-1 rounded p-1 text-slate-400 hover:bg-surface-sunken hover:text-slate-700">
              <CalendarDays className="h-3.5 w-3.5" />
            </button>
          </Popover.Trigger>
        </div>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-50 rounded-md border border-line bg-white p-2 shadow-pop">
            <CalendarGrid calendar={calendar} value={value || null} min={min} max={max} today={todayIn(tz)}
              onSelect={(iso) => { onChange(iso); setOpen(false); }} onSwitchCalendar={() => setCalendar(other)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {!compact && (
        <p id={id ? `${id}-hint` : undefined} className={cn("mt-0.5 text-2xs", error ? "text-red-600" : "text-slate-400")}>
          {error ?? hint}
        </p>
      )}
      {compact && error && <p className="mt-0.5 text-2xs text-red-600">{error}</p>}
    </div>
  );
});

interface MonthView { year: number; month: number }

function monthStart(view: MonthView, calendar: Calendar): ISODate {
  return calendar === "BS" ? bsToAd({ year: view.year, month: view.month, day: 1 }) : `${view.year}-${String(view.month).padStart(2, "0")}-01`;
}
function monthLength(view: MonthView, calendar: Calendar): number {
  return calendar === "BS" ? daysInBsMonth(view.year, view.month) : new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
}
function viewOf(iso: ISODate, calendar: Calendar): MonthView {
  if (calendar === "BS") {
    const b = adToBs(iso);
    return { year: b.year, month: b.month };
  }
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}
function shift(view: MonthView, delta: number): MonthView {
  const index = view.year * 12 + (view.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function CalendarGrid({ calendar, value, today, min, max, onSelect, onSwitchCalendar }: {
  calendar: Calendar; value: ISODate | null; today: ISODate; min?: ISODate; max?: ISODate;
  onSelect: (iso: ISODate) => void; onSwitchCalendar: () => void;
}) {
  const [focus, setFocus] = useState<ISODate>(value ?? today);
  const [view, setView] = useState<MonthView>(() => viewOf(value ?? today, calendar));
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => setView(viewOf(focus, calendar)), [calendar]); // re-anchor the visible month when the calendar switches

  const days = useMemo(() => {
    try {
      const start = monthStart(view, calendar);
      const length = monthLength(view, calendar);
      const lead = weekdayOf(start);
      return { cells: [...Array(lead).fill(null), ...Array.from({ length }, (_, i) => addDays(start, i))] as (ISODate | null)[] };
    } catch {
      return { cells: [] as (ISODate | null)[] };
    }
  }, [view, calendar]);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus();
  }, [focus, days]);

  const move = (delta: number) => {
    const next = addDays(focus, delta);
    setFocus(next);
    const v = viewOf(next, calendar);
    if (v.year !== view.year || v.month !== view.month) setView(v);
  };

  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, () => void> = {
      ArrowLeft: () => move(-1), ArrowRight: () => move(1), ArrowUp: () => move(-7), ArrowDown: () => move(7),
      PageUp: () => { const v = shift(view, -1); setView(v); setFocus(monthStart(v, calendar)); },
      PageDown: () => { const v = shift(view, 1); setView(v); setFocus(monthStart(v, calendar)); },
      Home: () => setFocus(monthStart(view, calendar)),
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  };

  const title = calendar === "BS" ? `${BS_MONTH_NAMES[view.month - 1]} ${view.year}` : `${AD_MONTHS[view.month - 1]} ${view.year}`;
  return (
    <div className="w-[260px] select-none" onKeyDown={onKey}>
      <div className="mb-1 flex items-center justify-between">
        <button type="button" className="rounded p-1 hover:bg-surface-sunken" aria-label="Previous month" onClick={() => setView(shift(view, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-[13px] font-semibold text-slate-700">
          {title} <span className="text-2xs font-medium text-slate-400">{calendar}</span>
        </div>
        <button type="button" className="rounded p-1 hover:bg-surface-sunken" aria-label="Next month" onClick={() => setView(shift(view, 1))}>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-2xs font-medium text-slate-400">
        {WEEKDAYS.map((d, i) => <div key={d} className={cn("py-1", i === 6 && "text-red-400")}>{d}</div>)}
      </div>
      <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-px">
        {days.cells.map((iso, i) => {
          if (!iso) return <div key={`e${i}`} />;
          const disabled = (min && iso < min) || (max && iso > max);
          const day = calendar === "BS" ? adToBs(iso).day : Number(iso.slice(8));
          const otherLabel = calendar === "BS" ? Number(iso.slice(8)) : adToBs(iso).day;
          return (
            <button key={iso} type="button" data-date={iso} disabled={!!disabled} tabIndex={iso === focus ? 0 : -1}
              title={calendar === "BS" ? `AD ${iso}` : `BS ${formatBs(adToBs(iso))}`}
              onClick={() => onSelect(iso)} onFocus={() => setFocus(iso)}
              className={cn("relative flex h-8 flex-col items-center justify-center rounded text-[13px] tabular-nums hover:bg-brand-50",
                iso === value && "bg-brand-600 text-white hover:bg-brand-700",
                iso === today && iso !== value && "ring-1 ring-inset ring-brand-400",
                weekdayOf(iso) === 6 && iso !== value && "text-red-600",
                disabled && "cursor-not-allowed opacity-30")}>
              <span className="leading-none">{day}</span>
              <span className={cn("text-[9px] leading-none", iso === value ? "text-brand-100" : "text-slate-400")}>{otherLabel}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
        <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onSelect(today)}>Today</button>
        <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={onSwitchCalendar}>
          Show {calendar === "BS" ? "AD" : "BS"} calendar
        </button>
      </div>
    </div>
  );
}

