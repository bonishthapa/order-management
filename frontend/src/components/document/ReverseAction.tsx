import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";

/** Reversal posts an equal and opposite entry dated today (or the document date); the original stays on record. */
export function ReverseAction({ label = "Reverse", title, description, onReverse, loading }: {
  label?: string; title: string; description?: React.ReactNode; loading?: boolean; onReverse: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>{label}</Button>
      <ConfirmDialog open={open} onOpenChange={setOpen} title={title} tone="danger" requireReason confirmLabel={label} loading={loading}
        description={description ?? "A reversing entry is posted and the original is kept for the audit trail. This cannot be undone."}
        onConfirm={(reason) => onReverse(reason).then(() => setOpen(false))} />
    </>
  );
}
