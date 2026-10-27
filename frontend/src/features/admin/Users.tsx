import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Check, KeyRound, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, fieldErrors } from "@/api/client";
import { useGet, useList, useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { DataTable } from "@/components/data/DataTable";
import { FilterBar, SearchBox } from "@/components/data/Filters";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Field } from "@/components/ui/Field";
import { Input, Select } from "@/components/ui/Input";
import { PageHeader, Panel } from "@/components/ui/Page";
import { TabList, TabPanel, Tabs } from "@/components/ui/Tabs";
import { useDebounce } from "@/hooks/useDebounce";
import { cn } from "@/utils/cn";
import { formatDateTime } from "@/utils/format";

export interface Member {
  id: number;
  user: number;
  email: string;
  full_name: string;
  phone: string;
  role: string;
  role_label: string;
  branches: number[];
  warehouses: number[];
  is_active: boolean;
  user_active: boolean;
  last_login: string | null;
  permissions: string[];
  created_at: string;
}

interface RoleMatrix {
  permissions: { code: string; label: string }[];
  roles: { code: string; label: string; permissions: string[] }[];
}

interface WarehouseOption { id: number; code: string; name: string; branch: number | null; is_active: boolean; is_transit: boolean }
interface BranchOption { id: number; code: string; name: string; is_active: boolean }

const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard", settings: "Company settings", users: "Users", fiscal: "Fiscal years", customers: "Customers",
  suppliers: "Suppliers", products: "Products", inventory: "Inventory", sales: "Sales", purchases: "Purchases",
  accounting: "Accounting", expenses: "Expenses", reports: "Reports", audit: "Audit",
};

export function useRoleMatrix() {
  return useGet<RoleMatrix>(["users", "roles"], "/users/roles/");
}

