import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import { Field } from "./Field";
import { Textarea } from "./Input";

export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md" }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; children?: ReactNode;
  footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl";
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-slate-900/30" />
        <RD.Content className={cn("fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] -translate-x-1/2 rounded-md border border-line bg-white shadow-pop", width)}>
          <div className="flex items-start justify-between border-b border-line px-4 py-3">
            <div>
              <RD.Title className="text-sm font-semibold text-slate-800">{title}</RD.Title>
              {description ? <RD.Description className="mt-0.5 text-xs text-slate-500">{description}</RD.Description>
                : <RD.Description className="sr-only">{title}</RD.Description>}
            </div>
            <RD.Close className="rounded p-1 text-slate-400 hover:bg-surface-sunken hover:text-slate-700" aria-label="Close"><X className="h-4 w-4" /></RD.Close>
          </div>
          {children && <div className="max-h-[65vh] overflow-y-auto px-4 py-3">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface-muted px-4 py-2.5">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Confirmation for significant actions. ``requireReason`` collects the reason the audit trail needs. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", tone = "primary", requireReason,
  reasonLabel = "Reason", onConfirm, loading }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; confirmLabel?: string;
  tone?: "primary" | "danger"; requireReason?: boolean; reasonLabel?: string; loading?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setReason(""); onOpenChange(o); }} title={title} size="sm"
      footer={<>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} loading={loading} disabled={requireReason && !reason.trim()}
          onClick={async () => { await onConfirm(reason.trim()); setReason(""); }}>{confirmLabel}</Button>
      </>}>
      {description && <div className="text-[13px] text-slate-600">{description}</div>}
      {requireReason && (
        <Field label={reasonLabel} required className="mt-3">
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      )}
    </Dialog>
  );
}
