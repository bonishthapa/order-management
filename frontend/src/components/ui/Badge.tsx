import { cn } from "@/utils/cn";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "slate";
const tones: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  slate: "bg-white text-slate-600 ring-slate-300",
  blue: "bg-brand-50 text-brand-700 ring-brand-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-2xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

/** One consistent mapping from document/payment status codes to a small set of colours. */
const STATUS_TONES: Record<string, Tone> = {
  DRAFT: "slate", SUBMITTED: "amber", APPROVED: "blue", REJECTED: "red", PARTIAL: "amber", COMPLETED: "green",
  CANCELLED: "neutral", POSTED: "green", REVERSED: "neutral", IN_TRANSIT: "amber", RECEIVED: "green",
  UNPAID: "red", PAID: "green", OPEN: "green", LOCKED: "neutral", ACTIVE: "green", CLOSING: "amber", CLOSED: "neutral",
  REOPENED: "amber", PENDING: "amber", CARRIED_FORWARD: "blue", RESTOCK: "green", DAMAGED: "red",
};
const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Awaiting approval", PARTIAL: "Partial", IN_TRANSIT: "In transit", POSTED: "Posted", CLOSING: "Pending close",
};

export function StatusBadge({ status, label, className }: { status: string | null | undefined; label?: string; className?: string }) {
  if (!status) return null;
  const text = label ?? STATUS_LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  return <Badge tone={STATUS_TONES[status] ?? "neutral"} className={className}>{text}</Badge>;
}
