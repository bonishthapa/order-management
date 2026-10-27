import { Check, KeyRound, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/api/client";
import { useGet, useList, useOptions } from "@/api/hooks";
import { useAuth } from "@/auth/AuthContext";
import { FormDialog, FormField, FormGrid, useWatch } from "@/components/form";
import { BaseTable, DataGrid, FilterBar, SearchBox, col, type TableColumn } from "@/components/table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/ui/Feedback";
import { Select } from "@/components/ui/Input";
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

interface MemberValues {
  email: string;
  full_name: string;
  phone: string;
  role: string;
  password: string;
  warehouses: number[];
  branches: number[];
}

const MODULE_LABELS: Record<string, string> = {
  dashboard: "Dashboard", settings: "Company settings", users: "Users", fiscal: "Fiscal years", customers: "Customers",
  suppliers: "Suppliers", products: "Products", inventory: "Inventory", sales: "Sales", purchases: "Purchases",
  accounting: "Accounting", expenses: "Expenses", reports: "Reports", audit: "Audit",
};

const EMAIL = /^\S+@\S+\.\S+$/;

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
  const tz = session?.organization?.timezone;

  const columns = useMemo<TableColumn<Member>[]>(() => {
    const whCode = new Map((warehouses.data ?? []).map((w) => [w.id, w.code]));
    const brCode = new Map((branches.data ?? []).map((b) => [b.id, b.code]));
    const codes = (ids: number[], map: Map<number, string>, all: string) => (ids.length
      ? ids.map((id) => map.get(id) ?? `#${id}`).join(", ")
      : <span className="text-slate-400">{all}</span>);
    return [
      col.custom<Member>("full_name", "Name", (m) => (
        <span className="font-medium text-brand-700">
          {m.full_name}
          {m.user === session?.user.id && <span className="ml-1.5 text-2xs font-normal text-slate-400">(you)</span>}
        </span>
      ), { minWidth: 180, flex: 2, sortable: true, sortField: "user__full_name" }),
      col.text<Member>("email", "Email", { minWidth: 200, flex: 2 }),
      col.text<Member>("role_label", "Role", { minWidth: 140, sortable: true, sortField: "role" }),
      col.custom<Member>("warehouses", "Warehouses", (m) => codes(m.warehouses, whCode, "All warehouses"), {
        minWidth: 150, value: (m) => (m.warehouses.length ? m.warehouses.map((id) => whCode.get(id) ?? `#${id}`).join(", ") : "All warehouses"),
      }),
      col.custom<Member>("branches", "Branches", (m) => codes(m.branches, brCode, "All branches"), {
        minWidth: 130, value: (m) => (m.branches.length ? m.branches.map((id) => brCode.get(id) ?? `#${id}`).join(", ") : "All branches"),
      }),
      col.custom<Member>("is_active", "Status", (m) => (!m.user_active ? <Badge tone="red">Account disabled</Badge>
        : m.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>), { minWidth: 110 }),
      col.custom<Member>("last_login", "Last sign-in", (m) => (m.last_login ? formatDateTime(m.last_login, tz) : "Never"), {
        minWidth: 160, value: (m) => (m.last_login ? formatDateTime(m.last_login, tz) : "Never"),
      }),
    ];
  }, [warehouses.data, branches.data, session, tz]);

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
      <DataGrid<Member>
        id="admin-users"
        columns={columns}
        rows={query.data?.results}
        total={query.data?.count}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s: number) => { setPageSize(s); setPage(1); }}
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
function RestrictionPicker<T extends { id: number; code: string; name: string }>({ items, value, onChange, allLabel, loading, disabled }: {
  items: T[]; value: number[]; onChange: (ids: number[]) => void; allLabel: string; loading?: boolean; disabled?: boolean;
}) {
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="rounded border border-line">
      <div className="flex items-center justify-between border-b border-line bg-surface-muted px-2.5 py-1.5 text-xs">
        <span className="text-slate-600">{value.length ? `${value.length} selected` : allLabel}</span>
        {value.length > 0 && !disabled && <button type="button" className="link text-xs" onClick={() => onChange([])}>Clear</button>}
      </div>
      <div className="max-h-36 overflow-y-auto p-1">
        {loading && <p className="px-2 py-1.5 text-xs text-slate-500">Loading…</p>}
        {!loading && items.length === 0 && <p className="px-2 py-1.5 text-xs text-slate-500">None configured.</p>}
        {items.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-surface-sunken">
            <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" disabled={disabled} checked={value.includes(item.id)} onChange={() => toggle(item.id)} />
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
  const [confirm, setConfirm] = useState<null | "deactivate" | "activate">(null);
  const [resetting, setResetting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  const submit = async (v: MemberValues) => {
    const body: Record<string, unknown> = {
      full_name: v.full_name.trim(), phone: (v.phone ?? "").trim(), role: v.role, warehouses: v.warehouses, branches: v.branches,
    };
    if (member) {
      if (isSelf) delete body.role;
      await api.patch(`/users/${member.id}/`, body);
      toast.success("User updated");
    } else {
      await api.post("/users/", { ...body, email: v.email.trim().toLowerCase(), password: v.password });
      toast.success(`${v.full_name.trim()} added`);
    }
    refresh();
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

  const defaults: MemberValues = {
    email: member?.email ?? "", full_name: member?.full_name ?? "", phone: member?.phone ?? "", role: member?.role ?? "",
    password: "", warehouses: member?.warehouses ?? [], branches: member?.branches ?? [],
  };
  const roleOptions = (roles.data?.roles ?? []).map((r) => ({ value: r.code, label: r.label }));

  return (
    <>
      <FormDialog<MemberValues> footerActions={member && (
        <>
          <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setResetting(true)}>Reset password</Button>
          {!isSelf && (member.is_active
            ? <Button size="sm" variant="danger" onClick={() => setConfirm("deactivate")}>Deactivate</Button>
            : <Button size="sm" onClick={() => setConfirm("activate")}>Reactivate</Button>)}
        </>
      )} open onOpenChange={(o) => !o && onClose()} size="lg" title={member ? `Edit ${member.full_name}` : "Add user"}
        description={member ? member.email : "The user signs in with this email and must choose a new password at first sign-in."}
        submitLabel={member ? "Save changes" : "Add user"} defaultValues={defaults} onSubmit={submit}>
        <FormGrid columns={2}>
          <FormField name="email" label="Email" type="email" required={!member} disabled={!!member}
            hint={member ? "The sign-in email cannot be changed here." : undefined}
            rules={member ? undefined : { pattern: { value: EMAIL, message: "Enter a valid email address." } }} />
          <FormField name="full_name" label="Full name" required />
          <FormField name="phone" label="Phone" type="tel" />
          <FormField name="role" label="Role" type="select" required options={roleOptions} disabled={isSelf}
            hint={isSelf ? "You cannot change your own role." : undefined} />
          {!member && (
            <FormField name="password" label="Initial password" type="password" span="full"
              hint="Required for a new account (at least 10 characters). Leave blank only if the person already has an account in another organisation." />
          )}
          <FormField name="warehouses" label="Warehouse access" type="custom" hint="Leave empty to allow every warehouse."
            render={({ value, onChange, disabled }) => (
              <RestrictionPicker items={(warehouses.data ?? []).filter((w) => w.is_active || (value as number[]).includes(w.id))}
                value={value ?? []} onChange={onChange} allLabel="All warehouses" loading={warehouses.isLoading} disabled={disabled} />
            )} />
          <FormField name="branches" label="Branch access" type="custom" hint="Leave empty to allow every branch."
            render={({ value, onChange, disabled }) => (
              <RestrictionPicker items={(branches.data ?? []).filter((b) => b.is_active || (value as number[]).includes(b.id))}
                value={value ?? []} onChange={onChange} allLabel="All branches" loading={branches.isLoading} disabled={disabled} />
            )} />
          {roles.data && <RoleSummary matrix={roles.data} />}
        </FormGrid>
      </FormDialog>
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

/** Summary of the role currently chosen in the member form. */
function RoleSummary({ matrix }: { matrix: RoleMatrix }) {
  const role = useWatch({ name: "role" }) as string;
  if (!role) return null;
  const granted = new Set(matrix.roles.find((r) => r.code === role)?.permissions ?? []);
  const groups = groupPermissions(matrix.permissions).map(([module, perms]) => ({
    module, count: perms.filter((p) => granted.has(p.code)).length, total: perms.length,
  })).filter((g) => g.count > 0);
  return (
    <div className="col-span-full rounded border border-line bg-surface-muted px-3 py-2">
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
  return (
    <FormDialog<{ new_password: string; confirm: string }> open onOpenChange={(o) => !o && onClose()} size="sm"
      title={`Reset password for ${member.full_name}`} submitLabel="Set temporary password"
      description="Give the temporary password to the user in person. They must choose a new one at their next sign-in."
      defaultValues={{ new_password: "", confirm: "" }}
      onSubmit={async (v) => {
        await api.post(`/users/${member.id}/reset-password/`, { new_password: v.new_password });
        toast.success(`Temporary password set for ${member.full_name}`);
      }}>
      {(form) => (
        <FormGrid columns={1}>
          <FormField name="new_password" label="Temporary password" type="password" required autoFocus
            rules={{ minLength: { value: 10, message: "Use at least 10 characters." } }} />
          <FormField name="confirm" label="Confirm password" type="password" required
            rules={{ validate: (v: string) => v === form.getValues("new_password") || "The passwords do not match." }} />
        </FormGrid>
      )}
    </FormDialog>
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

type MatrixRow = { id: string; group?: string; code?: string; label?: string };

function RoleMatrixView() {
  const query = useRoleMatrix();
  const data = query.data;
  const { rows, columns } = useMemo(() => {
    if (!data) return { rows: [] as MatrixRow[], columns: [] as TableColumn<MatrixRow>[] };
    const grants = new Map(data.roles.map((r) => [r.code, new Set(r.permissions)]));
    const rows: MatrixRow[] = groupPermissions(data.permissions).flatMap(([module, perms]) => [
      { id: `g:${module}`, group: MODULE_LABELS[module] ?? module },
      ...perms.map((p) => ({ id: p.code, code: p.code, label: p.label })),
    ]);
    const columns: TableColumn<MatrixRow>[] = [
      col.custom<MatrixRow>("permission", "Permission", (r) => (r.group
        ? <span className="text-2xs font-semibold uppercase tracking-wide text-slate-500">{r.group}</span>
        : <><div className="text-slate-800">{r.label}</div><div className="text-2xs text-slate-400">{r.code}</div></>), { minWidth: 260 }),
      ...data.roles.map((role) => col.custom<MatrixRow>(role.code, role.label, (r) => {
        if (r.group) return null;
        const has = grants.get(role.code)?.has(r.code!);
        return has
          ? <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Granted" />
          : <span className="text-slate-300" aria-label="Not granted">–</span>;
      }, { align: "center", width: 96, headerClassName: "whitespace-normal" })),
    ];
    return { rows, columns };
  }, [data]);

  if (query.isLoading) return <LoadingBlock />;
  if (query.error || !data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!data.roles.length) return <EmptyState title="No roles defined" />;
  return (
    <Panel title="Role permission matrix"
      actions={<span className="text-xs text-slate-500">Roles are fixed; the server checks every request against this matrix.</span>}>
      <BaseTable<MatrixRow> columns={columns} rows={rows} density="compact" minWidth={900} stickyHeader caption="Role permission matrix"
        rowKey={(r) => r.id} rowClassName={(r) => cn(r.group ? "bg-surface-sunken/60" : "hover:bg-surface-muted")} />
    </Panel>
  );
}
