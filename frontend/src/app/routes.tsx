import { lazy } from "react";
import { Route, Routes } from "react-router-dom";
import { EmptyState } from "@/components/ui/Feedback";

const page = <T,>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as React.ComponentType })));

const dashboard = () => import("@/features/dashboard/Dashboard");
const salesOrders = () => import("@/features/sales/SalesOrders");
const deliveries = () => import("@/features/sales/Deliveries");
const invoices = () => import("@/features/sales/Invoices");
const receipts = () => import("@/features/sales/Receipts");
const salesReturns = () => import("@/features/sales/SalesReturns");
const reports = () => import("@/features/reports/Reports");
const audit = () => import("@/features/reports/AuditTrail");
const account = () => import("@/features/account/AccountPage");
const customers = () => import("@/features/contacts/Customers");
const suppliers = () => import("@/features/contacts/Suppliers");
const expenses = () => import("@/features/finance/Expenses");
const cashBank = () => import("@/features/finance/CashBank");
const accounts = () => import("@/features/finance/Accounts");
const ledgers = () => import("@/features/finance/Ledgers");
const journals = () => import("@/features/finance/Journals");
const adminUsers = () => import("@/features/admin/Users");
const adminCompany = () => import("@/features/admin/Company");
const adminFy = () => import("@/features/admin/FiscalYears");
const adminPeriods = () => import("@/features/admin/Periods");
const adminNumbering = () => import("@/features/admin/Numbering");
const adminCalendar = () => import("@/features/admin/Calendar");
const adminMasters = () => import("@/features/admin/Masters");
const products = () => import("@/features/inventory/Products");
const catalog = () => import("@/features/inventory/Catalog");
const warehouses = () => import("@/features/inventory/Warehouses");
const stock = () => import("@/features/inventory/Stock");
const movements = () => import("@/features/inventory/Movements");
const transfers = () => import("@/features/inventory/Transfers");
const counts = () => import("@/features/inventory/Counts");
const purchaseOrders = () => import("@/features/purchases/PurchaseOrders");
const grns = () => import("@/features/purchases/GoodsReceipts");
const bills = () => import("@/features/purchases/SupplierBills");
const payments = () => import("@/features/purchases/SupplierPayments");
const purchaseReturns = () => import("@/features/purchases/PurchaseReturns");

