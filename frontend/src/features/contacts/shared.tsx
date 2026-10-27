import { FileText, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, openPdf } from "@/api/client";
import { useGet, useList, useOptions } from "@/api/hooks";
import type { AuditEvent } from "@/api/types";
import { DatePicker } from "@/calendar/DatePicker";
import { DateText } from "@/calendar/DateText";
import { todayIn } from "@/calendar/bs";
import { useAuth } from "@/auth/AuthContext";
import { FormDialog, FormField, FormGrid } from "@/components/form";
import { BaseTable, DataGrid, ExportMenu, FilterBar, PeriodFilter, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Select } from "@/components/ui/Input";
import { Panel } from "@/components/ui/Page";
import { formatAmount, formatDateTime, titleCase, toNumber } from "@/utils/format";
import { cn } from "@/utils/cn";
import { LedgerTable, RangeText, usePeriodState, type LedgerData } from "@/features/finance/Ledgers";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PartyKind = "customer" | "supplier";
export const PARTY = {
  customer: { resource: "customers", categories: "customer-categories", label: "Customer", perm: "customers.manage", base: "/contacts/customers" },
  supplier: { resource: "suppliers", categories: "supplier-categories", label: "Supplier", perm: "suppliers.manage", base: "/contacts/suppliers" },
} as const;

interface Category { id: number; name: string; is_active: boolean }

export const ACTIVE_OPTIONS = [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }];

export function useCategoryOptions(kind: PartyKind) {
  const query = useOptions<Category>(PARTY[kind].categories);
  return (query.data ?? []).map((c) => ({ value: String(c.id), label: c.name }));
}

/**
 * Category field for a BaseForm (field "category") with an inline "New category" dialog for users who can manage the
 * party master. The dialog form is a separate BaseForm; its submit event is stopped so it never submits the page form.
 */
export function CategoryField({ kind, canCreate }: { kind: PartyKind; canCreate: boolean }) {
  const query = useOptions<Category>(PARTY[kind].categories);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <FormField name="category" label="Category" type="custom" render={({ value, onChange, invalid, disabled }) => {
      const categories = (query.data ?? []).filter((c) => c.is_active || c.id === value);
      return (
        <div className="flex gap-1.5">
          <Select value={value ?? ""} disabled={disabled} invalid={invalid} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {canCreate && <Button aria-label="New category" title="New category" icon={<Plus className="h-3.5 w-3.5" />} disabled={disabled}
            onClick={() => setOpen(true)} />}
          <div className="contents" onSubmit={(e) => e.stopPropagation()}>
            <FormDialog<{ name: string }> open={open} onOpenChange={setOpen} title="New category" size="sm" submitLabel="Create category"
              defaultValues={{ name: "" }}
              onSubmit={async (v) => {
                const { data } = await api.post<Category>(`/${PARTY[kind].categories}/`, { name: v.name.trim() });
                await queryClient.invalidateQueries({ queryKey: [PARTY[kind].categories] });
                onChange(data.id);
                toast.success(`Category “${data.name}” created`);
              }}>
              <FormField name="name" label="Name" required autoFocus />
            </FormDialog>
          </div>
        </div>
      );
    }} />
  );
}

