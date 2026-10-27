import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { useAuth } from "@/auth/AuthContext";
import { adToBs, todayIn } from "@/calendar/bs";
import { FormDialog, FormField, FormGrid, useWatch } from "@/components/form";
import { DataGrid, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Feedback";
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

interface PolicyValues {
  prefix: string;
  separator: string;
  reset_policy: ResetPolicy;
  padding: string;
  include_branch: boolean;
}

const RESET_POLICIES: { value: ResetPolicy; label: string }[] = [
  { value: "FISCAL_YEAR", label: "Reset every fiscal year" },
  { value: "CALENDAR_AD", label: "Reset every AD calendar year" },
  { value: "CALENDAR_BS", label: "Reset every BS calendar year" },
  { value: "CONTINUOUS", label: "Never reset" },
];
const SEPARATORS = [
  { value: "-", label: "Hyphen “-”" }, { value: "/", label: "Slash “/”" }, { value: ".", label: "Dot “.”" }, { value: "", label: "None" },
];
const resetLabel = (v: string) => RESET_POLICIES.find((r) => r.value === v)?.label ?? v;

/** Document types that receive their number when created; all others are numbered when posted. */
const NUMBERED_ON_CREATE = new Set(["SO", "PO"]);
const assignedOn = (p: NumberingPolicy) => (NUMBERED_ON_CREATE.has(p.doc_type) ? "Creation" : "Posting");

const COLUMNS: TableColumn<NumberingPolicy>[] = [
  col.custom<NumberingPolicy>("doc_type_label", "Document", (p) => <span className="font-medium text-slate-800">{p.doc_type_label}</span>,
    { minWidth: 200, flex: 2 }),
  col.text<NumberingPolicy>("prefix", "Prefix", { minWidth: 90 }),
  col.text<NumberingPolicy>("separator", "Separator", { minWidth: 90, value: (p) => (p.separator ? `“${p.separator}”` : "None") }),
  col.text<NumberingPolicy>("reset_policy", "Counter reset", { minWidth: 190, value: (p) => resetLabel(p.reset_policy) }),
  col.number<NumberingPolicy>("padding", "Digits", { minWidth: 80 }),
  col.custom<NumberingPolicy>("include_branch", "Branch code",
    (p) => (p.include_branch ? <Badge tone="blue">Included</Badge> : <span className="text-slate-400">No</span>),
    { minWidth: 110, value: (p) => (p.include_branch ? "Included" : "No") }),
  col.text<NumberingPolicy>("assigned", "Assigned on", { minWidth: 120, value: assignedOn }),
  col.custom<NumberingPolicy>("example", "Next number", (p) => <code className="font-mono text-[12px] text-brand-700">{p.example}</code>,
    { minWidth: 190, flex: 1.5 }),
];

export function NumberingPage() {
  const { can } = useAuth();
  const query = useOptions<NumberingPolicy>("numbering-policies");
  const [editing, setEditing] = useState<NumberingPolicy | null>(null);
  const canManage = can("settings.manage");
  const rows = useMemo(() => [...(query.data ?? [])].sort((a, b) => a.doc_type_label.localeCompare(b.doc_type_label)), [query.data]);

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
        <DataGrid<NumberingPolicy> id="admin-numbering" columns={COLUMNS} rows={rows} loading={query.isLoading} error={query.error}
          onRetry={() => query.refetch()} onRowClick={canManage ? setEditing : undefined}
          empty={{ title: "No numbering policies", description: "Policies are created with the organisation." }} />
      </div>
      {!canManage && <p className="mt-2 text-xs text-slate-500">Read only: changing numbering needs the “Change company settings” permission.</p>}
      {editing && <PolicyDialog policy={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PolicyDialog({ policy, onClose }: { policy: NumberingPolicy; onClose: () => void }) {
  const queryClient = useQueryClient();
  return (
    <FormDialog<PolicyValues> open onOpenChange={(o) => !o && onClose()} title={`${policy.doc_type_label} numbering`}
      description={NUMBERED_ON_CREATE.has(policy.doc_type) ? "Numbered when the document is created." : "Numbered when the document is posted."}
      submitLabel="Save numbering"
      defaultValues={{
        prefix: policy.prefix, separator: policy.separator, reset_policy: policy.reset_policy, padding: String(policy.padding),
        include_branch: policy.include_branch,
      }}
      onSubmit={async (v) => {
        await api.patch(`/numbering-policies/${policy.id}/`, {
          prefix: v.prefix.trim().toUpperCase(), separator: v.separator ?? "", reset_policy: v.reset_policy, padding: Number(v.padding),
          include_branch: v.include_branch,
        });
        queryClient.invalidateQueries({ queryKey: ["numbering-policies"] });
        toast.success(`${policy.doc_type_label} numbering updated`);
      }}>
      <FormGrid columns={2}>
        <FormField name="prefix" label="Prefix" required maxLength={12} uppercase
          rules={{ pattern: { value: /^[A-Za-z0-9/-]+$/, message: "Use letters, digits, '-' or '/'." } }} />
        <FormField name="separator" label="Separator" type="select" emptyOption={false} options={SEPARATORS} />
        <FormField name="reset_policy" label="Counter reset" type="select" emptyOption={false} options={RESET_POLICIES} />
        <FormField name="padding" label="Digits" type="number" required hint="Zero-padded sequence length."
          rules={{ validate: (v: string) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 12) || "Between 1 and 12 digits." }} />
        <FormField name="include_branch" label="Branch code" type="checkbox" span="full"
          hint="Include the branch code (each branch gets its own counter)" />
        <NumberPreview policy={policy} />
      </FormGrid>
    </FormDialog>
  );
}

function NumberPreview({ policy }: { policy: NumberingPolicy }) {
  const { session } = useAuth();
  const { current } = useFiscalYear();
  const branches = useOptions<{ id: number; code: string }>("branches", { is_active: "true" });
  const [prefix, separator, reset, padding, includeBranch] = useWatch({
    name: ["prefix", "separator", "reset_policy", "padding", "include_branch"],
  }) as [string, string, ResetPolicy, string, boolean];
  const today = todayIn(session?.organization?.timezone);
  const counterChanges = reset !== policy.reset_policy || includeBranch !== policy.include_branch;
  const nextSeq = counterChanges ? 1 : Number(/(\d+)$/.exec(policy.example)?.[1] ?? "1");
  const scope = reset === "FISCAL_YEAR" ? current?.code ?? "FY"
    : reset === "CALENDAR_AD" ? today.slice(0, 4)
      : reset === "CALENDAR_BS" ? String(adToBs(today).year) : "";
  const pad = Math.min(Math.max(Number(padding) || 1, 1), 12);
  const branchCode = branches.data?.[0]?.code ?? "BR1";
  const preview = [(prefix ?? "").toUpperCase() || "?", ...(includeBranch ? [branchCode] : []), ...(scope ? [scope] : []),
    String(nextSeq).padStart(pad, "0")].join(separator ?? "");
  return (
    <div className="col-span-full rounded border border-line bg-surface-muted px-3 py-2">
      <div className="kv-label">Next number preview</div>
      <code className="mt-0.5 block font-mono text-sm text-brand-700">{preview}</code>
      {counterChanges && (
        <p className="mt-1 text-xs text-amber-700">Changing the reset rule or branch setting starts a separate counter, beginning at 1.</p>
      )}
    </div>
  );
}
