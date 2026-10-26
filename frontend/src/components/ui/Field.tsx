import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export function Field({ label, htmlFor, error, hint, required, className, children }: {
  label: ReactNode; htmlFor?: string; error?: string; hint?: ReactNode; required?: boolean; className?: string; children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-slate-600">
        {label}
        {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-red-600" role="alert">{error}</p> : hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function FormSection({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel", className)}>
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="panel-title">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      <div className="grid gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}
