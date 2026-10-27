import type { DateDisplayMode } from "@/api/types";
import { StatusBadge } from "@/components/ui/Badge";
import { formatAmount, formatDate, formatDateTime, formatPercent, formatQty } from "@/utils/format";
import type { TableColumn } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rawValue(column: TableColumn, row: any) {
  if (column.value) return column.value(row);
  return column.key.split(".").reduce((v: any, part) => (v == null ? v : v[part]), row);
}

/** Text form of a cell (used for formatting and for AG Grid value formatters). */
export function formatCell(column: TableColumn, row: any, dateMode: DateDisplayMode): string {
  const v = rawValue(column, row);
  if (v === null || v === undefined || v === "") return "";
  switch (column.type) {
    case "money": return formatAmount(v as string);
    case "qty": return formatQty(v as string);
    case "percent": return formatPercent(v as string);
    case "date": return formatDate(String(v), dateMode, row?.[`${column.key}_bs`]);
    case "datetime": return formatDateTime(String(v));
    default: return String(v);
  }
}

/** Rendered content of a cell: custom renderer, status badge, document number or formatted value. */
export function renderCell(column: TableColumn, row: any, dateMode: DateDisplayMode) {
  if (column.render) return column.render(row);
  if (column.type === "status") {
    return <StatusBadge status={rawValue(column, row) as string} label={column.labelKey ? row?.[column.labelKey] : undefined} />;
  }
  if (column.type === "doc") {
    const v = rawValue(column, row);
    return v ? <span className="font-medium text-brand-700">{String(v)}</span> : <span className="text-slate-400">Draft #{row?.id}</span>;
  }
  if (column.type === "date" && dateMode === "AD_BS" && rawValue(column, row)) {
    const ad = String(rawValue(column, row)).slice(0, 10);
    return <>{formatDate(ad, "BS", row?.[`${column.key}_bs`])} <span className="text-slate-400">· {ad}</span></>;
  }
  return formatCell(column, row, dateMode);
}
