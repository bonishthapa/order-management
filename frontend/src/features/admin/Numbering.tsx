import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { useAuth } from "@/auth/AuthContext";
import { adToBs, todayIn } from "@/calendar/bs";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Alert } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, NumberInput, Select } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/Page";

interface NumberingPolicy {
  id: number;
  doc_type: string;
  doc_type_label: string;
  prefix: string;
  separator: string;
  reset_policy: ResetPolicy;
  padding: number;
  include_branch: boolean;
  example: string;
}
type ResetPolicy = "FISCAL_YEAR" | "CALENDAR_AD" | "CALENDAR_BS" | "CONTINUOUS";

const RESET_POLICIES: { value: ResetPolicy; label: string }[] = [
  { value: "FISCAL_YEAR", label: "Reset every fiscal year" },
  { value: "CALENDAR_AD", label: "Reset every AD calendar year" },
  { value: "CALENDAR_BS", label: "Reset every BS calendar year" },
  { value: "CONTINUOUS", label: "Never reset" },
];
const resetLabel = (v: string) => RESET_POLICIES.find((r) => r.value === v)?.label ?? v;

/** Document types that receive their number when created; all others are numbered when posted. */
const NUMBERED_ON_CREATE = new Set(["SO", "PO"]);

export function NumberingPage() {
  const { can } = useAuth();
  const query = useOptions<NumberingPolicy>("numbering-policies");
  const [editing, setEditing] = useState<NumberingPolicy | null>(null);
  const canManage = can("settings.manage");
  const rows = useMemo(() => [...(query.data ?? [])].sort((a, b) => a.doc_type_label.localeCompare(b.doc_type_label)), [query.data]);

  const columns = useMemo<ColDef[]>(() => [
    { field: "doc_type_label", headerName: "Document", minWidth: 200, flex: 2,
      cellRenderer: (p: ICellRendererParams<NumberingPolicy>) => <span className="font-medium text-slate-800">{p.value}</span> },
    { field: "prefix", headerName: "Prefix", minWidth: 90, maxWidth: 110 },
    { field: "separator", headerName: "Separator", minWidth: 90, maxWidth: 110,
      valueFormatter: (p) => (p.value ? `“${p.value}”` : "None") },
    { field: "reset_policy", headerName: "Counter reset", minWidth: 190, valueFormatter: (p) => resetLabel(p.value) },
    { field: "padding", headerName: "Digits", type: "rightAligned", cellClass: "num-cell", minWidth: 80, maxWidth: 100 },
    { field: "include_branch", headerName: "Branch code", minWidth: 110, maxWidth: 130,
      cellRenderer: (p: ICellRendererParams<NumberingPolicy>) => (p.value ? <Badge tone="blue">Included</Badge> : <span className="text-slate-400">No</span>) },
    { colId: "assigned", headerName: "Assigned on", minWidth: 120, maxWidth: 140,
      valueGetter: (p) => (p.data && NUMBERED_ON_CREATE.has(p.data.doc_type) ? "Creation" : "Posting") },
    { field: "example", headerName: "Next number", minWidth: 190, flex: 1.5,
      cellRenderer: (p: ICellRendererParams<NumberingPolicy>) => <code className="font-mono text-[12px] text-brand-700">{p.value}</code> },
  ], []);

  return (
    <>
      <PageHeader title="Document numbering"
        subtitle="Prefix and format of every document number. Changes apply to documents numbered from now on; issued numbers never change." />
      <Alert tone="info" className="mb-4">
        Numbers come from a database sequence per document type and counter scope, so two users can never receive the same number and a
        failed posting does not leave a gap. Sales and purchase orders are numbered when created; deliveries, invoices, receipts, bills,
        payments, returns, expenses, journals and stock documents are numbered when posted (drafts show “Draft”). The “Next number”
        column is a preview and is not reserved.
      </Alert>
      <div className="panel overflow-hidden">
        <DataTable<NumberingPolicy> id="admin-numbering" columns={columns} rows={rows} loading={query.isLoading} error={query.error}
          onRetry={() => query.refetch()} onRowClick={canManage ? setEditing : undefined}
          empty={{ title: "No numbering policies", description: "Policies are created with the organisation." }} />
      </div>
      {!canManage && <p className="mt-2 text-xs text-slate-500">Read only: changing numbering needs the “Change company settings” permission.</p>}
      {editing && <PolicyDialog policy={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PolicyDialog({ policy, onClose }: { policy: NumberingPolicy; onClose: () => void }) {
  const { session } = useAuth();
  const { current } = useFiscalYear();
  const queryClient = useQueryClient();
  const branches = useOptions<{ id: number; code: string }>("branches", { is_active: "true" });
  const [prefix, setPrefix] = useState(policy.prefix);
  const [separator, setSeparator] = useState(policy.separator);
  const [reset, setReset] = useState<ResetPolicy>(policy.reset_policy);
  const [padding, setPadding] = useState(String(policy.padding));
  const [includeBranch, setIncludeBranch] = useState(policy.include_branch);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const today = todayIn(session?.organization?.timezone);
  const counterChanges = reset !== policy.reset_policy || includeBranch !== policy.include_branch;
  const nextSeq = counterChanges ? 1 : Number(/(\d+)$/.exec(policy.example)?.[1] ?? "1");
  const scope = reset === "FISCAL_YEAR" ? current?.code ?? "FY"
    : reset === "CALENDAR_AD" ? today.slice(0, 4)
      : reset === "CALENDAR_BS" ? String(adToBs(today).year) : "";
  const pad = Math.min(Math.max(Number(padding) || 1, 1), 12);
  const branchCode = branches.data?.[0]?.code ?? "BR1";
  const preview = [prefix.toUpperCase() || "?", ...(includeBranch ? [branchCode] : []), ...(scope ? [scope] : []), String(nextSeq).padStart(pad, "0")]
    .join(separator);

  const save = async () => {
    const e: Record<string, string> = {};
    if (!prefix.trim()) e.prefix = "Enter a prefix.";
    else if (!/^[A-Za-z0-9/-]+$/.test(prefix.trim())) e.prefix = "Use letters, digits, '-' or '/'.";
    const n = Number(padding);
    if (!Number.isInteger(n) || n < 1 || n > 12) e.padding = "Between 1 and 12 digits.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      await api.patch(`/numbering-policies/${policy.id}/`, {
        prefix: prefix.trim().toUpperCase(), separator, reset_policy: reset, padding: n, include_branch: includeBranch,
      });
      queryClient.invalidateQueries({ queryKey: ["numbering-policies"] });
      toast.success(`${policy.doc_type_label} numbering updated`);
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${policy.doc_type_label} numbering`}
      description={NUMBERED_ON_CREATE.has(policy.doc_type) ? "Numbered when the document is created." : "Numbered when the document is posted."}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save numbering</Button></>}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Prefix" required error={errors.prefix}>
          <Input value={prefix} maxLength={12} onChange={(e) => setPrefix(e.target.value)} invalid={!!errors.prefix} />
        </Field>
        <Field label="Separator" error={errors.separator}>
          <Select value={separator} onChange={(e) => setSeparator(e.target.value)}>
            <option value="-">Hyphen “-”</option>
            <option value="/">Slash “/”</option>
            <option value=".">Dot “.”</option>
            <option value="">None</option>
          </Select>
        </Field>
        <Field label="Counter reset" error={errors.reset_policy}>
          <Select value={reset} onChange={(e) => setReset(e.target.value as ResetPolicy)}>
            {RESET_POLICIES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Digits" error={errors.padding} hint="Zero-padded sequence length.">
          <NumberInput value={padding} onChange={(e) => setPadding(e.target.value.replace(/\D/g, ""))} invalid={!!errors.padding} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={includeBranch} onChange={(e) => setIncludeBranch(e.target.checked)} />
          Include the branch code (each branch gets its own counter)
        </label>
        <div className="rounded border border-line bg-surface-muted px-3 py-2 sm:col-span-2">
          <div className="kv-label">Next number preview</div>
          <code className="mt-0.5 block font-mono text-sm text-brand-700">{preview}</code>
          {counterChanges && (
            <p className="mt-1 text-xs text-amber-700">Changing the reset rule or branch setting starts a separate counter, beginning at 1.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
