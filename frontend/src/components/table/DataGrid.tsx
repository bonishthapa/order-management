import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridReadyEvent, ICellRendererParams, RowClickedEvent, SortChangedEvent, GridApi, SelectionChangedEvent } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import { ChevronLeft, ChevronRight, Columns3 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, Spinner } from "@/components/ui/Feedback";
import { Menu, MenuContent, MenuLabel, MenuTrigger } from "@/components/ui/Menu";
import { useStoredState } from "@/hooks/useStoredState";
import { Select } from "@/components/ui/Input";
import { cn } from "@/utils/cn";
import { useAuth } from "@/auth/AuthContext";
import type { DateDisplayMode } from "@/api/types";
import { renderCell } from "./format";
import { isNumeric, type TableColumn } from "./types";
import * as DM from "@radix-ui/react-dropdown-menu";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DataGridProps<T> {
  id: string; // stable key for remembered column visibility
  columns: TableColumn<T>[];
  rows: T[] | undefined;
  total?: number;
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  ordering?: string;
  onOrderingChange?: (ordering: string) => void;
  loading?: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  height?: number | "auto";
  selectable?: boolean;
  onSelectionChange?: (rows: T[]) => void;
  pinnedBottomRow?: Record<string, unknown>;
  getRowClass?: (row: T) => string | undefined;
}

export function DataGrid<T extends { id?: number | string }>({
  id, columns, rows, total, page = 1, pageSize = 25, onPageChange, onPageSizeChange, ordering, onOrderingChange, loading, fetching,
  error, onRetry, onRowClick, empty, height = "auto", selectable, onSelectionChange, pinnedBottomRow, getRowClass,
}: DataGridProps<T>) {
  const gridApi = useRef<GridApi | null>(null);
  const [hidden, setHidden] = useStoredState<string[]>(`grid.${id}.hidden`, []);

  const { dateMode } = useAuth();
  const colDefs = useMemo<ColDef[]>(() => columns.map((c) => {
    const sortField = c.sortField ?? c.key;
    let sort: "asc" | "desc" | null = null;
    if (ordering === sortField) sort = "asc";
    if (ordering === `-${sortField}`) sort = "desc";
    return { ...toColDef(c, dateMode), hide: hidden.includes(c.key), sort };
  }), [columns, hidden, ordering, dateMode]);

  const defaultColDef = useMemo<ColDef>(() => ({ resizable: true, suppressMovable: false, flex: 1, comparator: () => 0 }), []);

  const onSortChanged = useCallback((e: SortChangedEvent) => {
    const sorted = e.api.getColumnState().find((s) => s.sort);
    if (!onOrderingChange) return;
    if (!sorted) return onOrderingChange("");
    const def = columns.find((c) => c.key === sorted.colId);
    const field = def?.sortField ?? def?.key ?? sorted.colId;
    onOrderingChange(sorted.sort === "desc" ? `-${field}` : field);
  }, [columns, onOrderingChange]);

  useEffect(() => {
    if (!gridApi.current) return;
    if (loading) gridApi.current.setGridOption("loading", true);
    else gridApi.current.setGridOption("loading", false);
  }, [loading]);

  const pages = total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = total !== undefined ? Math.min(page * pageSize, total) : rows?.length ?? 0;
  const autoHeight = height === "auto";

  if (error) return <ErrorState error={error} onRetry={onRetry} />;

  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn("ag-theme-quartz erp-grid relative w-full", !autoHeight && "")} style={autoHeight ? undefined : { height }}>
        {rows && rows.length === 0 && !loading ? (
          <EmptyState title={empty?.title ?? "No records found"} description={empty?.description ?? "Try changing the filters."}
            action={empty?.action} />
        ) : (
          <AgGridReact
            rowData={rows ?? []}
            columnDefs={colDefs}
            defaultColDef={defaultColDef}
            domLayout={autoHeight ? "autoHeight" : "normal"}
            suppressCellFocus={false}
            animateRows={false}
            rowSelection={selectable ? "multiple" : undefined}
            suppressRowClickSelection={selectable}
            loading={loading}
            onGridReady={(e: GridReadyEvent) => { gridApi.current = e.api; }}
            onSortChanged={onSortChanged}
            onRowClicked={(e: RowClickedEvent) => e.data && !e.node.rowPinned && onRowClick?.(e.data)}
            onCellKeyDown={(e: any) => { if (e.event?.key === "Enter" && e.data) onRowClick?.(e.data); }}
            onSelectionChanged={(e: SelectionChangedEvent) => onSelectionChange?.(e.api.getSelectedRows())}
            getRowId={(p) => String(p.data.id ?? JSON.stringify(p.data))}
            rowClass={onRowClick ? "clickable" : undefined}
            getRowClass={(p) => (p.data && getRowClass ? getRowClass(p.data) : undefined)}
            pinnedBottomRowData={pinnedBottomRow ? [pinnedBottomRow] : undefined}
            overlayNoRowsTemplate="<span></span>"
            enableCellTextSelection
            ensureDomOrder
          />
        )}
      </div>
      {(onPageChange || total !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-slate-500">
          <div className="flex items-center gap-3">
            <span>{total !== undefined ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : ""}</span>
            {fetching && !loading && <Spinner className="h-3 w-3" />}
          </div>
          <div className="flex items-center gap-2">
            <ColumnPicker columns={columns} hidden={hidden} setHidden={setHidden} />
            {onPageSizeChange && (
              <Select aria-label="Rows per page" className="h-7 w-[84px] text-xs" value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </Select>
            )}
            {onPageChange && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="tabular-nums">Page {page} of {pages}</span>
                <Button size="sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnPicker({ columns, hidden, setHidden }: { columns: TableColumn[]; hidden: string[]; setHidden: (v: string[]) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" icon={<Columns3 className="h-3.5 w-3.5" />}>Columns</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Show columns</MenuLabel>
        {columns.filter((c) => c.header).map((c) => {
          const key = c.key;
          return (
            <DM.CheckboxItem key={key} checked={!hidden.includes(key)} onSelect={(e) => e.preventDefault()}
              onCheckedChange={(checked) => setHidden(checked ? hidden.filter((h) => h !== key) : [...hidden, key])}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] outline-none data-[highlighted]:bg-surface-sunken">
              <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", !hidden.includes(key) ? "border-brand-600 bg-brand-600" : "border-slate-300")}>
                {!hidden.includes(key) && <span className="h-1.5 w-1.5 rounded-sm bg-white" />}
              </span>
              {c.header}
            </DM.CheckboxItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

/** Converts the shared TableColumn into an AG Grid column (used only here). */
function toColDef(c: TableColumn, dateMode: DateDisplayMode): ColDef {
  const numeric = isNumeric(c);
  const fixedWidth = c.type === "date" ? (dateMode === "AD_BS" ? 200 : 116) : undefined;
  return {
    colId: c.key,
    field: c.key,
    headerName: typeof c.header === "string" ? c.header : c.key,
    type: numeric ? "rightAligned" : undefined,
    cellClass: cn(numeric && "num-cell", (c.type === "status" || c.render) && "flex items-center", c.className),
    width: c.width ?? fixedWidth,
    minWidth: c.minWidth ?? fixedWidth,
    maxWidth: c.maxWidth,
    flex: fixedWidth || c.width ? 0 : c.flex ?? 1,
    pinned: c.pinned ? "left" : undefined,
    sortable: c.sortable ?? false,
    cellRenderer: (p: ICellRendererParams) => (p.data ? renderCell(c, p.data, dateMode) : p.value),
  };
}
