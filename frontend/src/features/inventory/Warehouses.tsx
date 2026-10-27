import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { CellInput, FormDialog, FormField, FormGrid, useFieldArray, useFormContext, useWatch } from "@/components/form";
import { BaseTable, col } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount } from "@/utils/format";
import { RemoveLineButton } from "./Movements";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Location { id?: number; code: string; name: string; is_active: boolean }
interface Warehouse {
  id: number; code: string; name: string; branch: number | null; branch_name: string | null; address: string; is_transit: boolean;
  is_active: boolean; locations: Location[]; stock_value: string | null; product_count: number | null;
}
interface WarehouseValues { code: string; name: string; branch: number | null; address: string; is_active: boolean; locations: Location[] }

export function WarehousesPage() {
  const { can } = useAuth();
  const query = useOptions<Warehouse>("warehouses", { include_transit: "true" });
  const [editing, setEditing] = useState<Warehouse | "new" | null>(null);
  const manage = can("settings.manage");
  const rows = query.data ?? [];
  const total = rows.reduce((sum, w) => sum + Number(w.stock_value ?? 0), 0);

  return (
    <>
      <PageHeader title="Warehouses" subtitle="Stock locations. Each warehouse can belong to a branch and hold storage locations (bins, racks)."
        actions={manage && <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>New warehouse</Button>} />
      <Panel>
        <BaseTable<Warehouse> rows={query.data} loading={query.isLoading} error={query.error} onRetry={() => query.refetch()} minWidth={820} footer
          empty={{ title: "No warehouses", description: "Create a warehouse to start holding stock." }}
          columns={[
            col.text("code", "Code", { className: "font-medium", footer: "Total" }),
            col.custom("name", "Name", (w) => (
              <>
                {w.is_transit ? w.name : <Link className="link" to={`/inventory/stock?warehouse=${w.id}`}>{w.name}</Link>}
                {w.address && <div className="text-2xs text-slate-500">{w.address}</div>}
              </>
            )),
            col.custom("branch_name", "Branch", (w) => w.branch_name ?? "–"),
            col.custom("locations", "Locations", (w) => (
              <span className="text-xs text-slate-600">{w.locations.filter((l) => l.is_active).map((l) => l.code).join(", ") || "–"}</span>
            )),
            col.custom("product_count", "Products in stock", (w) => (w.product_count ?? 0).toLocaleString(), { align: "right" }),
            col.money("stock_value", "Stock value", { value: (w) => w.stock_value ?? 0, footer: formatAmount(total) }),
            col.custom("status", "Status", (w) => (
              <div className="flex gap-1">
                {w.is_transit && <Badge tone="blue">System · transit</Badge>}
                <Badge tone={w.is_active ? "green" : "neutral"}>{w.is_active ? "Active" : "Inactive"}</Badge>
              </div>
            )),
            col.custom("edit", "", (w) => (manage && !w.is_transit ? (
              <Button size="sm" variant="ghost" aria-label={`Edit ${w.code}`} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(w)} />
            ) : null), { width: 48 }),
          ]} />
      </Panel>
      <p className="mt-2 text-xs text-slate-500">The transit warehouse is maintained by the system and holds goods dispatched on transfers until they are received.</p>
      <WarehouseDialog key={editing === "new" ? "new" : editing?.id ?? "none"} warehouse={editing === "new" ? null : editing}
        open={editing !== null} onClose={() => setEditing(null)} />
    </>
  );
}

function WarehouseDialog({ warehouse, open, onClose }: { warehouse: Warehouse | null; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  return (
    <FormDialog<WarehouseValues> open={open} onOpenChange={(o) => !o && onClose()} title={warehouse ? `Edit ${warehouse.code}` : "New warehouse"} size="lg"
      defaultValues={{
        code: warehouse?.code ?? "", name: warehouse?.name ?? "", branch: warehouse?.branch ?? null, address: warehouse?.address ?? "",
        is_active: warehouse?.is_active ?? true, locations: warehouse?.locations.map((l) => ({ ...l })) ?? [],
      }}
      onSubmit={async (values, form) => {
        const codes = values.locations.map((l) => l.code.trim().toUpperCase());
        let invalid = false;
        values.locations.forEach((l, i) => {
          if (!l.code.trim()) { form.setError(`locations.${i}.code`, { type: "manual", message: "Required." }); invalid = true; }
          else if (codes.indexOf(codes[i]) !== i) { form.setError(`locations.${i}.code`, { type: "manual", message: "Duplicate code." }); invalid = true; }
        });
        if (invalid) throw new Error("Correct the storage locations.");
        const body = {
          code: values.code.trim(), name: values.name.trim(), branch: values.branch, address: values.address, is_active: values.is_active,
          locations: values.locations.map((l) => ({ ...(l.id ? { id: l.id } : {}), code: l.code.trim(), name: l.name.trim(), is_active: l.is_active })),
        };
        if (warehouse) await api.patch(`/warehouses/${warehouse.id}/`, body);
        else await api.post("/warehouses/", body);
        ["warehouses", "dashboard"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(warehouse ? "Warehouse updated" : "Warehouse created");
      }}>
      <FormGrid columns={2}>
        <FormField name="code" label="Code" required uppercase maxLength={12} hint="Used in document numbers and lists, e.g. KTM." />
        <FormField name="name" label="Name" required maxLength={120} />
        <FormField name="branch" label="Branch" type="entity" resource="branches" placeholder="No branch" initialLabel={warehouse?.branch_name ?? undefined} />
        <FormField name="is_active" label="Status" type="checkbox" hint="Active" />
        <FormField name="address" label="Address" type="textarea" rows={2} span="full" />
      </FormGrid>
      <LocationsEditor />
    </FormDialog>
  );
}

function LocationsEditor() {
  const { control } = useFormContext<WarehouseValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "locations" });
  const locations = (useWatch({ control, name: "locations" }) ?? []) as Location[];
  const rows = fields.map((f, index) => ({ key: f.id, index }));
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-600">Storage locations</h3>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => append({ code: "", name: "", is_active: true })}>Add location</Button>
      </div>
      {rows.length === 0 ? <p className="text-xs text-slate-500">No storage locations. Stock is held at warehouse level.</p> : (
        <BaseTable rows={rows} rowKey={(r) => r.key} density="compact" columns={[
          col.custom("code", "Code", (r) => <CellInput name={`locations.${r.index}.code`} label="Location code" />),
          col.custom("name", "Name", (r) => <CellInput name={`locations.${r.index}.name`} label="Location name" />),
          col.custom("is_active", "Active", (r) => <LocationActive index={r.index} />, { width: 70, align: "center" }),
          col.custom("remove", "", (r) => (locations[r.index]?.id ? null : <RemoveLineButton label="Remove location" onClick={() => remove(r.index)} />), { width: 40 }),
        ]} />
      )}
      {locations.some((l) => l.id) && <p className="mt-1 text-xs text-slate-500">Saved locations cannot be deleted; untick Active to retire one.</p>}
    </div>
  );
}

function LocationActive({ index }: { index: number }) {
  const { setValue } = useFormContext();
  const active = useWatch({ name: `locations.${index}.is_active` }) as boolean;
  return (
    <input type="checkbox" className="mt-2 accent-brand-600" aria-label="Active" checked={!!active}
      onChange={(e) => setValue(`locations.${index}.is_active`, e.target.checked, { shouldDirty: true })} />
  );
}
