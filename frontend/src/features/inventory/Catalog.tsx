import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useApiMutation, useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { FormDialog, FormField, FormGrid } from "@/components/form";
import { BaseTable, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { PageHeader, Panel } from "@/components/ui/Page";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CatalogItem { id: number; name: string; is_active: boolean; product_count: number | null; parent?: number | null }
type Kind = "category" | "brand";
interface CatalogValues { name: string; parent: number | null; is_active: boolean }

const CONFIG: Record<Kind, { resource: string; label: string; filter: string; title: string }> = {
  category: { resource: "product-categories", label: "category", filter: "category", title: "Category" },
  brand: { resource: "brands", label: "brand", filter: "brand", title: "Brand" },
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
  const remove = useApiMutation(async (id: number) => api.delete(`/${cfg.resource}/${id}/`), { invalidate: [cfg.resource], success: `${cfg.title} deleted` });
  const manage = can("products.manage");
  const items = query.data ?? [];
  const nameOf = (id: number | null | undefined) => items.find((i) => i.id === id)?.name;

  const columns: TableColumn<CatalogItem>[] = [
    col.text("name", "Name", { className: "font-medium text-slate-800" }),
    ...(kind === "category" ? [col.custom<CatalogItem>("parent", "Parent", (i) => <span className="text-slate-600">{nameOf(i.parent) ?? "–"}</span>)] : []),
    col.custom("product_count", "Products", (i) => (i.product_count
      ? <Link className="link" to={`/inventory/products?${cfg.filter}=${i.id}`}>{i.product_count}</Link> : "0"), { align: "right" }),
    col.custom("is_active", "Status", (i) => <Badge tone={i.is_active ? "green" : "neutral"}>{i.is_active ? "Active" : "Inactive"}</Badge>),
    ...(manage ? [col.custom<CatalogItem>("actions", "", (i) => (
      <div className="flex justify-end gap-0.5">
        <Button size="sm" variant="ghost" aria-label={`Edit ${i.name}`} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(i)} />
        <Button size="sm" variant="ghost" aria-label={`Delete ${i.name}`} icon={<Trash2 className="h-3.5 w-3.5" />}
          disabled={!!i.product_count} title={i.product_count ? "In use by products. Deactivate it instead." : undefined}
          onClick={() => setDeleting(i)} />
      </div>
    ), { width: 80 })] : []),
  ];

  return (
    <Panel title={title} actions={manage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>New {cfg.label}</Button>}>
      <BaseTable rows={query.data} columns={columns} loading={query.isLoading} error={query.error} onRetry={() => query.refetch()}
        empty={{ title: `No ${kind === "category" ? "categories" : "brands"} yet` }} />
      <CatalogDialog key={editing === "new" ? "new" : editing?.id ?? "none"} kind={kind} item={editing === "new" ? null : editing} items={items}
        open={editing !== null} onClose={() => setEditing(null)} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name ?? ""}`} tone="danger"
        confirmLabel="Delete" loading={remove.isPending}
        description={`Only a ${cfg.label} that no product or other record uses can be deleted. Otherwise, deactivate it.`}
        onConfirm={() => remove.mutateAsync(deleting!.id).then(() => setDeleting(null)).catch(() => setDeleting(null))} />
    </Panel>
  );
}

function CatalogDialog({ kind, item, items, open, onClose }: { kind: Kind; item: CatalogItem | null; items: CatalogItem[]; open: boolean; onClose: () => void }) {
  const cfg = CONFIG[kind];
  const queryClient = useQueryClient();

  // A category cannot be its own ancestor: exclude itself and its descendants from the parent choices.
  const excluded = new Set<number>();
  if (item) {
    const walk = (id: number) => items.filter((i) => i.parent === id).forEach((child) => { excluded.add(child.id); walk(child.id); });
    excluded.add(item.id);
    walk(item.id);
  }

  return (
    <FormDialog<CatalogValues> open={open} onOpenChange={(o) => !o && onClose()} size="sm" title={item ? `Edit ${item.name}` : `New ${cfg.label}`}
      errorFieldMap={{ non_field_errors: "name" }}
      defaultValues={{ name: item?.name ?? "", parent: item?.parent ?? null, is_active: item?.is_active ?? true }}
      onSubmit={async (values) => {
        const body = kind === "category"
          ? { name: values.name.trim(), parent: values.parent, is_active: values.is_active }
          : { name: values.name.trim(), is_active: values.is_active };
        if (item) await api.patch(`/${cfg.resource}/${item.id}/`, body);
        else await api.post(`/${cfg.resource}/`, body);
        [cfg.resource, "products"].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
        toast.success(item ? "Saved" : `${cfg.title} created`);
      }}>
      <FormGrid columns={1}>
        <FormField name="name" label="Name" required maxLength={100} autoFocus />
        {kind === "category" && (
          <FormField name="parent" label="Parent category" type="select" emptyOption="None (top level)"
            options={items.filter((i) => !excluded.has(i.id)).map((i) => ({ value: i.id, label: i.name }))} />
        )}
        <FormField name="is_active" label="Status" type="checkbox" hint="Active (inactive entries stay on existing products)" />
      </FormGrid>
    </FormDialog>
  );
}
