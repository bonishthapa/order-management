from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.accounting.views import AccountViewSet, BankReconciliationViewSet, JournalViewSet
from apps.audit.views import AuditEventViewSet
from apps.calendar_utils import views as calendar_views
from apps.core.attachments import AttachmentViewSet
from apps.core.search import global_search
from apps.customers.views import CustomerCategoryViewSet, CustomerViewSet
from apps.expenses.views import ExpenseCategoryViewSet, ExpenseViewSet
from apps.fiscal_years.views import AccountingPeriodViewSet, FiscalYearViewSet
from apps.inventory.views import (
    BatchViewSet,
    ReservationViewSet,
    SerialViewSet,
    StockBalanceViewSet,
    StockCountViewSet,
    StockLedgerViewSet,
    StockMovementViewSet,
    StockTransferViewSet,
    WarehouseViewSet,
)
from apps.organizations import views as org_views
from apps.payments.views import (
    CustomerReceiptViewSet,
    CustomerRefundViewSet,
    PaymentVoucherViewSet,
    SupplierRefundViewSet,
)
from apps.products.views import BrandViewSet, ProductCategoryViewSet, ProductViewSet
from apps.purchases.views import GoodsReceiptViewSet, PurchaseOrderViewSet, PurchaseReturnViewSet, SupplierBillViewSet
from apps.sales.views import DeliveryViewSet, SalesInvoiceViewSet, SalesOrderViewSet, SalesReturnViewSet
from apps.suppliers.views import SupplierCategoryViewSet, SupplierViewSet
from apps.users.views import MemberViewSet

router = DefaultRouter()
router.register("users", MemberViewSet, basename="member")
router.register("branches", org_views.BranchViewSet, basename="branch")
router.register("tax-rates", org_views.TaxRateViewSet, basename="tax-rate")
router.register("units", org_views.UnitViewSet, basename="unit")
router.register("payment-methods", org_views.PaymentMethodViewSet, basename="payment-method")
router.register("numbering-policies", org_views.NumberingPolicyViewSet, basename="numbering-policy")
router.register("fiscal-years", FiscalYearViewSet, basename="fiscal-year")
router.register("accounting-periods", AccountingPeriodViewSet, basename="accounting-period")
router.register("customer-categories", CustomerCategoryViewSet, basename="customer-category")
router.register("customers", CustomerViewSet, basename="customer")
router.register("supplier-categories", SupplierCategoryViewSet, basename="supplier-category")
router.register("suppliers", SupplierViewSet, basename="supplier")
router.register("product-categories", ProductCategoryViewSet, basename="product-category")
router.register("brands", BrandViewSet, basename="brand")
router.register("products", ProductViewSet, basename="product")
router.register("warehouses", WarehouseViewSet, basename="warehouse")
router.register("inventory/balances", StockBalanceViewSet, basename="stock-balance")
router.register("inventory/ledger", StockLedgerViewSet, basename="stock-ledger")
router.register("inventory/batches", BatchViewSet, basename="batch")
router.register("inventory/serials", SerialViewSet, basename="serial")
router.register("inventory/reservations", ReservationViewSet, basename="reservation")
router.register("stock-movements", StockMovementViewSet, basename="stock-movement")
router.register("stock-transfers", StockTransferViewSet, basename="stock-transfer")
router.register("stock-counts", StockCountViewSet, basename="stock-count")
router.register("sales-orders", SalesOrderViewSet, basename="sales-order")
router.register("deliveries", DeliveryViewSet, basename="delivery")
router.register("sales-invoices", SalesInvoiceViewSet, basename="sales-invoice")
router.register("sales-receipts", CustomerReceiptViewSet, basename="sales-receipt")
router.register("customer-refunds", CustomerRefundViewSet, basename="customer-refund")
router.register("sales-returns", SalesReturnViewSet, basename="sales-return")
router.register("purchase-orders", PurchaseOrderViewSet, basename="purchase-order")
router.register("goods-received-notes", GoodsReceiptViewSet, basename="goods-received-note")
router.register("purchase-bills", SupplierBillViewSet, basename="purchase-bill")
router.register("payment-vouchers", PaymentVoucherViewSet, basename="payment-voucher")
router.register("supplier-refunds", SupplierRefundViewSet, basename="supplier-refund")
router.register("purchase-returns", PurchaseReturnViewSet, basename="purchase-return")
router.register("expense-categories", ExpenseCategoryViewSet, basename="expense-category")
router.register("expenses", ExpenseViewSet, basename="expense")
router.register("accounts", AccountViewSet, basename="account")
router.register("journals", JournalViewSet, basename="journal")
router.register("bank-reconciliations", BankReconciliationViewSet, basename="bank-reconciliation")
router.register("audit-logs", AuditEventViewSet, basename="audit-log")
router.register("attachments", AttachmentViewSet, basename="attachment")

urlpatterns = [
    path("auth/", include("apps.users.urls")),
    path("organizations/current/", org_views.current_organization, name="organization-current"),
    path("calendar/convert/", calendar_views.convert, name="calendar-convert"),
    path("calendar/meta/", calendar_views.meta, name="calendar-meta"),
    path("calendar/bs-month/", calendar_views.bs_month, name="calendar-bs-month"),
    path("reports/", include("apps.reports.urls")),
    path("search/", global_search, name="global-search"),
    path("", include(router.urls)),
]
