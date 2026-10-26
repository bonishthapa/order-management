import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { EmptyState } from "@/components/ui/Feedback";

const page = <T,>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as React.ComponentType })));

const sales = () => import("@/features/sales/SalesOrders");
const SalesOrderList = page(sales, "SalesOrderList");
const SalesOrderForm = page(sales, "SalesOrderForm");
const SalesOrderDetail = page(sales, "SalesOrderDetail");

export function AppRoutes() {
  return (
    <Routes>
      <Route path="sales/orders" element={<SalesOrderList />} />
      <Route path="sales/orders/new" element={<SalesOrderForm />} />
      <Route path="sales/orders/:id" element={<SalesOrderDetail />} />
      <Route path="sales/orders/:id/edit" element={<SalesOrderForm />} />
      <Route path="" element={<Navigate to="/sales/orders" replace />} />
      <Route path="*" element={<EmptyState title="Page not found" description="The address may be mistyped, or the page has moved." />} />
    </Routes>
  );
}
