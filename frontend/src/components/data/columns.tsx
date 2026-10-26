import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { StatusBadge } from "@/components/ui/Badge";
import { formatAmount, formatDate, formatPercent, formatQty } from "@/utils/format";
import type { DateDisplayMode } from "@/api/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

export interface ColumnContext {
  dateMode: DateDisplayMode;
}

/** Column factories so every grid formats numbers, dates and statuses the same way. */
export const col = {
  text: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({ field, headerName, minWidth: 110, ...extra }),
  number: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, type: "rightAligned", cellClass: "num-cell", minWidth: 90, ...extra,
  }),
  money: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, type: "rightAligned", cellClass: "num-cell", minWidth: 120,
    valueFormatter: (p: ValueFormatterParams) => formatAmount(p.value), ...extra,
  }),
  qty: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, type: "rightAligned", cellClass: "num-cell", minWidth: 90,
    valueFormatter: (p: ValueFormatterParams) => formatQty(p.value), ...extra,
  }),
  percent: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, type: "rightAligned", cellClass: "num-cell", minWidth: 80,
    valueFormatter: (p: ValueFormatterParams) => formatPercent(p.value), ...extra,
  }),
  date: (field: string, headerName: string, ctx: ColumnContext, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, minWidth: ctx.dateMode === "AD_BS" ? 190 : 110, cellClass: "num-cell",
    valueFormatter: (p: ValueFormatterParams) => formatDate(p.value, ctx.dateMode, p.data?.[`${field}_bs`]), ...extra,
  }),
  status: (field: string, headerName = "Status", labelField?: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, minWidth: 120, maxWidth: 170,
    cellRenderer: (p: ICellRendererParams<Row>) => <StatusBadge status={p.value} label={labelField ? p.data?.[labelField] : undefined} />,
    ...extra,
  }),
  doc: (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({
    field, headerName, minWidth: 150, pinned: "left",
    cellRenderer: (p: ICellRendererParams<Row>) => <span className="font-medium text-brand-700">{p.value || <span className="text-slate-400">Draft #{p.data?.id}</span>}</span>,
    ...extra,
  }),
};
