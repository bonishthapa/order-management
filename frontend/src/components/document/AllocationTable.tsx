import { BaseTable, col } from "@/components/table";
import { Button } from "@/components/ui/Button";
import { NumberInput } from "@/components/ui/Input";
import { formatAmount, round2, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";

export interface OpenDocument {
  id: number;
  number: string;
  date: string;
  due_date: string;
  total: string;
  balance_due: string;
  reference?: string;
}

/**
 * Allocate a payment across open invoices/bills. Amounts are validated here for convenience and
 * re-validated on the server (balance, party, over-allocation).
 */
export function AllocationTable({ documents, allocations, onChange, available }: {
  documents: OpenDocument[]; allocations: Record<number, string>; onChange: (a: Record<number, string>) => void; available: number;
}) {
  const allocated = round2(Object.values(allocations).reduce((s, v) => s + toNumber(v), 0));
  const remaining = round2(available - allocated);
  const autoAllocate = () => {
    let left = available;
    const next: Record<number, string> = {};
    [...documents].sort((a, b) => a.due_date.localeCompare(b.due_date)).forEach((d) => {
      const take = Math.min(toNumber(d.balance_due), left);
      if (take > 0) next[d.id] = take.toFixed(2);
      left = round2(left - take);
    });
    onChange(next);
  };
  if (!documents.length) return <p className="p-4 text-xs text-slate-500">No open documents. The full amount is recorded as an advance.</p>;
  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-500">
        <span>Oldest due first is the usual choice.</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>Clear</Button>
          <Button size="sm" onClick={autoAllocate} disabled={available <= 0}>Allocate oldest first</Button>
        </div>
      </div>
      <BaseTable rows={documents} minWidth={640} density="compact" columns={[
        col.custom("number", "Document", (d) => <span className="font-medium">{d.number}{d.reference && <span className="ml-1 text-2xs font-normal text-slate-500">{d.reference}</span>}</span>),
        col.date("date", "Date"),
        col.date("due_date", "Due"),
        col.money("total", "Total"),
        col.money("balance_due", "Outstanding"),
        col.custom("allocate", "Allocate", (d) => {
          const value = allocations[d.id] ?? "";
          return (
            <NumberInput aria-label={`Allocate to ${d.number}`} value={value} invalid={toNumber(value) > toNumber(d.balance_due)}
              onChange={(e) => onChange({ ...allocations, [d.id]: e.target.value })}
              onDoubleClick={() => onChange({ ...allocations, [d.id]: Math.min(toNumber(d.balance_due), Math.max(remaining + toNumber(value), 0)).toFixed(2) })} />
          );
        }, { width: 150, align: "right" }),
      ]} />
      <div className="flex justify-end gap-6 px-4 py-2 text-[13px]">
        <span>Allocated <strong className="tabular-nums">{formatAmount(allocated)}</strong></span>
        <span className={cn(remaining < 0 && "text-red-600")}>{remaining < 0 ? "Over-allocated" : "Unapplied (advance)"} <strong className="tabular-nums">{formatAmount(Math.abs(remaining))}</strong></span>
      </div>
    </div>
  );
}

export const allocationPayload = (allocations: Record<number, string>) =>
  Object.entries(allocations).filter(([, v]) => toNumber(v) > 0).map(([document, amount]) => ({ document: Number(document), amount }));
