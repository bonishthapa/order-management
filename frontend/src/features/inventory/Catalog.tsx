import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useApiMutation, useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CatalogItem { id: number; name: string; is_active: boolean; product_count: number | null; parent?: number | null }
type Kind = "category" | "brand";

const CONFIG: Record<Kind, { resource: string; label: string; filter: string }> = {
  category: { resource: "product-categories", label: "category", filter: "category" },
  brand: { resource: "brands", label: "brand", filter: "brand" },
};

export function CategoriesPage() {
  return (
    <>
      <PageHeader title="Categories and brands" subtitle="Groupings used to filter products, reports and bulk price updates." />
      <div className="grid gap-4 lg:grid-cols-2">
        <CatalogPanel kind="category" title="Product categories" />
        <CatalogPanel kind="brand" title="Brands" />
      </div>
    </>
  );
}

function CatalogPanel({ kind, title }: { kind: Kind; title: string }) {
  const { can } = useAuth();
  const cfg = CONFIG[kind];
  const query = useOptions<CatalogItem>(cfg.resource);
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const remove = useApiMutation(async (id: number) => api.delete(`/${cfg.resource}/${id}/`), { invalidate: [cfg.resource], success: `${title.replace(/s$/, "")} deleted` });
  const manage = can("products.manage");
  const items = query.data ?? [];
  const nameOf = (id: number | null | undefined) => items.find((i) => i.id === id)?.name;

  return (
    <Panel title={title} actions={manage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>New {cfg.label}</Button>}>
      {query.isLoading ? <LoadingBlock /> : query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : items.length === 0 ? (
        <EmptyState title={`No ${cfg.label === "category" ? "categories" : "brands"} yet`} />
      ) : (
        <table className="w-full text-[13px]">
          <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              {kind === "category" && <th className="px-4 py-2">Parent</th>}
              <th className="px-4 py-2 text-right">Products</th>
              <th className="px-4 py-2">Status</th>
              {manage && <th className="w-20 px-2 py-2" />}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium text-slate-800">{item.name}</td>
                {kind === "category" && <td className="px-4 py-2 text-slate-600">{nameOf(item.parent) ?? "–"}</td>}
                <td className="num px-4 py-2">
                  {item.product_count ? <Link className="link" to={`/inventory/products?${cfg.filter}=${item.id}`}>{item.product_count}</Link> : "0"}
                </td>
                <td className="px-4 py-2"><Badge tone={item.is_active ? "green" : "neutral"}>{item.is_active ? "Active" : "Inactive"}</Badge></td>
                {manage && (
                  <td className="px-2 py-1.5">
                    <div className="flex justify-end gap-0.5">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${item.name}`} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(item)} />
                      <Button size="sm" variant="ghost" aria-label={`Delete ${item.name}`} icon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={!!item.product_count} title={item.product_count ? "In use by products. Deactivate it instead." : undefined}
                        onClick={() => setDeleting(item)} />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <CatalogDialog kind={kind} item={editing === "new" ? null : editing} items={items} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name ?? ""}`} tone="danger"
        confirmLabel="Delete" loading={remove.isPending}
        description={`Only a ${cfg.label} that no product or other record uses can be deleted. Otherwise, deactivate it.`}
        onConfirm={() => remove.mutateAsync(deleting!.id).then(() => setDeleting(null)).catch(() => setDeleting(null))} />
    </Panel>
  );
}

function CatalogDialog({ kind, item, items, onClose }: { kind: Kind; item: CatalogItem | null; items: CatalogItem[]; onClose: () => void }) {
  const cfg = CONFIG[kind];
  const [name, setName] = useState(item?.name ?? "");
  const [parent, setParent] = useState(item?.parent ? String(item.parent) : "");
  const [active, setActive] = useState(item?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useApiMutation(async (body: any) => (item
    ? (await api.patch(`/${cfg.resource}/${item.id}/`, body)).data
    : (await api.post(`/${cfg.resource}/`, body)).data),
  { invalidate: [cfg.resource, "products"], success: item ? "Saved" : `${cfg.label === "category" ? "Category" : "Brand"} created`, silentError: true });

  // A category cannot be its own ancestor: exclude itself and its descendants from the parent choices.
  const descendants = new Set<number>();
  if (item) {
    const walk = (id: number) => items.filter((i) => i.parent === id).forEach((child) => { descendants.add(child.id); walk(child.id); });
    descendants.add(item.id);
    walk(item.id);
  }

  const submit = async () => {
    if (!name.trim()) { setErrors({ name: "Enter a name." }); return; }
    try {
      await save.mutateAsync(kind === "category"
        ? { name: name.trim(), parent: parent ? Number(parent) : null, is_active: active }
        : { name: name.trim(), is_active: active });
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={item ? `Edit ${item.name}` : `New ${cfg.label}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={submit}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" required error={errors.name ?? errors.non_field_errors}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} invalid={!!errors.name}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        </Field>
        {kind === "category" && (
          <Field label="Parent category" error={errors.parent}>
            <Select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">None (top level)</option>
              {items.filter((i) => !descendants.has(i.id)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </Select>
          </Field>
        )}
        <label className="flex items-center gap-2 text-[13px] text-slate-700">
          <input type="checkbox" className="accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          <span className="text-xs text-slate-500">(inactive entries stay on existing products)</span>
        </label>
      </div>
    </Dialog>
  );
}