const ROUTES: [string, React.LazyExoticComponent<React.ComponentType>][] = [
  ["", page(dashboard, "Dashboard")],
  ["sales/orders", page(salesOrders, "SalesOrderList")],
  ["sales/orders/new", page(salesOrders, "SalesOrderForm")],
  ["sales/orders/:id", page(salesOrders, "SalesOrderDetail")],
  ["sales/orders/:id/edit", page(salesOrders, "SalesOrderForm")],
  ["sales/deliveries", page(deliveries, "DeliveryList")],
  ["sales/deliveries/:id", page(deliveries, "DeliveryDetail")],
  ["sales/invoices", page(invoices, "InvoiceList")],
  ["sales/invoices/new", page(invoices, "InvoiceForm")],
  ["sales/invoices/:id", page(invoices, "InvoiceDetail")],
  ["sales/invoices/:id/edit", page(invoices, "InvoiceForm")],
  ["sales/receipts", page(receipts, "ReceiptList")],
  ["sales/receipts/new", page(receipts, "ReceiptForm")],
  ["sales/receipts/:id", page(receipts, "ReceiptDetail")],
  ["sales/refunds", page(receipts, "RefundList")],
  ["sales/refunds/:id", page(receipts, "RefundDetail")],
  ["sales/returns", page(salesReturns, "SalesReturnList")],
  ["sales/returns/new", page(salesReturns, "SalesReturnForm")],
  ["sales/returns/:id", page(salesReturns, "SalesReturnDetail")],
  ["purchases/orders", page(purchaseOrders, "PurchaseOrderList")],
  ["purchases/orders/new", page(purchaseOrders, "PurchaseOrderForm")],
  ["purchases/orders/:id", page(purchaseOrders, "PurchaseOrderDetail")],
  ["purchases/orders/:id/edit", page(purchaseOrders, "PurchaseOrderForm")],
  ["purchases/grns", page(grns, "GoodsReceiptList")],
  ["purchases/grns/:id", page(grns, "GoodsReceiptDetail")],
  ["purchases/bills", page(bills, "SupplierBillList")],
  ["purchases/bills/new", page(bills, "SupplierBillForm")],
  ["purchases/bills/:id", page(bills, "SupplierBillDetail")],
  ["purchases/bills/:id/edit", page(bills, "SupplierBillForm")],
  ["purchases/payments", page(payments, "PaymentVoucherList")],
  ["purchases/payments/new", page(payments, "PaymentVoucherForm")],
  ["purchases/payments/:id", page(payments, "PaymentVoucherDetail")],
  ["purchases/payments/:id/edit", page(payments, "PaymentVoucherForm")],
  ["purchases/refunds", page(payments, "SupplierRefundList")],
  ["purchases/refunds/:id", page(payments, "SupplierRefundDetail")],
  ["purchases/returns", page(purchaseReturns, "PurchaseReturnList")],
  ["purchases/returns/new", page(purchaseReturns, "PurchaseReturnForm")],
  ["purchases/returns/:id", page(purchaseReturns, "PurchaseReturnDetail")],
  ["contacts/customers", page(customers, "CustomerList")],
  ["contacts/customers/new", page(customers, "CustomerForm")],
  ["contacts/customers/:id", page(customers, "CustomerDetail")],
  ["contacts/customers/:id/edit", page(customers, "CustomerForm")],
  ["contacts/suppliers", page(suppliers, "SupplierList")],
  ["contacts/suppliers/new", page(suppliers, "SupplierForm")],
  ["contacts/suppliers/:id", page(suppliers, "SupplierDetail")],
  ["contacts/suppliers/:id/edit", page(suppliers, "SupplierForm")],
  ["finance/expenses", page(expenses, "ExpenseList")],
  ["finance/expenses/new", page(expenses, "ExpenseForm")],
  ["finance/expenses/:id", page(expenses, "ExpenseDetail")],
  ["finance/expenses/:id/edit", page(expenses, "ExpenseForm")],
  ["finance/journals", page(journals, "JournalList")],
  ["finance/journals/new", page(journals, "JournalForm")],
  ["finance/journals/:id", page(journals, "JournalDetail")],
  ["finance/journals/:id/edit", page(journals, "JournalForm")],
  ["finance/cash-bank", page(cashBank, "CashBankPage")],
  ["finance/reconciliation", page(cashBank, "ReconciliationPage")],
  ["finance/accounts", page(accounts, "AccountsPage")],
  ["finance/accounts/:id", page(ledgers, "LedgerPage")],
  ["finance/ledgers", page(ledgers, "LedgerPage")],
  ["admin/users", page(adminUsers, "UsersPage")],
  ["admin/company", page(adminCompany, "CompanySettingsPage")],
  ["admin/fiscal-years", page(adminFy, "FiscalYearList")],
  ["admin/fiscal-years/new", page(adminFy, "FiscalYearForm")],
  ["admin/fiscal-years/:id", page(adminFy, "FiscalYearDetail")],
  ["admin/fiscal-years/:id/edit", page(adminFy, "FiscalYearForm")],
  ["admin/periods", page(adminPeriods, "PeriodsPage")],
  ["admin/numbering", page(adminNumbering, "NumberingPage")],
  ["admin/calendar", page(adminCalendar, "CalendarPreferencesPage")],
  ["admin/masters", page(adminMasters, "MastersPage")],
  ["inventory/products", page(products, "ProductList")],
  ["inventory/products/new", page(products, "ProductForm")],
  ["inventory/products/:id", page(products, "ProductDetail")],
  ["inventory/products/:id/edit", page(products, "ProductForm")],
  ["inventory/categories", page(catalog, "CategoriesPage")],
  ["inventory/warehouses", page(warehouses, "WarehousesPage")],
  ["inventory/stock", page(stock, "StockOnHandPage")],
  ["inventory/ledger", page(stock, "StockLedgerPage")],
  ["inventory/movements", page(movements, "MovementList")],
  ["inventory/movements/new", page(movements, "MovementForm")],
  ["inventory/movements/:id", page(movements, "MovementDetail")],
  ["inventory/movements/:id/edit", page(movements, "MovementForm")],
  ["inventory/transfers", page(transfers, "TransferList")],
  ["inventory/transfers/new", page(transfers, "TransferForm")],
  ["inventory/transfers/:id", page(transfers, "TransferDetail")],
  ["inventory/transfers/:id/edit", page(transfers, "TransferForm")],
  ["inventory/counts", page(counts, "CountList")],
  ["inventory/counts/new", page(counts, "CountForm")],
  ["inventory/counts/:id", page(counts, "CountDetail")],
  ["reports", page(reports, "ReportsIndex")],
  ["reports/:slug", page(reports, "ReportViewer")],
  ["audit", page(audit, "AuditTrail")],
  ["account", page(account, "AccountPage")],
];

export function AppRoutes() {
  return (
    <Routes>
      {ROUTES.map(([path, Component]) => <Route key={path} path={path} element={<Component />} />)}
      <Route path="*" element={<EmptyState title="Page not found" description="The address may be mistyped, or the page has moved." />} />
    </Routes>
  );
}
