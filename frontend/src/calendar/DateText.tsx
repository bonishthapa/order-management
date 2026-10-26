import { useAuth } from "@/auth/AuthContext";
import { formatDate } from "@/utils/format";
import type { DateDisplayMode } from "@/api/types";

/** Renders a business date in the user's AD/BS preference. */
export function DateText({ value, bs, mode, className }: { value: string | null | undefined; bs?: string | null; mode?: DateDisplayMode; className?: string }) {
  const { dateMode } = useAuth();
  if (!value) return <span className={className}>–</span>;
  const m = mode ?? dateMode;
  if (m === "AD_BS") {
    return (
      <span className={className} title={`AD ${value.slice(0, 10)}`}>
        {formatDate(value, "BS", bs)} <span className="text-slate-400">· {value.slice(0, 10)}</span>
      </span>
    );
  }
  return <span className={className}>{formatDate(value, m, bs)}</span>;
}

export function useDateFormatter() {
  const { dateMode } = useAuth();
  return (value: string | null | undefined, bs?: string | null) => formatDate(value, dateMode, bs);
}
