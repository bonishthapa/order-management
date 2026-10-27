import { Fragment, type ReactNode } from "react";
import { useAuth } from "@/auth/AuthContext";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { cn } from "@/utils/cn";
import { renderCell } from "./format";
import { isNumeric, type TableColumn } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BaseTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[] | undefined;
  rowKey?: (row: T, index: number) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: string; description?: ReactNode; action?: ReactNode } | ReactNode;
  /** Totals row: either column ``footer`` values or a custom row. */
  footer?: boolean | ReactNode;
  rowClassName?: (row: T, index: number) => string | undefined;
  /** Extra full-width row rendered after a row (e.g. expanded detail). */
  renderAfterRow?: (row: T, index: number) => ReactNode;
  density?: "compact" | "normal";
  minWidth?: number;
  stickyHeader?: boolean;
  className?: string;
  caption?: string;
}

/**
 * The application's only HTML table. Use it for every in-page table (document lines, allocations,
 * small lists, statements). Server-paginated lists use DataGrid with the same TableColumn type.
 */
export function BaseTable<T>({
  columns, rows, rowKey, onRowClick, loading, error, onRetry, empty, footer, rowClassName, renderAfterRow, density = "normal",
  minWidth, stickyHeader, className, caption,
}: BaseTableProps<T>) {
  const { dateMode } = useAuth();
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !rows) return <LoadingBlock />;
  const cell = density === "compact" ? "px-3 py-1.5" : "px-3 py-2";
  const hasFooter = footer === true ? columns.some((c) => c.footer !== undefined) : !!footer;

  if (rows && rows.length === 0) {
    if (empty && typeof empty === "object" && "title" in (empty as object)) {
      const e = empty as { title: string; description?: ReactNode; action?: ReactNode };
      return <EmptyState title={e.title} description={e.description} action={e.action} className="py-8" />;
    }
    return <>{(empty as ReactNode) ?? <p className="p-4 text-xs text-slate-500">Nothing to show.</p>}</>;
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-[13px]" style={minWidth ? { minWidth } : undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={cn("border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500", stickyHeader && "sticky top-0 z-10")}>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{ width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth }}
                className={cn(cell, "whitespace-nowrap", isNumeric(c) && "text-right", c.align === "center" && "text-center", c.headerClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row, i) => (
            <Fragment key={rowKey ? rowKey(row, i) : ((row as any)?.id ?? i)}>
              <tr onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(row); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cn("border-b border-line align-top last:border-0", onRowClick && "cursor-pointer hover:bg-surface-muted focus:bg-surface-muted",
                  rowClassName?.(row, i))}>
                {columns.map((c) => (
                  <td key={c.key} className={cn(cell, isNumeric(c) && "num whitespace-nowrap", c.type === "date" && "whitespace-nowrap",
                    c.align === "center" && "text-center", c.className)}>
                    {renderCell(c, row, dateMode)}
                  </td>
                ))}
              </tr>
              {renderAfterRow?.(row, i)}
            </Fragment>
          ))}
        </tbody>
        {hasFooter && (
          <tfoot className="border-t-2 border-slate-300 bg-surface-muted font-semibold">
            {footer === true ? (
              <tr>{columns.map((c) => <td key={c.key} className={cn(cell, isNumeric(c) && "num whitespace-nowrap")}>{c.footer}</td>)}</tr>
            ) : footer}
          </tfoot>
        )}
      </table>
    </div>
  );
}