export function SummaryCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "default" }) {
  return (
    <div className="panel px-4 py-3">
      <div className="kv-label">{label}</div>
      <div className={cn("mt-1 text-base font-semibold tabular-nums text-slate-900", tone === "danger" && "text-red-700")}>{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-slate-500">{hint}</div>}
    </div>
  );
}

/** Opening balance status and, if not yet posted, a one-time posting dialog. */
export function OpeningBalancePanel({ kind, party }: { kind: PartyKind; party: any }) {
  const { can, session } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const cfg = PARTY[kind];
  const positive = kind === "customer" ? "the customer owes you" : "you owe the supplier";
  const negative = kind === "customer" ? "an advance received from the customer" : "an advance paid to the supplier";

  return (
    <Panel title="Opening balance" actions={!party.opening_balance_posted && can(cfg.perm) && (
      <Button size="sm" onClick={() => setOpen(true)}>Post opening balance</Button>
    )}>
      {party.opening_balance_posted ? (
        <div className="space-y-1 p-4 text-[13px]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-slate-600">Posted on <DateText value={party.opening_balance_date} bs={party.opening_balance_date_bs} /></span>
            <strong className="tabular-nums">{formatAmount(party.opening_balance)}</strong>
          </div>
          <p className="text-xs text-slate-500">Opening balances are posted once. Correct them with a manual journal.</p>
        </div>
      ) : (
        <p className="p-4 text-xs text-slate-500">
          No opening balance posted. Use this when taking over a balance from a previous system; it is posted once against opening balance equity.
        </p>
      )}
      <FormDialog<{ amount: string; date: string }> open={open} onOpenChange={setOpen} title={`Opening balance – ${party.name}`}
        description="Posted once to the ledger. Later corrections are made with a manual journal." submitLabel="Post opening balance"
        defaultValues={{ amount: "", date: todayIn(session?.organization?.timezone) }}
        onSubmit={async (v) => {
          await api.post(`/${cfg.resource}/${party.id}/opening-balance/`, v);
          [cfg.resource, "journals", "accounts", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          toast.success("Opening balance posted");
        }}>
        <FormGrid>
          <FormField name="amount" label="Amount" type="money" required placeholder="0.00" hint={`Positive: ${positive}. Negative: ${negative}.`}
            rules={{ validate: (v: string) => (toNumber(v) !== 0 && !Number.isNaN(Number(v))) || "Enter a non-zero amount." }} />
          <FormField name="date" label="As of date" type="date" required />
        </FormGrid>
        <Alert tone="info" className="mt-3">This cannot be edited after posting. The entry is recorded in the audit trail.</Alert>
      </FormDialog>
    </Panel>
  );
}

/** Party ledger with period filter, export and statement PDF. */
export function PartyLedger({ kind, party }: { kind: PartyKind; party: any }) {
  const cfg = PARTY[kind];
  const { values, set, params } = usePeriodState();
  const query = useGet<LedgerData>([cfg.resource, "ledger", party.id], `/${cfg.resource}/${party.id}/ledger/`, params);
  const [printing, setPrinting] = useState(false);
  const statement = async () => {
    setPrinting(true);
    try {
      await openPdf(`/${cfg.resource}/${party.id}/statement/`, params);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPrinting(false);
    }
  };
  return (
    <div className="panel overflow-hidden">
      <FilterBar>
        <PeriodFilter values={values} set={set} />
        <span className="self-center text-xs text-slate-500">{query.data && <RangeText range={query.data.range} />}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button icon={<FileText className="h-3.5 w-3.5" />} loading={printing} onClick={statement}>Statement PDF</Button>
          <ExportMenu url={`/${cfg.resource}/${party.id}/ledger/`} params={params} filename={`${party.code}-ledger`} />
        </div>
      </FilterBar>
      {query.isLoading ? <LoadingBlock /> : query.error || !query.data ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : (
        <LedgerTable data={query.data} gridId={`${kind}-ledger`}
          balanceHint={kind === "customer" ? "Positive balance: the customer owes you. Negative: advance held for the customer."
            : "Positive balance: you owe the supplier. Negative: advance paid to the supplier."} />
      )}
    </div>
  );
}

interface AgingData {
  as_of: string;
  buckets: { key: string; label: string }[];
  totals: Record<string, number | string>;
  documents: { id: number; number: string; date: string; due_date: string; days_overdue: number; bucket: string; total: number | string; outstanding: number | string }[];
}

export function PartyAging({ kind, party }: { kind: PartyKind; party: any }) {
  const cfg = PARTY[kind];
  const { session } = useAuth();
  const [asOf, setAsOf] = useState(todayIn(session?.organization?.timezone));
  const query = useGet<AgingData>([cfg.resource, "aging", party.id], `/${cfg.resource}/${party.id}/aging/`, { as_of: asOf });
  const docBase = kind === "customer" ? "/sales/invoices" : "/purchases/bills";
  const data = query.data;
  return (
    <div className="space-y-4">
      <div className="panel overflow-hidden">
        <FilterBar>
          <div className="flex items-center gap-2 text-[13px] text-slate-600">
            <span>As of</span>
            <DatePicker compact value={asOf} onChange={(v) => setAsOf(v || todayIn(session?.organization?.timezone))} className="w-[160px]" />
          </div>
        </FilterBar>
        {query.isLoading ? <LoadingBlock /> : query.error || !data ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
            {data.buckets.map((b) => (
              <div key={b.key}>
                <div className="kv-label">{b.label}</div>
                <div className={cn("mt-0.5 tabular-nums text-[13px]", b.key !== "current" && toNumber(data.totals[b.key]) > 0 && "text-red-700")}>
                  {formatAmount(data.totals[b.key])}
                </div>
              </div>
            ))}
            <div>
              <div className="kv-label">Total outstanding</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{formatAmount(data.totals.total)}</div>
            </div>
          </div>
        )}
      </div>
      {data && (
        <Panel title={kind === "customer" ? "Open invoices" : "Open bills"}>
          {data.documents.length === 0 ? <EmptyState title="Nothing outstanding" description="All documents were settled as of this date." /> : (
            <BaseTable rows={data.documents} minWidth={640} density="compact" columns={[
              col.custom("number", "Document", (d) => <Link className="link font-medium" to={`${docBase}/${d.id}`}>{d.number}</Link>),
              col.date("date", "Date"),
              col.date("due_date", "Due"),
              col.number("days_overdue", "Days overdue", {
                render: (d) => <span className={cn(d.days_overdue > 0 && "text-red-700")}>{d.days_overdue || "–"}</span> }),
              col.custom("bucket", "Bucket", (d) => data.buckets.find((b) => b.key === d.bucket)?.label),
              col.money("total", "Total"),
              col.money("outstanding", "Outstanding", { className: "font-medium" }),
            ]} />
          )}
        </Panel>
      )}
    </div>
  );
}

/** Paginated list of one document type filtered to a party, for detail-page tabs. */
export function PartyDocuments({ resource, filter, partyId, columns, detailBase, newAction, emptyTitle, gridId }: {
  resource: string; filter: string; partyId: number; columns: TableColumn[]; detailBase: string;
  newAction?: ReactNode; emptyTitle: string; gridId: string;
}) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [ordering, setOrdering] = useState("");
  const query = useList<any>(resource, { [filter]: partyId, page, page_size: pageSize, ordering });
  return (
    <div className="panel overflow-hidden">
      {newAction && <div className="flex justify-end border-b border-line px-3 py-2">{newAction}</div>}
      <DataGrid id={gridId} columns={columns} rows={query.data?.results} total={query.data?.count} page={page} pageSize={pageSize}
        onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} ordering={ordering}
        onOrderingChange={(o) => { setOrdering(o); setPage(1); }} loading={query.isLoading} fetching={query.isFetching}
        error={query.error} onRetry={() => query.refetch()} onRowClick={(row: any) => navigate(`${detailBase}/${row.id}`)}
        empty={{ title: emptyTitle, description: "Nothing recorded for this party yet." }} />
    </div>
  );
}

