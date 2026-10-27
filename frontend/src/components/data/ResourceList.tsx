import type { ColDef } from "ag-grid-community";
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useList } from "@/api/hooks";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { useAuth } from "@/auth/AuthContext";
import { useUrlState } from "@/hooks/useUrlState";
import { DataTable } from "./DataTable";
import { ExportMenu } from "./ExportMenu";
import { FilterBar, FilterControls, PeriodFilter, SearchBox, type FilterDef } from "./Filters";
import type { ColumnContext } from "./columns";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ResourceListProps {
  resource: string;
  columns: (ctx: ColumnContext) => ColDef[];
  filters?: FilterDef[];
  dated?: boolean; // offers fiscal-year and AD/BS date range filters
  searchPlaceholder?: string;
  detailPath?: (row: any) => string;
  onRowClick?: (row: any) => void;
  defaultOrdering?: string;
  exportUrl?: string;
  exportName?: string;
  extraParams?: Record<string, string>;
  toolbar?: ReactNode;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  gridId?: string;
}

/** Server-side paginated, sorted and filtered list. Filter state lives in the URL. */
export function ResourceList({ resource, columns, filters = [], dated, searchPlaceholder, detailPath, onRowClick, defaultOrdering = "", exportUrl,
  exportName, extraParams = {}, toolbar, empty, gridId }: ResourceListProps) {
  const navigate = useNavigate();
  const { dateMode } = useAuth();
  const { selected } = useFiscalYear();
  const [values, set] = useUrlState();
  const fiscalYear = dated ? (values.fiscal_year ?? (selected ? String(selected.id) : "")) : undefined;
  const params = {
    ...extraParams,
    ...Object.fromEntries(Object.entries(values).filter(([k]) => !["page", "page_size", "ordering", "fiscal_year"].includes(k))),
    fiscal_year: fiscalYear === "all" ? undefined : fiscalYear,
    page: values.page ?? 1,
    page_size: values.page_size ?? 25,
    ordering: values.ordering ?? defaultOrdering,
  };
  const query = useList<any>(resource, params);
  const colDefs = useMemo(() => columns({ dateMode }), [columns, dateMode]);
  const filterKeys = ["search", "date_from", "date_to", ...filters.map((f) => f.name)];
  const active = filterKeys.some((k) => values[k]) || values.fiscal_year !== undefined;
  const { page: _p, page_size: _s, ...exportParams } = params;

  return (
    <div className="panel overflow-hidden">
      <FilterBar active={active} onReset={() => set(Object.fromEntries([...filterKeys, "fiscal_year"].map((k) => [k, null])))}>
        <SearchBox value={values.search ?? ""} onChange={(v) => set({ search: v })} placeholder={searchPlaceholder} />
        <FilterControls filters={filters} values={values} set={set} />
        {dated && <PeriodFilter values={{ ...values, fiscal_year: fiscalYear ?? "" }} set={set} />}
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          {exportUrl && <ExportMenu url={exportUrl} params={exportParams} filename={exportName ?? resource} />}
        </div>
      </FilterBar>
      <DataTable
        id={gridId ?? resource}
        columns={colDefs}
        rows={query.data?.results}
        total={query.data?.count}
        page={Number(params.page)}
        pageSize={Number(params.page_size)}
        onPageChange={(page) => set({ page }, false)}
        onPageSizeChange={(size) => set({ page_size: size })}
        ordering={params.ordering}
        onOrderingChange={(ordering) => set({ ordering })}
        loading={query.isLoading}
        fetching={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        onRowClick={onRowClick ?? (detailPath ? (row) => navigate(detailPath(row)) : undefined)}
        empty={empty}
      />
    </div>
  );
}
