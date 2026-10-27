/** Maps API document/entity types to application routes (connected-document navigation). */
const ROUTES: Record<string, string> = {
  "sales-order": "/sales/orders",
  delivery: "/sales/deliveries",
  "sales-invoice": "/sales/invoices",
  "sales-receipt": "/sales/receipts",
  "customer-refund": "/sales/refunds",
  "sales-return": "/sales/returns",
  "purchase-order": "/purchases/orders",
  "goods-received-note": "/purchases/grns",
  "purchase-bill": "/purchases/bills",
  "payment-voucher": "/purchases/payments",
  "supplier-refund": "/purchases/refunds",
  "purchase-return": "/purchases/returns",
  expense: "/finance/expenses",
  journal: "/finance/journals",
  "stock-movement": "/inventory/movements",
  "stock-transfer": "/inventory/transfers",
  "stock-count": "/inventory/counts",
  customer: "/contacts/customers",
  supplier: "/contacts/suppliers",
  product: "/inventory/products",
  account: "/finance/accounts",
  // Ledger "source_link" values use the API resource names.
  "sales-invoices": "/sales/invoices",
  "sales-receipts": "/sales/receipts",
  "customer-refunds": "/sales/refunds",
  "sales-returns": "/sales/returns",
  deliveries: "/sales/deliveries",
  "goods-received-notes": "/purchases/grns",
  "purchase-bills": "/purchases/bills",
  "payment-vouchers": "/purchases/payments",
  "supplier-refunds": "/purchases/refunds",
  "purchase-returns": "/purchases/returns",
  expenses: "/finance/expenses",
  "stock-movements": "/inventory/movements",
  "stock-counts": "/inventory/counts",
  customers: "/contacts/customers",
  suppliers: "/contacts/suppliers",
  products: "/inventory/products",
  accounts: "/finance/accounts",
};

export function linkFor(type: string | null | undefined, id: number | string | null | undefined): string | null {
  if (!type || id === null || id === undefined) return null;
  const base = ROUTES[type];
  return base ? `${base}/${id}` : null;
}

export const TYPE_LABELS: Record<string, string> = {
  "sales-order": "Sales order", delivery: "Delivery", "sales-invoice": "Invoice", "sales-receipt": "Receipt", "customer-refund": "Refund",
  "sales-return": "Credit note", "purchase-order": "Purchase order", "goods-received-note": "GRN", "purchase-bill": "Supplier bill",
  "payment-voucher": "Payment voucher", "supplier-refund": "Supplier refund", "purchase-return": "Debit note", expense: "Expense",
  journal: "Journal", "stock-movement": "Stock movement", "stock-transfer": "Stock transfer", "stock-count": "Stock count", customer: "Customer", supplier: "Supplier", product: "Product",
};
