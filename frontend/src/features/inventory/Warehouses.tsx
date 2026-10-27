import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useApiMutation, useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { EntitySelect } from "@/components/forms/EntitySelect";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { formatAmount } from "@/utils/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Location { id?: number; code: string; name: string; is_active: boolean }
interface Warehouse {
  id: number; code: string; name: string; branch: number | null; branch_name: string | null; address: string; is_transit: boolean;
  is_active: boolean; locations: Location[]; stock_value: string | null; product_count: number | null;
}

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
        {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No warehouses" description="Create a warehouse to start holding stock." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Branch</th>
                  <th className="px-4 py-2">Locations</th>
                  <th className="px-4 py-2 text-right">Products in stock</th>
                  <th className="px-4 py-2 text-right">Stock value</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="w-12 px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-medium">{w.code}</td>
                    <td className="px-4 py-2">
                      {w.is_transit ? w.name : <Link className="link" to={`/inventory/stock?warehouse=${w.id}`}>{w.name}</Link>}
                      {w.address && <div className="text-2xs text-slate-500">{w.address}</div>}
                    </td>
                    <td className="px-4 py-2">{w.branch_name ?? "–"}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {w.locations.filter((l) => l.is_active).map((l) => l.code).join(", ") || "–"}
                    </td>
                    <td className="num px-4 py-2">{(w.product_count ?? 0).toLocaleString()}</td>
                    <td className="num px-4 py-2">{formatAmount(w.stock_value ?? 0)}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        {w.is_transit && <Badge tone="blue">System · transit</Badge>}
                        <Badge tone={w.is_active ? "green" : "neutral"}>{w.is_active ? "Active" : "Inactive"}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {manage && !w.is_transit && (
                        <Button size="sm" variant="ghost" aria-label={`Edit ${w.code}`} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(w)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-muted font-medium">
                  <td className="px-4 py-2" colSpan={5}>Total</td>
                  <td className="num px-4 py-2">{formatAmount(total)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
      <p className="mt-2 text-xs text-slate-500">The transit warehouse is maintained by the system and holds goods dispatched on transfers until they are received.</p>
      {editing && <WarehouseDialog warehouse={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function WarehouseDialog({ warehouse, onClose }: { warehouse: Warehouse | null; onClose: () => void }) {
  const [code, setCode] = useState(warehouse?.code ?? "");
  const [name, setName] = useState(warehouse?.name ?? "");
  const [branch, setBranch] = useState<number | null>(warehouse?.branch ?? null);
  const [address, setAddress] = useState(warehouse?.address ?? "");
  const [active, setActive] = useState(warehouse?.is_active ?? true);
  const [locations, setLocations] = useState<Location[]>(warehouse?.locations.map((l) => ({ ...l })) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useApiMutation(async (body: any) => (warehouse
    ? (await api.patch(`/warehouses/${warehouse.id}/`, body)).data
    : (await api.post("/warehouses/", body)).data), { invalidate: ["warehouses"], success: warehouse ? "Warehouse updated" : "Warehouse created", silentError: true });

  const setLocation = (i: number, patch: Partial<Location>) => setLocations((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!code.trim()) e.code = "Enter a short code.";
    if (!name.trim()) e.name = "Enter the warehouse name.";
    const codes = locations.map((l) => l.code.trim().toUpperCase());
    locations.forEach((l, i) => {
      if (!l.code.trim()) e[`locations.${i}.code`] = "Required.";
      else if (codes.indexOf(codes[i]) !== i) e[`locations.${i}.code`] = "Duplicate code.";
    });
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      await save.mutateAsync({
        code: code.trim(), name: name.trim(), branch, address, is_active: active,
        locations: locations.map((l) => ({ ...(l.id ? { id: l.id } : {}), code: l.code.trim(), name: l.name.trim(), is_active: l.is_active })),
      });
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={warehouse ? `Edit ${warehouse.code}` : "New warehouse"} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={submit}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" required error={errors.code} hint="Used in document numbers and lists, e.g. KTM.">
          <Input value={code} maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase())} invalid={!!errors.code} />
        </Field>
        <Field label="Name" required error={errors.name}><Input value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} /></Field>
        <Field label="Branch" error={errors.branch}>
          <EntitySelect resource="branches" value={branch} onChange={(v) => setBranch(v)} placeholder="No branch" />
        </Field>
        <Field label="Status">
          <label className="flex h-8 items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" className="accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </Field>
        <Field label="Address" className="sm:col-span-2" error={errors.address}><Textarea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-600">Storage locations</h3>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setLocations((ls) => [...ls, { code: "", name: "", is_active: true }])}>Add location</Button>
        </div>
        {locations.length === 0 ? <p className="text-xs text-slate-500">No storage locations. Stock is held at warehouse level.</p> : (
          <table className="w-full text-[13px]">
            <thead className="border-b border-line text-left text-xs text-slate-500">
              <tr><th className="py-1.5 pr-2">Code</th><th className="py-1.5 pr-2">Name</th><th className="py-1.5 pr-2">Active</th><th className="w-8" /></tr>
            </thead>
            <tbody>
              {locations.map((l, i) => (
                <tr key={l.id ?? `new-${i}`} className="align-top">
                  <td className="py-1 pr-2">
                    <Input value={l.code} maxLength={20} onChange={(e) => setLocation(i, { code: e.target.value })} invalid={!!errors[`locations.${i}.code`]} />
                    {errors[`locations.${i}.code`] && <p className="mt-0.5 text-xs text-red-600">{errors[`locations.${i}.code`]}</p>}
                  </td>
                  <td className="py-1 pr-2"><Input value={l.name} maxLength={80} onChange={(e) => setLocation(i, { name: e.target.value })} /></td>
                  <td className="py-1 pr-2 pt-2.5">
                    <input type="checkbox" className="accent-brand-600" aria-label="Active" checked={l.is_active} onChange={(e) => setLocation(i, { is_active: e.target.checked })} />
                  </td>
                  <td className="py-1 pt-1.5">
                    {!l.id && (
                      <button type="button" aria-label="Remove location" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        onClick={() => setLocations((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {locations.some((l) => l.id) && <p className="mt-1 text-xs text-slate-500">Saved locations cannot be deleted; untick Active to retire one.</p>}
      </div>
    </Dialog>
  );
}
