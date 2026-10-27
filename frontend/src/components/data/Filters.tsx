import { Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { DatePicker } from "@/calendar/DatePicker";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { Input, Select } from "@/components/ui/Input";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { useDebounce } from "@/hooks/useDebounce";
import { Button } from "@/components/ui/Button";

export type FilterDef =
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { type: "entity"; name: string; label: string; resource: string; params?: Record<string, string> }
  | { type: "boolean"; name: string; label: string };

export function SearchBox({ value, onChange, placeholder = "Search…" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  const debounced = useDebounce(text, 300);
  useEffect(() => { if (debounced !== value) onChange(debounced); }, [debounced]); // only push debounced edits
  useEffect(() => setText(value), [value]);
  return (
    <div className="relative w-full sm:w-56">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pl-8" aria-label="Search" />
    </div>
  );
}

/** Fiscal year + AD/BS date range. Explicit dates narrow the selected fiscal year on the server. */
export function PeriodFilter({ values, set, allowAll = true }: {
  values: Record<string, string>; set: (p: Record<string, string | null>) => void; allowAll?: boolean;
}) {
  const { years } = useFiscalYear();
  return (
    <>
      <Select aria-label="Fiscal year" className="w-[130px]" value={values.fiscal_year ?? ""} onChange={(e) => set({ fiscal_year: e.target.value })}>
        {allowAll && <option value="all">All years</option>}
        {years.map((fy) => <option key={fy.id} value={fy.id}>FY {fy.name}</option>)}
      </Select>
      <div className="flex items-center gap-1">
        <DatePicker compact value={values.date_from ?? ""} onChange={(v) => set({ date_from: v })} placeholder="From" className="w-[138px]" />
        <span className="text-slate-400">–</span>
        <DatePicker compact value={values.date_to ?? ""} onChange={(v) => set({ date_to: v })} placeholder="To" className="w-[138px]" />
      </div>
    </>
  );
}

export function FilterControls({ filters, values, set }: { filters: FilterDef[]; values: Record<string, string>; set: (p: Record<string, string | null>) => void }) {
  return (
    <>
      {filters.map((f) => {
        if (f.type === "select") {
          return (
            <Select key={f.name} aria-label={f.label} className="w-[170px]" value={values[f.name] ?? ""} onChange={(e) => set({ [f.name]: e.target.value })}>
              <option value="">{f.label}: all</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          );
        }
        if (f.type === "entity") {
          return (
            <div key={f.name} className="w-[210px]">
              <EntitySelect resource={f.resource} params={f.params} value={values[f.name] ? Number(values[f.name]) : null}
                onChange={(id) => set({ [f.name]: id ? String(id) : null })} placeholder={`${f.label}: all`} />
            </div>
          );
        }
        return (
          <label key={f.name} className="flex h-8 items-center gap-1.5 rounded border border-line-strong bg-white px-2.5 text-[13px] text-slate-700">
            <input type="checkbox" className="accent-brand-600" checked={values[f.name] === "true"}
              onChange={(e) => set({ [f.name]: e.target.checked ? "true" : null })} />
            {f.label}
          </label>
        );
      })}
    </>
  );
}

export function FilterBar({ children, onReset, active }: { children: ReactNode; onReset?: () => void; active?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-2 border-b border-line px-3 py-2.5">
      {children}
      {active && onReset && (
        <Button variant="ghost" size="md" icon={<X className="h-3.5 w-3.5" />} onClick={onReset}>Clear</Button>
      )}
    </div>
  );
}
