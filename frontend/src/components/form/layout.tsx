import type { ReactNode } from "react";
import { Panel } from "@/components/ui/Page";
import { cn } from "@/utils/cn";

const COLS = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" };

/** Grid of form fields without a frame (dialogs, nested blocks). */
export function FormGrid({ columns = 2, children, className }: { columns?: 1 | 2 | 3 | 4; children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-x-4 gap-y-3", COLS[columns], className)}>{children}</div>;
}

/** A titled panel of form fields; page forms are made of one or more sections. */
export function FormSection({ title, description, actions, columns = 4, children, bodyClassName }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; columns?: 1 | 2 | 3 | 4; children: ReactNode; bodyClassName?: string;
}) {
  return (
    <Panel title={title} actions={actions}>
      {description && <p className="border-b border-line px-4 py-2 text-xs text-slate-500">{description}</p>}
      <div className={cn("p-4", bodyClassName)}><FormGrid columns={columns}>{children}</FormGrid></div>
    </Panel>
  );
}
