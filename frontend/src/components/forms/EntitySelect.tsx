import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/api/client";
import { cleanParams, type Params } from "@/api/hooks";
import type { Paginated } from "@/api/types";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/utils/cn";
import { Spinner } from "@/components/ui/Feedback";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EntitySelectProps {
  resource: string;
  value: number | null | undefined;
  onChange: (id: number | null, item: any | null) => void;
  params?: Params;
  label?: (item: any) => ReactNode;
  sublabel?: (item: any) => ReactNode;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  clearable?: boolean;
  className?: string;
  /** Text to show before the selected record has loaded (e.g. the name already in the document). */
  initialLabel?: string;
}

const defaultLabel = (item: any) => (item.code || item.sku ? `${item.code ?? item.sku} · ${item.name}` : item.name ?? item.number ?? `#${item.id}`);

/** Searchable, server-backed select for customers, suppliers, products, accounts... Keyboard: type, ↑/↓, Enter, Esc. */
export const EntitySelect = forwardRef<HTMLButtonElement, EntitySelectProps>(function EntitySelect(
  { resource, value, onChange, params = {}, label = defaultLabel, sublabel, placeholder = "Select…", disabled, invalid, id, clearable = true,
    className, initialLabel }, ref,
) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const debounced = useDebounce(search, 200);
  const listRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: [resource, "picker", debounced, cleanParams(params)],
    queryFn: async () => {
      const { data } = await api.get<Paginated<any> | any[]>(`/${resource}/`, { params: { search: debounced, page_size: 30, ...cleanParams(params) } });
      return Array.isArray(data) ? data.filter((d) => !debounced || JSON.stringify(d).toLowerCase().includes(debounced.toLowerCase())).slice(0, 50) : data.results;
    },
    enabled: open,
    staleTime: 30_000,
  });
  const selected = useQuery({
    queryKey: [resource, "detail", String(value)],
    queryFn: async () => (await api.get(`/${resource}/${value}/`)).data,
    enabled: !!value,
    staleTime: 60_000,
  });

  useEffect(() => setActive(0), [debounced]);
  const items = query.data ?? [];
  const choose = (item: any | null) => {
    onChange(item ? item.id : null, item);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <Popover.Trigger asChild>
        <button ref={ref} id={id} type="button" disabled={disabled} aria-invalid={invalid || undefined}
          className={cn("control flex items-center justify-between gap-1 text-left", invalid && "control-invalid", className)}
          onKeyDown={(e) => { if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { setSearch(e.key); setOpen(true); } }}>
          <span className={cn("truncate", !value && "text-slate-400")}>
            {value ? (selected.data ? label(selected.data) : initialLabel ?? "Loading…") : placeholder}
          </span>
          <span className="flex items-center gap-0.5 text-slate-400">
            {clearable && value && !disabled && (
              <span role="button" tabIndex={-1} aria-label="Clear" className="rounded p-0.5 hover:bg-surface-sunken hover:text-slate-700"
                onClick={(e) => { e.stopPropagation(); choose(null); }}><X className="h-3 w-3" /></span>
            )}
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[280px] rounded-md border border-line bg-white shadow-pop"
          onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="border-b border-line p-1.5">
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" aria-label="Search"
              className="h-7 w-full rounded px-2 text-[13px] outline-none"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === "Enter") { e.preventDefault(); if (items[active]) choose(items[active]); }
                if (e.key === "Escape") setOpen(false);
              }} />
          </div>
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {query.isLoading && <div className="flex justify-center py-4"><Spinner /></div>}
            {!query.isLoading && items.length === 0 && <div className="px-2 py-3 text-center text-xs text-slate-500">No matches</div>}
            {items.map((item: any, i: number) => (
              <div key={item.id} role="option" aria-selected={item.id === value} onMouseEnter={() => setActive(i)} onClick={() => choose(item)}
                className={cn("flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[13px]", i === active && "bg-surface-sunken")}>
                <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-600", item.id !== value && "invisible")} />
                <div className="min-w-0">
                  <div className="truncate text-slate-800">{label(item)}</div>
                  {sublabel && <div className="truncate text-2xs text-slate-500">{sublabel(item)}</div>}
                </div>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
