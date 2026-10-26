import * as RT from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export const Tabs = RT.Root;
export const TabPanel = RT.Content;

export function TabList({ tabs, className }: { tabs: { value: string; label: ReactNode; count?: number | null }[]; className?: string }) {
  return (
    <RT.List className={cn("flex gap-1 overflow-x-auto border-b border-line", className)}>
      {tabs.map((t) => (
        <RT.Trigger key={t.value} value={t.value}
          className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-slate-500 hover:text-slate-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-700">
          {t.label}
          {t.count != null && <span className="ml-1.5 rounded bg-surface-sunken px-1 text-2xs text-slate-500">{t.count}</span>}
        </RT.Trigger>
      ))}
    </RT.List>
  );
}