export function UsersPage() {
  const { session } = useAuth();
  const [tab, setTab] = useState("members");
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Users and permissions"
        subtitle={`People who can sign in to ${session?.organization?.name ?? "this organisation"}. Users are deactivated, never deleted, so the audit trail keeps their name.`}
        actions={tab === "members" && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>Add user</Button>
        )} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabList className="mb-4" tabs={[{ value: "members", label: "Members" }, { value: "roles", label: "Roles and permissions" }]} />
        <TabPanel value="members"><MembersGrid /></TabPanel>
        <TabPanel value="roles"><RoleMatrixView /></TabPanel>
      </Tabs>
      {creating && <MemberDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function MembersGrid() {
  const { session } = useAuth();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [active, setActive] = useState("true");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [ordering, setOrdering] = useState("user__full_name");
  const [editing, setEditing] = useState<Member | null>(null);
  const debounced = useDebounce(search, 300);
  const roles = useRoleMatrix();
  const warehouses = useOptions<WarehouseOption>("warehouses");
  const branches = useOptions<BranchOption>("branches");
  const query = useList<Member>("users", { search: debounced, role, is_active: active, page, page_size: pageSize, ordering });

  const columns = useMemo<ColDef[]>(() => {
    const whCode = new Map((warehouses.data ?? []).map((w) => [w.id, w.code]));
    const brCode = new Map((branches.data ?? []).map((b) => [b.id, b.code]));
    return [
      {
        field: "full_name", headerName: "Name", minWidth: 180, flex: 2, sortable: true, sortField: "user__full_name",
        cellRenderer: (p: ICellRendererParams<Member>) => (
          <span className="font-medium text-brand-700">
            {p.value}
            {p.data?.user === session?.user.id && <span className="ml-1.5 text-2xs font-normal text-slate-400">(you)</span>}
          </span>
        ),
      } as ColDef,
      { field: "email", headerName: "Email", minWidth: 200, flex: 2 },
      { field: "role_label", headerName: "Role", minWidth: 140, sortable: true, sortField: "role" } as ColDef,
      {
        colId: "warehouses", headerName: "Warehouses", minWidth: 150,
        valueGetter: (p) => (p.data?.warehouses?.length ? p.data.warehouses.map((id: number) => whCode.get(id) ?? `#${id}`).join(", ") : "All warehouses"),
        cellClass: (p) => (p.data?.warehouses?.length ? "" : "text-slate-400"),
      },
      {
        colId: "branches", headerName: "Branches", minWidth: 130,
        valueGetter: (p) => (p.data?.branches?.length ? p.data.branches.map((id: number) => brCode.get(id) ?? `#${id}`).join(", ") : "All branches"),
        cellClass: (p) => (p.data?.branches?.length ? "" : "text-slate-400"),
      },
      {
        field: "is_active", headerName: "Status", minWidth: 110, maxWidth: 140,
        cellRenderer: (p: ICellRendererParams<Member>) => !p.data ? null
          : !p.data.user_active ? <Badge tone="red">Account disabled</Badge>
            : p.data.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>,
      },
      {
        field: "last_login", headerName: "Last sign-in", minWidth: 160, cellClass: "num-cell",
        valueFormatter: (p) => (p.value ? formatDateTime(p.value, session?.organization?.timezone) : "Never"),
      },
    ];
  }, [warehouses.data, branches.data, session]);

  return (
    <div className="panel overflow-hidden">
      <FilterBar active={!!(search || role || active !== "true")} onReset={() => { setSearch(""); setRole(""); setActive("true"); setPage(1); }}>
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Name or email…" />
        <Select aria-label="Role" className="w-44" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
          <option value="">All roles</option>
          {roles.data?.roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </Select>
        <Select aria-label="Status" className="w-36" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
          <option value="true">Active users</option>
          <option value="false">Inactive users</option>
          <option value="">All users</option>
        </Select>
      </FilterBar>
      <DataTable<Member>
        id="admin-users"
        columns={columns}
        rows={query.data?.results}
        total={query.data?.count}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        ordering={ordering}
        onOrderingChange={setOrdering}
        loading={query.isLoading}
        fetching={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        onRowClick={setEditing}
        empty={{ title: "No users found", description: "Change the filters or add a user." }}
      />
      {editing && <MemberDialog member={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Checkbox list used for warehouse and branch restrictions. Empty selection means "no restriction". */
function RestrictionPicker<T extends { id: number; code: string; name: string }>({ items, value, onChange, allLabel, loading }: {
  items: T[]; value: number[]; onChange: (ids: number[]) => void; allLabel: string; loading?: boolean;
}) {
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="rounded border border-line">
      <div className="flex items-center justify-between border-b border-line bg-surface-muted px-2.5 py-1.5 text-xs">
        <span className="text-slate-600">{value.length ? `${value.length} selected` : allLabel}</span>
        {value.length > 0 && <button type="button" className="link text-xs" onClick={() => onChange([])}>Clear</button>}
      </div>
      <div className="max-h-36 overflow-y-auto p-1">
        {loading && <p className="px-2 py-1.5 text-xs text-slate-500">Loading…</p>}
        {!loading && items.length === 0 && <p className="px-2 py-1.5 text-xs text-slate-500">None configured.</p>}
        {items.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-surface-sunken">
            <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={value.includes(item.id)} onChange={() => toggle(item.id)} />
            <span className="font-medium text-slate-700">{item.code}</span>
            <span className="truncate text-slate-500">{item.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function MemberDialog({ member, onClose }: { member?: Member; onClose: () => void }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const roles = useRoleMatrix();
  const warehouses = useOptions<WarehouseOption>("warehouses");
  const branches = useOptions<BranchOption>("branches");
  const isSelf = member?.user === session?.user.id;
  const [email, setEmail] = useState(member?.email ?? "");
  const [fullName, setFullName] = useState(member?.full_name ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [role, setRole] = useState(member?.role ?? "");
  const [password, setPassword] = useState("");
  const [selectedWarehouses, setSelectedWarehouses] = useState<number[]>(member?.warehouses ?? []);
  const [selectedBranches, setSelectedBranches] = useState<number[]>(member?.branches ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | "deactivate" | "activate">(null);
  const [resetting, setResetting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const save = async () => {
    const e: Record<string, string> = {};
    if (!member && !/^\S+@\S+\.\S+$/.test(email.trim())) e.email = "Enter a valid email address.";
    if (!fullName.trim()) e.full_name = "Enter the user's name.";
    if (!role) e.role = "Choose a role.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      full_name: fullName.trim(), phone: phone.trim(), role, warehouses: selectedWarehouses, branches: selectedBranches,
    };
    try {
      if (member) {
        if (isSelf) delete body.role;
        await api.patch(`/users/${member.id}/`, body);
        toast.success("User updated");
      } else {
        await api.post("/users/", { ...body, email: email.trim().toLowerCase(), password });
        toast.success(`${fullName.trim()} added`);
      }
      refresh();
      onClose();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    if (!member || !confirm) return;
    setToggling(true);
    try {
      await api.post(`/users/${member.id}/${confirm}/`);
      toast.success(confirm === "deactivate" ? `${member.full_name} deactivated` : `${member.full_name} reactivated`);
      refresh();
      setConfirm(null);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggling(false);
    }
  };

  const activeWarehouses = (warehouses.data ?? []).filter((w) => w.is_active || selectedWarehouses.includes(w.id));
  const activeBranches = (branches.data ?? []).filter((b) => b.is_active || selectedBranches.includes(b.id));

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={member ? `Edit ${member.full_name}` : "Add user"}
        description={member ? member.email : "The user signs in with this email and must choose a new password at first sign-in."}
        footer={<>
          {member && (
            <div className="mr-auto flex gap-2">
              <Button icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setResetting(true)}>Reset password</Button>
              {!isSelf && (member.is_active
                ? <Button variant="danger" onClick={() => setConfirm("deactivate")}>Deactivate</Button>
                : <Button onClick={() => setConfirm("activate")}>Reactivate</Button>)}
            </div>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>{member ? "Save changes" : "Add user"}</Button>
        </>}>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Field label="Email" required={!member} error={errors.email} hint={member ? "The sign-in email cannot be changed here." : undefined}>
            <Input type="email" autoComplete="off" value={email} disabled={!!member} onChange={(e) => setEmail(e.target.value)} invalid={!!errors.email} />
          </Field>
          <Field label="Full name" required error={errors.full_name}>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} invalid={!!errors.full_name} />
          </Field>
          <Field label="Phone" error={errors.phone}><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Role" required error={errors.role} hint={isSelf ? "You cannot change your own role." : undefined}>
            <Select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value)} invalid={!!errors.role}>
              <option value="">Choose…</option>
              {roles.data?.roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </Select>
          </Field>
          {!member && (
            <Field label="Initial password" error={errors.password} className="sm:col-span-2"
              hint="Required for a new account (at least 10 characters). Leave blank only if the person already has an account in another organisation.">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!errors.password} />
            </Field>
          )}
          <Field label="Warehouse access" error={errors.warehouses} hint="Leave empty to allow every warehouse.">
            <RestrictionPicker items={activeWarehouses} value={selectedWarehouses} onChange={setSelectedWarehouses}
              allLabel="All warehouses" loading={warehouses.isLoading} />
          </Field>
          <Field label="Branch access" error={errors.branches} hint="Leave empty to allow every branch.">
            <RestrictionPicker items={activeBranches} value={selectedBranches} onChange={setSelectedBranches}
              allLabel="All branches" loading={branches.isLoading} />
          </Field>
          {role && roles.data && (
            <div className="sm:col-span-2">
              <RoleSummary permissions={roles.data.roles.find((r) => r.code === role)?.permissions ?? []} matrix={roles.data} />
            </div>
          )}
        </div>
      </Dialog>
      {member && (
        <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} loading={toggling}
          title={confirm === "deactivate" ? `Deactivate ${member.full_name}?` : `Reactivate ${member.full_name}?`}
          tone={confirm === "deactivate" ? "danger" : "primary"}
          confirmLabel={confirm === "deactivate" ? "Deactivate" : "Reactivate"}
          description={confirm === "deactivate"
            ? "The user can no longer sign in to this organisation. Their documents and audit history are kept."
            : "The user can sign in to this organisation again with their existing password."}
          onConfirm={toggleActive} />
      )}
      {member && resetting && <ResetPasswordDialog member={member} onClose={() => setResetting(false)} />}
    </>
  );
}

function RoleSummary({ permissions, matrix }: { permissions: string[]; matrix: RoleMatrix }) {
  const granted = new Set(permissions);
  const groups = groupPermissions(matrix.permissions).map(([module, perms]) => ({
    module, count: perms.filter((p) => granted.has(p.code)).length, total: perms.length,
  })).filter((g) => g.count > 0);
  return (
    <div className="rounded border border-line bg-surface-muted px-3 py-2">
      <p className="mb-1.5 text-xs font-medium text-slate-600">This role grants</p>
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => (
          <Badge key={g.module} tone={g.count === g.total ? "blue" : "slate"}>{MODULE_LABELS[g.module] ?? g.module} {g.count}/{g.total}</Badge>
        ))}
      </div>
    </div>
  );
}

function ResetPasswordDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setError(null);
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("The passwords do not match.");
    setSaving(true);
    try {
      await api.post(`/users/${member.id}/reset-password/`, { new_password: password });
      toast.success(`Temporary password set for ${member.full_name}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={`Reset password for ${member.full_name}`}
      description="Give the temporary password to the user in person. They must choose a new one at their next sign-in."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={submit}>Set temporary password</Button></>}>
      <div className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Temporary password" required>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" required>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function groupPermissions(perms: { code: string; label: string }[]): [string, { code: string; label: string }[]][] {
  const groups = new Map<string, { code: string; label: string }[]>();
  for (const p of perms) {
    const module = p.code.split(".")[0];
    if (!groups.has(module)) groups.set(module, []);
    groups.get(module)!.push(p);
  }
  return [...groups.entries()];
}

function RoleMatrixView() {
  const query = useRoleMatrix();
  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const { roles, permissions } = query.data;
  if (!roles.length) return <EmptyState title="No roles defined" />;
  const grants = new Map(roles.map((r) => [r.code, new Set(r.permissions)]));
  return (
    <Panel title="Role permission matrix"
      actions={<span className="text-xs text-slate-500">Roles are fixed; the server checks every request against this matrix.</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[13px]">
          <thead className="sticky top-0 border-b border-line bg-surface-muted text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Permission</th>
              {roles.map((r) => <th key={r.code} className="w-[96px] px-2 py-2 text-center font-medium">{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {groupPermissions(permissions).map(([module, perms]) => (
              <ModuleRows key={module} module={module} perms={perms} roles={roles.map((r) => r.code)} grants={grants} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleRows({ module, perms, roles, grants }: {
  module: string; perms: { code: string; label: string }[]; roles: string[]; grants: Map<string, Set<string>>;
}) {
  return (
    <>
      <tr className="border-b border-line bg-surface-sunken/60">
        <td colSpan={roles.length + 1} className="px-4 py-1.5 text-2xs font-semibold uppercase tracking-wide text-slate-500">
          {MODULE_LABELS[module] ?? module}
        </td>
      </tr>
      {perms.map((p) => (
        <tr key={p.code} className="border-b border-line hover:bg-surface-muted">
          <td className="px-4 py-1.5">
            <div className="text-slate-800">{p.label}</div>
            <div className="text-2xs text-slate-400">{p.code}</div>
          </td>
          {roles.map((r) => {
            const has = grants.get(r)?.has(p.code);
            return (
              <td key={r} className={cn("px-2 py-1.5 text-center", has ? "text-emerald-600" : "text-slate-300")}>
                {has ? <Check className="mx-auto h-4 w-4" aria-label="Granted" /> : <span aria-label="Not granted">–</span>}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
