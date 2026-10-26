import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/api/client";
import { Button } from "./Button";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-slate-400", className)} aria-label="Loading" />;
}

export function LoadingBlock({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-16 text-sm text-slate-500", className)}>
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action, icon, className }: {
  title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-2 text-slate-300">{icon ?? <Inbox className="h-7 w-7" />}</div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)} role="alert">
      <AlertTriangle className="mb-2 h-6 w-6 text-amber-500" />
      <p className="text-sm font-medium text-slate-700">Could not load this information</p>
      <p className="mt-1 max-w-md text-xs text-slate-500">{errorMessage(error)}</p>
      {onRetry && <Button size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Alert({ tone = "info", title, children, className }: {
  tone?: "info" | "warning" | "error" | "success"; title?: string; children?: ReactNode; className?: string;
}) {
  const styles = {
    info: "border-brand-200 bg-brand-50 text-brand-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div className={cn("rounded border px-3 py-2 text-[13px]", styles, className)} role={tone === "error" ? "alert" : "status"}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn(title && "mt-0.5", "text-[13px] opacity-90")}>{children}</div>}
    </div>
  );
}
