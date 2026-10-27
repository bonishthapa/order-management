import { useState } from "react";
import { Link } from "react-router-dom";
import { useOptions } from "@/api/hooks";
import type { FiscalYear } from "@/api/types";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { PeriodTable } from "./FiscalYears";

export function PeriodsPage() {
  const { selected } = useFiscalYear();
  // Include draft years here (the top-bar context hides them) so their generated periods can be reviewed.
  const years = useOptions<FiscalYear>("fiscal-years");
  const [chosen, setChosen] = useState<number | null>(null);

  if (years.isLoading) return <LoadingBlock />;
  if (years.error) return <ErrorState error={years.error} onRetry={() => years.refetch()} />;
  const list = years.data ?? [];
  const fyId = chosen ?? selected?.id ?? list[0]?.id ?? null;
  const fy = list.find((y) => y.id === fyId) ?? null;

  return (
    <>
      <PageHeader title="Accounting periods"
        subtitle="Lock a period after its month-end review so nothing dated inside it can be posted or reversed. Unlocking is recorded with a reason." />
      {!list.length ? (
        <Panel><EmptyState title="No fiscal years" description={<>Create a fiscal year first. <Link className="link" to="/admin/fiscal-years/new">New fiscal year</Link></>} /></Panel>
      ) : (
        <Panel title={fy ? (
          <span className="flex items-center gap-2">
            <Link className="link" to={`/admin/fiscal-years/${fy.id}`}>Fiscal year {fy.name}</Link>
            <StatusBadge status={fy.status} label={fy.status_label} />
          </span>
        ) : "Periods"}
          actions={
            <Select aria-label="Fiscal year" className="w-56" value={fyId ?? ""} onChange={(e) => setChosen(Number(e.target.value))}>
              {list.map((y) => <option key={y.id} value={y.id}>{y.name} · {y.status_label}</option>)}
            </Select>
          }>
          {fy ? <PeriodTable key={fy.id} fiscalYear={fy} /> : <EmptyState title="Choose a fiscal year" />}
        </Panel>
      )}
    </>
  );
}
