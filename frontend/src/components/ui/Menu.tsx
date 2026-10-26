import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "end"; className?: string }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={4} className={cn("z-50 min-w-[180px] rounded-md border border-line bg-white p-1 shadow-pop", className)}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({ children, onSelect, disabled, danger, icon }: {
  children: ReactNode; onSelect?: () => void; disabled?: boolean; danger?: boolean; icon?: ReactNode;
}) {
  return (
    <DM.Item disabled={disabled} onSelect={onSelect}
      className={cn("flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none",
        "data-[highlighted]:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        danger ? "text-red-700" : "text-slate-700")}>
      {icon && <span className="text-slate-400">{icon}</span>}
      {children}
    </DM.Item>
  );
}

export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <DM.Label className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-slate-400">{children}</DM.Label>
);
