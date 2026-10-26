import { Bell, Building2, Check, ChevronDown, LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Search, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useFiscalYear } from "@/app/FiscalYearContext";
import { useAuth } from "@/auth/AuthContext";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { useDebounce } from "@/hooks/useDebounce";
import { useStoredState } from "@/hooks/useStoredState";
import { cn } from "@/utils/cn";
import { formatAmount } from "@/utils/format";
import { linkFor, TYPE_LABELS } from "@/utils/links";
import type { DateDisplayMode } from "@/api/types";
import { NAV } from "./nav";

export function AppLayout() {
  const { can } = useAuth();
  const [collapsed, setCollapsed] = useStoredState("erp.sidebar.collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const groups = useMemo(() => NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm)) })).filter((g) => g.items.length), [can]);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3", collapsed && "lg:justify-center lg:px-0")}>
        <div className="flex h-7 w-7 items-center justify-center rounded bg-white/10 text-sm font-bold text-white">T</div>
        <span className={cn("text-sm font-semibold tracking-wide text-white", collapsed && "lg:hidden")}>Trade ERP</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-2">
            <div className={cn("px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400", collapsed && "lg:hidden")}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === "/"} title={collapsed ? item.label : undefined}
                className={({ isActive }) => cn(
                  "mx-2 flex items-center gap-2.5 rounded px-2 py-1.5 text-[13px] text-slate-300 hover:bg-white/5 hover:text-white",
                  isActive && !item.to.includes("?") && "bg-white/10 font-medium text-white",
                  collapsed && "lg:justify-center",
                )}>
                <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                <span className={cn("truncate", collapsed && "lg:hidden")}>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setCollapsed(!collapsed)}
        className="hidden h-10 items-center gap-2 border-t border-white/10 px-4 text-xs text-slate-400 hover:text-white lg:flex">
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> Collapse</>}
      </button>
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={cn("hidden shrink-0 bg-[#1b2838] lg:block", collapsed ? "w-14" : "w-56")}>{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-[#1b2838]">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1600px] px-4 py-4 lg:px-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  sales: "Sales", purchases: "Purchases", inventory: "Inventory", contacts: "Contacts", finance: "Finance", reports: "Reports",
  admin: "Administration", audit: "Audit trail",
};

function Breadcrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split("/").filter(Boolean);
  if (!parts.length) return <span className="text-[13px] font-medium text-slate-700">Dashboard</span>;
  const item = NAV.flatMap((g) => g.items).find((i) => pathname.startsWith(i.to) && i.to !== "/");
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] text-slate-500">
      <span className="hidden sm:inline">{SECTION_LABELS[parts[0]] ?? parts[0]}</span>
      {item && <><span className="hidden text-slate-300 sm:inline">/</span><Link to={item.to} className="truncate font-medium text-slate-700 hover:text-brand-700">{item.label}</Link></>}
    </nav>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounce(q, 250);
  const ref = useRef<HTMLInputElement>(null);
  const results = useQuery({
    queryKey: ["search", debounced],
    queryFn: async () => (await api.get<{ type: string; id: number; title: string; subtitle: string }[]>("/search/", { params: { q: debounced } })).data,
    enabled: debounced.length >= 2,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const items = results.data ?? [];
  const go = (i: number) => {
    const target = items[i];
    const to = target && linkFor(target.type, target.id);
    if (to) { navigate(to); setQ(""); setOpen(false); ref.current?.blur(); }
  };
  return (
    <div className="relative hidden w-72 md:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input ref={ref} value={q} placeholder="Search customers, products, documents…" aria-label="Global search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter") go(active);
          if (e.key === "Escape") { setOpen(false); ref.current?.blur(); }
        }}
        className="h-8 w-full rounded border border-line bg-surface-muted pl-8 pr-12 text-[13px] outline-none focus:border-brand-500 focus:bg-white" />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line px-1 text-2xs text-slate-400">Ctrl K</kbd>
      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-9 z-50 max-h-96 overflow-y-auto rounded-md border border-line bg-white p-1 shadow-pop">
          {results.isLoading && <div className="px-2 py-3 text-xs text-slate-500">Searching…</div>}
          {!results.isLoading && items.length === 0 && <div className="px-2 py-3 text-xs text-slate-500">No matches for “{debounced}”.</div>}
          {items.map((item, i) => (
            <button key={`${item.type}-${item.id}`} type="button" onMouseDown={() => go(i)} onMouseEnter={() => setActive(i)}
              className={cn("flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[13px]", i === active && "bg-surface-sunken")}>
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-800">{item.title}</span>
                <span className="block truncate text-2xs text-slate-500">{item.subtitle}</span>
              </span>
              <span className="shrink-0 text-2xs text-slate-400">{TYPE_LABELS[item.type] ?? item.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Approval { type: string; id: number; number: string; party: string; amount: string; date: string }

function Notifications() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["dashboard", "notifications"],
    queryFn: async () => (await api.get<{ approvals: Approval[]; sales?: { overdue_count: number }; inventory?: { low_stock_count: number } }>("/reports/dashboard/")).data,
    refetchInterval: 120_000,
  });
  const approvals = data?.approvals ?? [];
  const overdue = data?.sales?.overdue_count ?? 0;
  const lowStock = data?.inventory?.low_stock_count ?? 0;
  const count = approvals.length + (overdue ? 1 : 0) + (lowStock ? 1 : 0);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={`Notifications (${count})`} className="relative rounded p-1.5 text-slate-500 hover:bg-surface-sunken hover:text-slate-800">
          <Bell className="h-4 w-4" />
          {count > 0 && <span className="absolute right-0.5 top-0.5 min-w-[14px] rounded-full bg-red-600 px-1 text-[9px] font-semibold leading-[14px] text-white">{count}</span>}
        </button>
      </MenuTrigger>
      <MenuContent className="w-80">
        <MenuLabel>Needs attention</MenuLabel>
        {count === 0 && <div className="px-2 py-3 text-xs text-slate-500">Nothing waiting for you.</div>}
        {approvals.map((a) => (
          <MenuItem key={`${a.type}-${a.id}`} onSelect={() => navigate(linkFor(a.type, a.id) ?? "/")}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{TYPE_LABELS[a.type]} {a.number} awaiting approval</span>
              <span className="block truncate text-2xs text-slate-500">{a.party} · {formatAmount(a.amount)}</span>
            </span>
          </MenuItem>
        ))}
        {overdue > 0 && <MenuItem onSelect={() => navigate("/sales/invoices?overdue=true")}>{overdue} overdue invoice{overdue > 1 ? "s" : ""}</MenuItem>}
        {lowStock > 0 && <MenuItem onSelect={() => navigate("/inventory/products?low_stock=true")}>{lowStock} product{lowStock > 1 ? "s" : ""} at or below reorder level</MenuItem>}
      </MenuContent>
    </Menu>
  );
}

const MODES: { value: DateDisplayMode; label: string }[] = [
  { value: "AD_BS", label: "AD + BS" }, { value: "BS", label: "BS" }, { value: "AD", label: "AD" },
];

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { session, logout, switchOrganization, dateMode, setDateMode } = useAuth();
  const { years, selected, setSelectedId } = useFiscalYear();
  const navigate = useNavigate();
  const user = session!.user;
  const org = session!.organization!;
  return (
    <header className="no-print flex h-12 shrink-0 items-center gap-3 border-b border-line bg-white px-3 lg:px-4">
      <button type="button" className="rounded p-1.5 text-slate-500 hover:bg-surface-sunken lg:hidden" aria-label="Open menu" onClick={onMenu}>
        <MenuIcon className="h-4 w-4" />
      </button>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-1.5">
        <GlobalSearch />
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="hidden items-center gap-1 rounded border border-line px-2 py-1 text-xs text-slate-600 hover:bg-surface-muted sm:flex" title="Fiscal year used by reports and lists">
              FY {selected?.name ?? "–"} <ChevronDown className="h-3 w-3" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Fiscal year</MenuLabel>
            {years.map((fy) => (
              <MenuItem key={fy.id} onSelect={() => setSelectedId(fy.id)} icon={fy.id === selected?.id ? <Check className="h-3.5 w-3.5" /> : <span className="w-3.5" />}>
                {fy.name} <span className="ml-auto text-2xs text-slate-400">{fy.status_label}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="hidden items-center gap-1 rounded border border-line px-2 py-1 text-xs text-slate-600 hover:bg-surface-muted sm:flex" title="Date display">
              {MODES.find((m) => m.value === dateMode)?.label} <ChevronDown className="h-3 w-3" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Show dates in</MenuLabel>
            {MODES.map((m) => (
              <MenuItem key={m.value} onSelect={() => setDateMode(m.value)} icon={m.value === dateMode ? <Check className="h-3.5 w-3.5" /> : <span className="w-3.5" />}>{m.label}</MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Notifications />
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-sunken">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                {user.full_name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
              </span>
              <span className="hidden text-left leading-tight xl:block">
                <span className="block text-xs font-medium text-slate-700">{user.full_name}</span>
                <span className="block text-2xs text-slate-500">{org.name}</span>
              </span>
            </button>
          </MenuTrigger>
          <MenuContent className="w-64">
            <MenuLabel>{user.email}</MenuLabel>
            <MenuItem icon={<UserRound className="h-3.5 w-3.5" />} onSelect={() => navigate("/account")}>My account</MenuItem>
            {user.memberships.length > 1 && (
              <>
                <MenuSeparator />
                <MenuLabel>Organisation</MenuLabel>
                {user.memberships.map((m) => (
                  <MenuItem key={m.organization} icon={<Building2 className="h-3.5 w-3.5" />}
                    onSelect={() => m.organization !== org.id && switchOrganization(m.organization).then(() => navigate("/"))}>
                    <span className="flex-1 truncate">{m.organization_name}</span>
                    {m.organization === org.id && <Check className="h-3.5 w-3.5 text-brand-600" />}
                  </MenuItem>
                ))}
              </>
            )}
            <MenuSeparator />
            <MenuItem icon={<LogOut className="h-3.5 w-3.5" />} onSelect={() => logout()}>Sign out</MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}
