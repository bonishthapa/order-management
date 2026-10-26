import {
  ArrowLeftRight, BarChart3, BookOpen, Boxes, CalendarRange, ClipboardCheck, ClipboardList, Coins, FileCheck2, FileClock, FileInput,
  FileOutput, FileSpreadsheet, FileText, Hash, Landmark, LayoutDashboard, Library, LockKeyhole, type LucideIcon, Package, PackageCheck,
  ReceiptText, RotateCcw, Scale, Settings, ShieldCheck, ShoppingCart, Tags, Truck, Undo2, Users, Wallet, Warehouse, CalendarDays,
} from "lucide-react";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  perm: string | string[];
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { label: "Overview", items: [{ label: "Dashboard", to: "/", icon: LayoutDashboard, perm: "dashboard.view" }] },
  {
    label: "Sales",
    items: [
      { label: "Sales Orders", to: "/sales/orders", icon: ShoppingCart, perm: "sales.view" },
      { label: "Deliveries", to: "/sales/deliveries", icon: Truck, perm: "sales.view" },
      { label: "Invoices", to: "/sales/invoices", icon: FileText, perm: "sales.view" },
      { label: "Customer Receipts", to: "/sales/receipts", icon: ReceiptText, perm: "sales.view" },
      { label: "Sales Returns", to: "/sales/returns", icon: Undo2, perm: "sales.view" },
    ],
  },
  {
    label: "Purchases",
    items: [
      { label: "Purchase Orders", to: "/purchases/orders", icon: ClipboardList, perm: "purchases.view" },
      { label: "Goods Received", to: "/purchases/grns", icon: PackageCheck, perm: "purchases.view" },
      { label: "Supplier Bills", to: "/purchases/bills", icon: FileInput, perm: "purchases.view" },
      { label: "Supplier Payments", to: "/purchases/payments", icon: Wallet, perm: "purchases.view" },
      { label: "Purchase Returns", to: "/purchases/returns", icon: RotateCcw, perm: "purchases.view" },
    ],
  },
  {
    label: "Inventory",
    items: [
      { label: "Products", to: "/inventory/products", icon: Package, perm: "products.view" },
      { label: "Stock on Hand", to: "/inventory/stock", icon: Boxes, perm: "inventory.view" },
      { label: "Categories", to: "/inventory/categories", icon: Tags, perm: "products.view" },
      { label: "Warehouses", to: "/inventory/warehouses", icon: Warehouse, perm: "inventory.view" },
      { label: "Stock Movements", to: "/inventory/movements", icon: FileOutput, perm: "inventory.view" },
      { label: "Transfers", to: "/inventory/transfers", icon: ArrowLeftRight, perm: "inventory.view" },
      { label: "Stock Counts", to: "/inventory/counts", icon: ClipboardCheck, perm: "inventory.view" },
    ],
  },
  {
    label: "Contacts",
    items: [
      { label: "Customers", to: "/contacts/customers", icon: Users, perm: "customers.view" },
      { label: "Suppliers", to: "/contacts/suppliers", icon: Truck, perm: "suppliers.view" },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Expenses", to: "/finance/expenses", icon: Coins, perm: "expenses.view" },
      { label: "Cash and Bank", to: "/finance/cash-bank", icon: Landmark, perm: "accounting.view" },
      { label: "Chart of Accounts", to: "/finance/accounts", icon: Library, perm: "accounting.view" },
      { label: "Journals", to: "/finance/journals", icon: BookOpen, perm: "accounting.view" },
      { label: "Ledgers", to: "/finance/ledgers", icon: FileSpreadsheet, perm: "accounting.view" },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "Sales Reports", to: "/reports?group=Sales", icon: BarChart3, perm: "reports.sales" },
      { label: "Purchase Reports", to: "/reports?group=Purchases", icon: BarChart3, perm: "reports.purchases" },
      { label: "Inventory Reports", to: "/reports?group=Inventory", icon: BarChart3, perm: "reports.inventory" },
      { label: "Financial Reports", to: "/reports?group=Financial", icon: Scale, perm: "reports.financial" },
      { label: "Audit Trail", to: "/audit", icon: FileClock, perm: "audit.view" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Users and Permissions", to: "/admin/users", icon: ShieldCheck, perm: "users.manage" },
      { label: "Company Settings", to: "/admin/company", icon: Settings, perm: "settings.view" },
      { label: "Fiscal Years", to: "/admin/fiscal-years", icon: CalendarRange, perm: "fiscal.view" },
      { label: "Accounting Periods", to: "/admin/periods", icon: LockKeyhole, perm: "fiscal.view" },
      { label: "Document Numbering", to: "/admin/numbering", icon: Hash, perm: "settings.view" },
      { label: "Calendar Preferences", to: "/admin/calendar", icon: CalendarDays, perm: "dashboard.view" },
      { label: "Master Lists", to: "/admin/masters", icon: FileCheck2, perm: "settings.view" },
    ],
  },
];
