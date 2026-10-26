import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useOptions } from "@/api/hooks";
import type { FiscalYear } from "@/api/types";
import { useStoredState } from "@/hooks/useStoredState";

interface FiscalYearState {
  years: FiscalYear[];
  selected: FiscalYear | null;
  current: FiscalYear | null;
  setSelectedId: (id: number) => void;
  loading: boolean;
}

const Ctx = createContext<FiscalYearState | null>(null);

/** The fiscal year chosen in the top bar. Reports, the dashboard and dated lists default to it. */
export function FiscalYearProvider({ children, organizationId }: { children: ReactNode; organizationId: number }) {
  const query = useOptions<FiscalYear>("fiscal-years");
  const [selectedId, setSelectedId] = useStoredState<number | null>(`erp.fy.${organizationId}`, null);
  const years = useMemo(() => (query.data ?? []).filter((fy) => fy.status !== "DRAFT"), [query.data]);
  const current = years.find((fy) => fy.status === "ACTIVE") ?? years[0] ?? null;
  const selected = years.find((fy) => fy.id === selectedId) ?? current;

  useEffect(() => {
    if (selectedId && query.data && !years.some((fy) => fy.id === selectedId)) setSelectedId(null);
  }, [selectedId, years, query.data, setSelectedId]);

  return (
    <Ctx.Provider value={{ years, selected, current, setSelectedId, loading: query.isLoading }}>{children}</Ctx.Provider>
  );
}

export function useFiscalYear(): FiscalYearState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFiscalYear must be used inside FiscalYearProvider");
  return ctx;
}