function describeAction(action: string) {
  return titleCase((action.includes(".") ? action.split(".").slice(1).join(" ") : action).replace(/_/g, " "));
}

function show(value: unknown) {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Audit trail of a master record (requires audit.view). */
export function AuditActivity({ entityType, entityId }: { entityType: string; entityId: number }) {
  const [page, setPage] = useState(1);
  const query = useList<AuditEvent & { user_email?: string }>("audit-logs", { entity_type: entityType, entity_id: entityId, page, page_size: 50 });
  if (query.isLoading) return <Panel title="Activity"><LoadingBlock /></Panel>;
  if (query.error) return <Panel title="Activity"><ErrorState error={query.error} onRetry={() => query.refetch()} /></Panel>;
  const events = query.data?.results ?? [];
  const pages = query.data?.num_pages ?? 1;
  return (
    <Panel title="Activity" actions={pages > 1 && (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
        <span>Page {page} of {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</Button>
      </div>
    )}>
      {events.length === 0 ? <p className="p-4 text-xs text-slate-500">No recorded activity.</p> : (
        <ul className="divide-y divide-line">
          {events.map((e) => {
            const keys = Object.keys(e.new_values ?? {});
            return (
              <li key={e.id} className="px-4 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-slate-800">{describeAction(e.action)}</span>
                  <span className="text-xs text-slate-500">by {e.user_name ?? "system"}</span>
                  <span className="ml-auto text-2xs text-slate-400">{formatDateTime(e.created_at)} · {e.date_bs} BS</span>
                </div>
                {e.reason && <div className="mt-0.5 text-xs text-slate-600">Reason: {e.reason}</div>}
                {keys.length > 0 && (
                  <div className="mt-1 space-y-0.5 text-2xs text-slate-500">
                    {keys.slice(0, 12).map((k) => (
                      <div key={k}>
                        <span className="text-slate-600">{k.replace(/_/g, " ")}</span>:{" "}
                        {e.old_values && k in e.old_values && <><span className="line-through">{show(e.old_values[k])}</span>{" → "}</>}
                        {show(e.new_values?.[k])}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>;
}
