import type { ReactNode } from "react";

/**
 * The single column definition for every table in the application.
 * Used by BaseTable (in-page tables) and DataGrid (server-paginated lists).
 */
export type ColumnType = "text" | "number" | "money" | "qty" | "percent" | "date" | "datetime" | "status" | "doc";

export interface TableColumn<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Field name in the row, also the column id. */
  key: string;
  header: ReactNode;
  /** Controls formatting and alignment when no custom ``render`` is given. */
  type?: ColumnType;
  align?: "left" | "right" | "center";
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Relative width in DataGrid (default 1; date/status columns are fixed). */
  flex?: number;
  /** Custom cell content. Receives the row. */
  render?: (row: T) => ReactNode;
  /** Value used for formatting/export when it differs from ``row[key]``. */
  value?: (row: T) => unknown;
  /** For status columns: field holding the human label. */
  labelKey?: string;
  /** Server ordering field when it differs from ``key`` (DataGrid only). */
  sortField?: string;
  sortable?: boolean;
  /** Pinned to the left in DataGrid (document numbers). */
  pinned?: boolean;
  /** Cell content of the totals row (BaseTable ``footer``). */
  footer?: ReactNode;
  className?: string;
  headerClassName?: string;
}

export const NUMERIC_TYPES: ColumnType[] = ["number", "money", "qty", "percent"];
export const isNumeric = (c: TableColumn) => c.align === "right" || NUMERIC_TYPES.includes(c.type ?? "text");
