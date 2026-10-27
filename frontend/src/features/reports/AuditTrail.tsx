import { useState } from "react";
import { BaseTable, col, ResourceList } from "@/components/table";
import type { AuditEvent } from "@/api/types";
import { Dialog } from "@/components/ui/Dialog";
import { PageHeader } from "@/components/ui/Page";
import { formatDateTime } from "@/utils/format";

const ENTITY_TYPES = ["salesorder", "delivery", "salesinvoice", "customerreceipt", "salesreturn", "purchaseorder", "goodsreceipt", "supplierbill",
  "paymentvoucher", "purchasereturn", "expense", "journalentry", "stock_movement", "stock_transfer", "stock_count", "customer", "supplier", "product",
  "fiscal_year", "accounting_period", "organization", "membership", "user", "report", "account"];

export function AuditTrail() {
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  return (
    <>
      <PageHeader title="Audit trail" subtitle="Append-only record of every change, approval, posting, reversal, export and print. Nobody can edit it." />
      <ResourceList resource="audit-logs" gridId="audit" searchPlaceholder="Record, user, action, request ID…" exportUrl="/audit-logs/export/" exportName="audit-trail"
        filters={[{ type: "select", name: "entity_type", label: "Record type", options: ENTITY_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") })) }]}
        columns={[
          col.datetime("created_at", "Time", { minWidth: 160 }),
          col.text("date_bs", "BS date", { maxWidth: 110 }),
          col.text("user_name", "User"),
          col.text("action", "Action", { flex: 1.5 }),
          col.text("entity_type", "Record type"),
          col.text("entity_label", "Record", { flex: 2 }),
          col.text("reason", "Reason", { flex: 2 }),
        ]}
        onRowClick={(row) => setSelected(row)}
      />
      <AuditRowHint />
      {selected && <AuditDetail event={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function AuditRowHint() {
  return <p className="mt-2 text-2xs text-slate-400">Open a document to see its own history and connected records in the “Activity” tab.</p>;
}

function AuditDetail({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const keys = Array.from(new Set([...Object.keys(event.old_values ?? {}), ...Object.keys(event.new_values ?? {})]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${event.action} · ${event.entity_label || event.entity_id}`} size="lg"
      description={`${formatDateTime(event.created_at)} (${event.date_bs} BS) by ${event.user_name ?? "system"} · request ${event.request_id || "–"}`}>
      {event.reason && <p className="mb-3 text-[13px]"><span className="font-medium">Reason:</span> {event.reason}</p>}
      <BaseTable rows={keys.map((k) => ({ id: k, field: k }))} density="compact"
        empty={<p className="text-xs text-slate-500">No field values were recorded for this event.</p>} columns={[
          col.custom("field", "Field", (r: any) => <span className="text-slate-500">{r.field.replace(/_/g, " ")}</span>),
          col.custom("before", "Before", (r: any) => <span className="break-all">{format(event.old_values?.[r.field])}</span>),
          col.custom("after", "After", (r: any) => <span className="break-all">{format(event.new_values?.[r.field])}</span>),
        ]} />
    </Dialog>
  );
}

const format = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
