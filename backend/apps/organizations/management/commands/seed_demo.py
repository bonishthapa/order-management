"""Demo data generated through the real posting services (no direct ledger or stock writes).

    python manage.py seed_demo [--password Demo@12345] [--seed 2083]

Creates "Himalayan Trade Links Pvt. Ltd." with one user per role, fiscal years 2082/83 and
2083/84 BS, masters, opening balances and about 15 months of orders, deliveries, invoices,
receipts, purchases, payments, expenses, transfers, counts and returns up to yesterday.
"""
import datetime as dt
import random
from decimal import Decimal

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.accounting.models import Account, JournalEntry, JournalLine, JournalSource, SystemAccount
from apps.accounting.opening import post_customer_opening_balance, post_supplier_opening_balance
from apps.accounting.services import post_draft_journal
from apps.calendar_utils.bs import bs_to_ad
from apps.customers.models import Customer, CustomerCategory
from apps.expenses import services as expense_services
from apps.expenses.models import Expense, ExpenseCategory
from apps.fiscal_years import services as fy_services
from apps.inventory import services as stock
from apps.inventory.models import MovementType, StockBalance, StockCount, StockCountLine, StockMovement, StockMovementLine, StockTransfer, StockTransferLine, Warehouse
from apps.organizations.models import Branch, Organization, PaymentMethod, TaxRate, UnitOfMeasure
from apps.organizations.setup import bootstrap_organization
from apps.payments import services as pay
from apps.payments.models import PaymentVoucher
from apps.products.models import Brand, PriceTier, Product, ProductCategory
from apps.purchases import services as purchase_services
from apps.purchases.models import GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine, PurchaseReturn, PurchaseReturnLine, SupplierBill, SupplierBillLine
from apps.sales import services as sales_services
from apps.sales.models import Delivery, DeliveryLine, SalesInvoice, SalesInvoiceLine, SalesOrder, SalesOrderLine, SalesReturn, SalesReturnLine
from apps.suppliers.models import Supplier, SupplierCategory
from apps.users.models import Membership, User
from apps.users.roles import Role
from apps.core.numbering import next_number
from apps.core.money import money

D = Decimal
ORG_CODE = "himalayan"

USERS = [
    ("admin@demo.erp", "Sushil Shrestha", Role.COMPANY_ADMIN),
    ("manager@demo.erp", "Anita Gurung", Role.MANAGER),
    ("sales@demo.erp", "Rajesh Maharjan", Role.SALES),
    ("purchase@demo.erp", "Prakash Thapa", Role.PURCHASE),
    ("warehouse@demo.erp", "Bikash Tamang", Role.WAREHOUSE),
    ("accounts@demo.erp", "Sarita Koirala", Role.ACCOUNTANT),
    ("auditor@demo.erp", "Deepak Joshi", Role.AUDITOR),
]

CUSTOMERS = [
    ("Bhatbhateni Retail Pvt. Ltd.", "Retail chains", "Naxal, Kathmandu", 2500000, 30),
    ("Sagarmatha Distributors", "Distributors", "Biratnagar-8, Morang", 1500000, 45),
    ("Pokhara Hardware Centre", "Retailers", "New Road, Pokhara", 600000, 30),
    ("Lumbini Traders", "Retailers", "Butwal-11, Rupandehi", 500000, 30),
    ("Everest Builders Pvt. Ltd.", "Contractors", "Baneshwor, Kathmandu", 3000000, 60),
    ("Janakpur Kirana Pasal", "Retailers", "Janakpurdham-4, Dhanusha", 250000, 15),
    ("Annapurna Hotels Group", "Hospitality", "Lakeside, Pokhara", 900000, 30),
    ("Chitwan Agro Mart", "Retailers", "Bharatpur-10, Chitwan", 400000, 30),
    ("Kathmandu Valley Mart", "Retail chains", "Lalitpur-3, Lalitpur", 1200000, 30),
    ("Nepalgunj Wholesale House", "Distributors", "Nepalgunj-1, Banke", 800000, 45),
    ("Dhulikhel Hospital Stores", "Institutions", "Dhulikhel, Kavre", 700000, 45),
    ("Karnali Supply Co.", "Distributors", "Birendranagar, Surkhet", 450000, 30),
]

SUPPLIERS = [
    ("Asian Paints Nepal Pvt. Ltd.", "Manufacturers", "Hetauda Industrial Area, Makwanpur", 45),
    ("Hulas Steel Industries", "Manufacturers", "Simara, Bara", 30),
    ("Jagadamba Wires Ltd.", "Manufacturers", "Biratnagar, Morang", 30),
    ("Shree Electricals Suppliers", "Importers", "Teku, Kathmandu", 30),
    ("Himal Plastic Industries", "Manufacturers", "Balaju Industrial District, Kathmandu", 45),
    ("Kathmandu Tools Traders", "Importers", "Bishal Bazar, Kathmandu", 15),
    ("Mahalaxmi Logistics", "Services", "Sinamangal, Kathmandu", 15),
    ("Siddhartha Packaging", "Manufacturers", "Butwal Industrial Area", 30),
]

# (sku, name, category, brand, unit, cost, price, reorder, tracking)
PRODUCTS = [
    ("PNT-EM-20", "Emulsion paint, interior 20 L", "Paints", "Asian Paints", "PCS", 6200, 7450, 20, ""),
    ("PNT-EM-04", "Emulsion paint, interior 4 L", "Paints", "Asian Paints", "PCS", 1380, 1690, 40, ""),
    ("PNT-EX-20", "Weatherproof exterior paint 20 L", "Paints", "Asian Paints", "PCS", 8900, 10600, 15, "batch"),
    ("PNT-PR-10", "Wall primer 10 L", "Paints", "Asian Paints", "PCS", 2150, 2600, 25, "batch"),
    ("PNT-EN-01", "Synthetic enamel 1 L", "Paints", "Asian Paints", "PCS", 520, 640, 60, ""),
    ("STL-TMT-12", "TMT bar 12 mm (per kg)", "Steel", "Hulas", "KG", 98, 112, 2000, ""),
    ("STL-TMT-16", "TMT bar 16 mm (per kg)", "Steel", "Hulas", "KG", 97, 111, 2000, ""),
    ("STL-GI-24", "GI sheet 24 gauge 8 ft", "Steel", "Hulas", "PCS", 1450, 1690, 100, ""),
    ("WIR-CU-15", "Copper wire 1.5 sq mm, 90 m coil", "Electrical", "Jagadamba", "PCS", 2900, 3450, 40, ""),
    ("WIR-CU-25", "Copper wire 2.5 sq mm, 90 m coil", "Electrical", "Jagadamba", "PCS", 4600, 5400, 30, ""),
    ("WIR-CU-40", "Copper wire 4 sq mm, 90 m coil", "Electrical", "Jagadamba", "PCS", 7200, 8350, 20, ""),
    ("ELE-MCB-32", "MCB 32 A single pole", "Electrical", "Havells", "PCS", 310, 395, 100, ""),
    ("ELE-SW-6A", "Modular switch 6 A", "Electrical", "Havells", "PCS", 72, 98, 300, ""),
    ("ELE-LED-18", "LED tube light 18 W", "Electrical", "Philips", "PCS", 360, 465, 150, ""),
    ("ELE-FAN-48", "Ceiling fan 48 inch", "Electrical", "Havells", "PCS", 3400, 4150, 20, "serial"),
    ("PLB-PVC-110", "PVC pipe 110 mm, 3 m", "Plumbing", "Himal Plastic", "PCS", 780, 960, 80, ""),
    ("PLB-PVC-075", "PVC pipe 75 mm, 3 m", "Plumbing", "Himal Plastic", "PCS", 520, 650, 80, ""),
    ("PLB-TNK-1000", "Water tank 1000 L, triple layer", "Plumbing", "Himal Plastic", "PCS", 9800, 11800, 10, ""),
    ("PLB-TAP-CP", "CP bib tap, long body", "Plumbing", "Jaquar", "PCS", 640, 820, 50, ""),
    ("TLS-DRL-13", "Impact drill 13 mm, 650 W", "Tools", "Bosch", "PCS", 4800, 5900, 10, "serial"),
    ("TLS-GRD-04", "Angle grinder 4 inch", "Tools", "Bosch", "PCS", 3900, 4750, 10, ""),
    ("TLS-HAM-500", "Claw hammer 500 g", "Tools", "Stanley", "PCS", 420, 560, 30, ""),
    ("TLS-TAPE-5", "Measuring tape 5 m", "Tools", "Stanley", "PCS", 260, 350, 50, ""),
    ("CEM-OPC-50", "OPC cement 50 kg", "Cement", "Shivam", "PCS", 735, 815, 300, ""),
    ("CEM-PPC-50", "PPC cement 50 kg", "Cement", "Shivam", "PCS", 690, 765, 300, ""),
    ("ADH-TILE-20", "Tile adhesive 20 kg", "Cement", "Fosroc", "PCS", 840, 1050, 60, "batch"),
    ("SRV-INSTALL", "Installation service (per hour)", "Services", "", "HR", 0, 800, 0, "service"),
    ("SRV-DELIV", "Delivery service (per trip)", "Services", "", "PCS", 0, 1500, 0, "service"),
]

WAREHOUSES = [("KTM", "Kathmandu main warehouse", "KTM", "Balaju Industrial District, Kathmandu"),
              ("PKR", "Pokhara depot", "PKR", "Prithvi Chowk, Pokhara"),
              ("BRT", "Biratnagar depot", "BRT", "Rani, Biratnagar")]


class Command(BaseCommand):
    help = "Create a demo organisation with realistic, fully posted transactions."

    def add_arguments(self, parser):
        parser.add_argument("--password", default="Demo@12345")
        parser.add_argument("--seed", type=int, default=2083)

    def handle(self, *args, **opts):
        if Organization.objects.filter(code=ORG_CODE).exists():
            raise CommandError("Demo organisation already exists. Use a fresh database (see docs/deployment.md) to reseed.")
        self.rng = random.Random(opts["seed"])
        self.today = timezone.localdate()
        self.sim_end = self.today - dt.timedelta(days=1)
        with transaction.atomic():
            self.setup_org(opts["password"])
            self.setup_masters()
        fy1_start, fy1_end = bs_to_ad((2082, 4, 1)), bs_to_ad((2083, 4, 1)) - dt.timedelta(days=1)
        fy2_start, fy2_end = bs_to_ad((2083, 4, 1)), bs_to_ad((2084, 4, 1)) - dt.timedelta(days=1)
        self.fy1 = fy_services.create_fiscal_year(self.org, self.admin, name="2082/83", code="2082/83", start_date=fy1_start,
                                                  end_date=fy1_end, period_type="BS_MONTHLY")
        fy_services.activate_fiscal_year(self.fy1, self.admin)
        sim_start = max(fy1_start, self.today - dt.timedelta(days=430))
        self.opening(sim_start)
        self.sim_end = min(fy1_end, self.today - dt.timedelta(days=1))
        self.simulate(sim_start, self.sim_end)
        if self.today > fy2_start:
            self.fy2 = fy_services.create_fiscal_year(self.org, self.admin, name="2083/84", code="2083/84", start_date=fy2_start,
                                                      end_date=fy2_end, period_type="BS_MONTHLY")
            fy_services.activate_fiscal_year(self.fy2, self.admin)
            for period in self.fy1.periods.filter(end_date__lt=fy1_end - dt.timedelta(days=60)):
                fy_services.lock_period(period, self.admin, "Month-end close")
            self.sim_end = self.today - dt.timedelta(days=1)
            self.simulate(fy2_start, self.sim_end)
        self.open_items()
        problems = stock.verify_balances(self.org)
        if problems:
            raise CommandError(f"Stock balances do not reconcile: {problems[:3]}")
        self.stdout.write(self.style.SUCCESS(
            f"Demo organisation '{self.org.name}' ready. Sign in as admin@demo.erp (or sales@, purchase@, warehouse@, accounts@, "
            f"manager@, auditor@) with password {opts['password']}"))

    # --- setup ---------------------------------------------------------------------------------

    def clamp(self, date):
        return min(date, self.sim_end)

    def setup_org(self, password):
        self.org = bootstrap_organization(Organization.objects.create(
            name="Himalayan Trade Links", legal_name="Himalayan Trade Links Pvt. Ltd.", code=ORG_CODE,
            address="Balaju Industrial District, Ward 16", city="Kathmandu", email="accounts@himalayantrade.com.np",
            phone="01-4350123", tax_id="609876543", website="himalayantrade.com.np",
            terms_and_conditions="1. Goods once sold are returnable within 7 days with the original invoice.\n"
                                 "2. Interest at 1.5% per month may be charged on overdue balances.\n"
                                 "3. Subject to Kathmandu jurisdiction.",
            document_footer="Himalayan Trade Links Pvt. Ltd. · Thank you for your business",
        ))
        self.users = {}
        for email, name, role in USERS:
            user = User.objects.create_user(email, password, full_name=name, default_organization=self.org)
            Membership.objects.create(user=user, organization=self.org, role=role)
            self.users[role] = user
        self.admin = self.users[Role.COMPANY_ADMIN]
        superuser = User.objects.filter(is_superuser=True).first()
        if superuser is None:
            User.objects.create_superuser("superadmin@demo.erp", password, full_name="Platform Administrator",
                                          default_organization=self.org)

    def setup_masters(self):
        org = self.org
        self.branches = {code: Branch.objects.create(organization=org, code=code, name=name, address=addr)
                         for code, name, addr in [("KTM", "Kathmandu head office", "Balaju, Kathmandu"),
                                                  ("PKR", "Pokhara branch", "Prithvi Chowk, Pokhara"),
                                                  ("BRT", "Biratnagar branch", "Rani, Biratnagar")]}
        self.warehouses = {code: Warehouse.objects.create(organization=org, code=code, name=name, branch=self.branches[b], address=a)
                           for code, name, b, a in WAREHOUSES}
        Membership.objects.get(user=self.users[Role.WAREHOUSE], organization=org).warehouses.set([self.warehouses["KTM"]])
        self.main = self.warehouses["KTM"]
        self.vat = TaxRate.objects.get(organization=org, name="VAT 13%")
        self.exempt = TaxRate.objects.get(organization=org, name="Exempt")
        units = {u.code: u for u in UnitOfMeasure.objects.filter(organization=org)}
        cust_cats = {}
        for name, cat, addr, limit, terms in CUSTOMERS:
            if cat not in cust_cats:
                cust_cats[cat] = CustomerCategory.objects.create(organization=org, name=cat)
        self.customers = []
        for i, (name, cat, addr, limit, terms) in enumerate(CUSTOMERS, 1):
            self.customers.append(Customer.objects.create(
                organization=org, code=f"CUS-{i:05d}", name=name, category=cust_cats[cat], billing_address=addr,
                shipping_address=addr, contact_person=self.rng.choice(["Ram Bahadur", "Sita Kumari", "Hari Prasad", "Gita Devi", "Kiran"]),
                phone=f"98{self.rng.randint(41000000, 69999999)}", tax_id=str(self.rng.randint(300000000, 699999999)),
                credit_limit=D(limit), payment_terms_days=terms, created_by=self.admin))
        sup_cats = {}
        self.suppliers = []
        for i, (name, cat, addr, terms) in enumerate(SUPPLIERS, 1):
            if cat not in sup_cats:
                sup_cats[cat] = SupplierCategory.objects.create(organization=org, name=cat)
            self.suppliers.append(Supplier.objects.create(
                organization=org, code=f"SUP-{i:05d}", name=name, category=sup_cats[cat], address=addr,
                phone=f"01-4{self.rng.randint(100000, 999999)}", tax_id=str(self.rng.randint(300000000, 699999999)),
                payment_terms_days=terms, bank_name=self.rng.choice(["Nabil Bank", "Global IME Bank", "NIC Asia Bank"]),
                bank_account_name=name, bank_account_number=str(self.rng.randint(10**13, 10**14 - 1)),
                bank_branch="Kathmandu", created_by=self.admin))
        from apps.core.numbering import next_code

        with transaction.atomic():
            for _ in range(len(CUSTOMERS)):
                next_code(org, "customer", "CUS")
            for _ in range(len(SUPPLIERS)):
                next_code(org, "supplier", "SUP")
        categories, brands = {}, {}
        self.products = []
        for sku, name, cat, brand, unit, cost, price, reorder, tracking in PRODUCTS:
            if cat not in categories:
                categories[cat] = ProductCategory.objects.create(organization=org, name=cat)
            if brand and brand not in brands:
                brands[brand] = Brand.objects.create(organization=org, name=brand)
            p = Product.objects.create(
                organization=org, sku=sku, name=name, category=categories[cat], brand=brands.get(brand), unit=units[unit],
                purchase_price=D(cost), selling_price=D(price), reorder_level=D(reorder), reorder_quantity=D(reorder * 3),
                tax_rate=self.vat, product_type="SERVICE" if tracking == "service" else "STOCK",
                track_batches=tracking == "batch", track_expiry=tracking == "batch" and sku.startswith(("PNT", "ADH")),
                track_serials=tracking == "serial", barcode=f"890{self.rng.randint(10**9, 10**10 - 1)}" if tracking != "service" else "",
                created_by=self.admin)
            self.products.append(p)
            if price > 1000 and tracking == "":
                PriceTier.objects.create(product=p, min_quantity=D(10), price=money(D(price) * D("0.97")))
                PriceTier.objects.create(product=p, min_quantity=D(50), price=money(D(price) * D("0.94")))
        self.stock_products = [p for p in self.products if p.is_stock]
        self.serial_counter = 1000
        self.batch_counter = 1
        pm = {m.name: m for m in PaymentMethod.objects.filter(organization=org)}
        self.cash_method, self.bank_method, self.cheque_method = pm["Cash"], pm["Bank transfer"], pm["Cheque"]
        self.cash = Account.objects.get(organization=org, system_key=SystemAccount.CASH)
        self.bank = Account.objects.get(organization=org, system_key=SystemAccount.BANK)
        self.bank.name, self.bank.bank_name, self.bank.bank_account_number = "Nabil Bank current account", "Nabil Bank", "01910171234567"
        self.bank.save()
        self.bank2 = Account.objects.create(organization=org, code="1210", name="Global IME Bank OD account", account_type="ASSET",
                                            parent=self.bank.parent, is_bank=True, bank_name="Global IME Bank",
                                            bank_account_number="2201010004321")
        self.expense_categories = list(ExpenseCategory.objects.filter(organization=org))

    # --- helpers -------------------------------------------------------------------------------

    def tracking_for(self, product, qty):
        batch, serials, expiry = "", [], None
        if product.track_batches:
            batch = f"{product.sku[:3]}-{self.batch_counter:04d}"
            self.batch_counter += 1
            expiry = self.cursor + dt.timedelta(days=540) if product.track_expiry else None
        if product.track_serials:
            serials = []
            for _ in range(int(qty)):
                self.serial_counter += 1
                serials.append(f"{product.sku[-2:]}{self.serial_counter:07d}")
        return batch, serials, expiry

    def opening(self, date):
        self.cursor = date
        movement = StockMovement.objects.create(organization=self.org, movement_type=MovementType.OPENING, date=date,
                                                warehouse=self.main, reason="Opening stock at go-live", created_by=self.admin)
        for p in self.stock_products:
            qty = D(p.reorder_level * self.rng.choice([2, 3, 4])) if p.unit.code != "KG" else D(6000)
            if p.track_serials:
                qty = D(12)
            batch, serials, expiry = self.tracking_for(p, qty)
            StockMovementLine.objects.create(movement=movement, product=p, quantity=qty, unit_cost=p.purchase_price,
                                             batch_number=batch, expiry_date=expiry, serial_numbers=serials)
        stock.post_manual_movement(movement, self.admin)
        for c in self.customers[:6]:
            post_customer_opening_balance(c, self.users[Role.ACCOUNTANT], D(self.rng.randrange(40000, 400000, 500)), date)
        for s in self.suppliers[:4]:
            post_supplier_opening_balance(s, self.users[Role.ACCOUNTANT], D(self.rng.randrange(60000, 600000, 500)), date)
        with transaction.atomic():
            capital = Account.objects.get(organization=self.org, code="3100")
            entry = JournalEntry.objects.create(organization=self.org, date=date, narration="Opening bank and cash balances",
                                                source=JournalSource.OPENING, created_by=self.admin,
                                                fiscal_year=self.fy1, period=self.fy1.periods.order_by("number").first())
            JournalLine.objects.create(entry=entry, line_no=1, account=self.bank, debit=D(4500000))
            JournalLine.objects.create(entry=entry, line_no=2, account=self.cash, debit=D(250000))
            JournalLine.objects.create(entry=entry, line_no=3, account=capital, credit=D(4750000))
            post_draft_journal(entry, self.admin)

    def available(self, product, warehouse):
        b = StockBalance.objects.filter(product=product, warehouse=warehouse).first()
        return (b.on_hand - b.reserved) if b else D(0)

    # --- purchases -----------------------------------------------------------------------------

    def purchase_cycle(self, date, supplier, items, warehouse=None, receive=True, bill=True, pay_now=True):
        warehouse = warehouse or self.main
        with transaction.atomic():
            po = PurchaseOrder.objects.create(organization=self.org, supplier=supplier, warehouse=warehouse, order_date=date,
                                              expected_delivery_date=date + dt.timedelta(days=7), payment_terms_days=supplier.payment_terms_days,
                                              number=next_number(self.org, "PO", date), created_by=self.users[Role.PURCHASE],
                                              freight=D(self.rng.choice([0, 0, 1500, 3500])))
            lines = [PurchaseOrderLine(order=po, product=p, quantity=q, unit_price=p.purchase_price,
                                       discount_percent=D(self.rng.choice([0, 0, 2, 5])), tax_rate=self.vat) for p, q in items]
            po.recalculate(lines)
            PurchaseOrderLine.objects.bulk_create(lines)
            po.save()
        purchase_services.submit_po(po, self.users[Role.PURCHASE])
        purchase_services.approve_po(po, self.users[Role.MANAGER])
        if not receive:
            return po
        receipt_date = date
        self.cursor = receipt_date
        with transaction.atomic():
            grn = GoodsReceipt.objects.create(organization=self.org, purchase_order=po, supplier=supplier, warehouse=warehouse,
                                              date=receipt_date, created_by=self.users[Role.WAREHOUSE], received_by=self.users[Role.WAREHOUSE])
            for line in po.lines.all():
                rejected = D(1) if self.rng.random() < 0.08 and line.quantity > 5 and not line.product.track_serials else D(0)
                accepted = line.quantity - rejected
                batch, serials, expiry = self.tracking_for(line.product, accepted)
                GoodsReceiptLine.objects.create(receipt=grn, order_line=line, product=line.product, received_quantity=line.quantity,
                                                accepted_quantity=accepted, rejected_quantity=rejected,
                                                rejection_reason="Damaged in transit" if rejected else "", batch_number=batch,
                                                expiry_date=expiry, serial_numbers=serials)
        purchase_services.post_grn(grn, self.users[Role.WAREHOUSE])
        if not bill:
            return po
        bill_date = receipt_date
        with transaction.atomic():
            b = SupplierBill.objects.create(organization=self.org, supplier=supplier, purchase_order=po, warehouse=warehouse,
                                            supplier_invoice_number=f"{supplier.code[-2:]}-{self.rng.randint(1000, 99999)}",
                                            bill_date=bill_date, due_date=bill_date + dt.timedelta(days=supplier.payment_terms_days),
                                            freight=po.freight, created_by=self.users[Role.ACCOUNTANT])
            lines = []
            for rl in GoodsReceiptLine.objects.filter(receipt=grn).select_related("order_line"):
                ol = rl.order_line
                price = ol.unit_price if self.rng.random() > 0.1 else money(ol.unit_price * D("1.01"))
                lines.append(SupplierBillLine(bill=b, product=rl.product, order_line=ol, receipt_line=rl, quantity=rl.accepted_quantity,
                                              unit_price=price, discount_percent=ol.discount_percent, tax_rate=ol.tax_rate,
                                              batch_number=rl.batch_number))
            b.recalculate(lines)
            SupplierBillLine.objects.bulk_create(lines)
            b.save()
        purchase_services.post_bill(b, self.users[Role.ACCOUNTANT])
        if pay_now:
            pay_date = self.clamp(bill_date + dt.timedelta(days=self.rng.randint(5, supplier.payment_terms_days)))
            self.pay_supplier(b, pay_date)
        return po

    def pay_supplier(self, bill, date, fraction=None):
        bill.refresh_from_db()
        amount = bill.balance_due if fraction is None else money(bill.balance_due * fraction)
        if amount <= 0:
            return
        voucher = PaymentVoucher.objects.create(organization=self.org, supplier=bill.supplier, date=max(date, bill.bill_date),
                                                amount=amount, payment_method=self.bank_method, paid_from_account=self.bank,
                                                reference=f"CHQ {self.rng.randint(100000, 999999)}", prepared_by=self.users[Role.ACCOUNTANT],
                                                created_by=self.users[Role.ACCOUNTANT],
                                                requested_allocations=[{"bill": bill.pk, "amount": str(amount)}])
        pay.post_voucher(voucher, self.admin)

    # --- sales ---------------------------------------------------------------------------------

    def sales_cycle(self, date, customer, warehouse=None, partial=False, invoice=True, collect=True):
        warehouse = warehouse or self.main
        candidates = [p for p in self.stock_products if self.available(p, warehouse) > 0]
        if not candidates:
            return None
        picks = self.rng.sample(candidates, k=min(len(candidates), self.rng.randint(1, 4)))
        items = []
        for p in picks:
            avail = self.available(p, warehouse)
            base = D(self.rng.choice([2, 3, 5, 8, 10, 12, 20])) if p.unit.code != "KG" else D(self.rng.choice([250, 500, 800]))
            qty = min(base, avail)
            if p.track_serials:
                qty = min(D(self.rng.randint(1, 2)), avail)
            if qty > 0:
                items.append((p, qty))
        if self.rng.random() < 0.15:
            items.append((self.products[-2], D(self.rng.randint(2, 6))))
        if not items:
            return None
        with transaction.atomic():
            so = SalesOrder.objects.create(organization=self.org, customer=customer, warehouse=warehouse, order_date=date,
                                           expected_delivery_date=date + dt.timedelta(days=3), payment_terms_days=customer.payment_terms_days,
                                           shipping_address=customer.shipping_address, number=next_number(self.org, "SO", date),
                                           created_by=self.users[Role.SALES], terms=self.org.terms_and_conditions)
            lines = [SalesOrderLine(order=so, product=p, quantity=q, unit_price=sales_services.price_for(p, customer, q),
                                    discount_percent=D(self.rng.choice([0, 0, 0, 2, 5])), tax_rate=self.vat) for p, q in items]
            so.recalculate(lines)
            SalesOrderLine.objects.bulk_create(lines)
            so.save()
        sales_services.submit_order(so, self.users[Role.SALES])
        sales_services.approve_order(so, self.users[Role.MANAGER], override_credit_limit=True)
        delivery_date = self.clamp(date + dt.timedelta(days=self.rng.randint(0, 3)))
        self.cursor = delivery_date
        so.refresh_from_db()
        with transaction.atomic():
            delivery = Delivery.objects.create(organization=self.org, sales_order=so, customer=customer, warehouse=warehouse,
                                               date=delivery_date, shipping_address=so.shipping_address,
                                               vehicle_number=f"Ba {self.rng.randint(1, 9)} Kha {self.rng.randint(1000, 9999)}",
                                               created_by=self.users[Role.WAREHOUSE])
            created = 0
            for line in so.lines.select_related("product"):
                qty = line.quantity if not partial else (line.quantity / 2).quantize(D("1"))
                if line.product.is_stock:
                    qty = min(qty, line.reserved_quantity)
                if qty <= 0:
                    continue
                batch, serials = "", []
                if line.product.track_batches:
                    layer = line.product.batches.filter(layers__warehouse=warehouse, layers__remaining_quantity__gte=qty).order_by("expiry_date", "id").first()
                    if layer is None:
                        continue
                    batch = layer.batch_number
                if line.product.track_serials:
                    serials = list(line.product.serials.filter(status="IN_STOCK", warehouse=warehouse).values_list("serial", flat=True)[: int(qty)])
                DeliveryLine.objects.create(delivery=delivery, order_line=line, product=line.product, quantity=qty,
                                            batch_number=batch, serial_numbers=serials)
                created += 1
        if not created:
            delivery.delete()
            return so
        sales_services.post_delivery(delivery, self.users[Role.WAREHOUSE])
        if not invoice:
            return so
        so.refresh_from_db()
        with transaction.atomic():
            inv = SalesInvoice.objects.create(organization=self.org, customer=customer, sales_order=so, warehouse=warehouse,
                                              invoice_date=delivery_date, due_date=delivery_date + dt.timedelta(days=customer.payment_terms_days),
                                              terms=self.org.terms_and_conditions, created_by=self.users[Role.SALES],
                                              freight=D(self.rng.choice([0, 0, 0, 1500])))
            lines = [SalesInvoiceLine(invoice=inv, order_line=ol, product=ol.product, quantity=qty, unit_price=ol.unit_price,
                                      discount_percent=ol.discount_percent, tax_rate=ol.tax_rate, description=ol.description)
                     for ol, qty in sales_services.invoiceable_lines(so)]
            inv.recalculate(lines)
            SalesInvoiceLine.objects.bulk_create(lines)
            inv.save()
        sales_services.post_invoice(inv, self.users[Role.SALES])
        if collect:
            self.collect(inv, delivery_date)
        return so

    def collect(self, invoice, date):
        invoice.refresh_from_db()
        roll = self.rng.random()
        if roll < 0.15:
            return  # stays unpaid
        pay_date = self.clamp(date + dt.timedelta(days=self.rng.randint(0, invoice.customer.payment_terms_days + 15)))
        amount = invoice.balance_due if roll > 0.35 else money(invoice.balance_due * D("0.5"))
        method, account = (self.cash_method, self.cash) if amount < 50000 else (self.bank_method, self.bank)
        pay.create_receipt(self.org, self.users[Role.ACCOUNTANT], customer=invoice.customer, date=pay_date, amount=amount,
                           payment_method=method, deposit_account=account,
                           reference="" if method == self.cash_method else f"TRF{self.rng.randint(10**6, 10**7)}",
                           allocations=[(invoice, amount)])

    # --- simulation ----------------------------------------------------------------------------

    def simulate(self, start, end):
        day = start
        while day <= end:
            self.cursor = day
            weekday = day.weekday()
            if weekday != 5:  # Saturday is the weekly holiday in Nepal
                if self.rng.random() < 0.55:
                    self.sales_cycle(day, self.rng.choice(self.customers), partial=self.rng.random() < 0.1)
                if self.rng.random() < 0.12:
                    self.sales_cycle(day, self.rng.choice(self.customers), warehouse=self.rng.choice([self.warehouses["PKR"], self.warehouses["BRT"]]))
                if weekday == 0:
                    self.restock(day)
                if self.rng.random() < 0.2:
                    self.expense(day)
            if day.day == 3:
                self.transfer(day)
            if day.day == 20 and self.rng.random() < 0.6:
                self.sales_return(day)
            day += dt.timedelta(days=1)

    def restock(self, day):
        low = [p for p in self.stock_products if self.available(p, self.main) < p.reorder_level * 2]
        if not low:
            return
        by_supplier = {}
        for p in low:
            supplier = {"Paints": 0, "Steel": 1, "Electrical": 2 if p.sku.startswith("WIR") else 3, "Plumbing": 4,
                        "Tools": 5, "Cement": 1}.get(p.category.name, 3)
            by_supplier.setdefault(supplier, []).append(p)
        for idx, products in by_supplier.items():
            items = [(p, D(p.reorder_quantity or p.reorder_level * 3) if not p.track_serials else D(10)) for p in products[:6]]
            self.purchase_cycle(day, self.suppliers[idx], items, pay_now=self.rng.random() < 0.8)

    def expense(self, day):
        category = self.rng.choice(self.expense_categories)
        amount = D(self.rng.randrange(1500, 85000, 50))
        account, method = (self.cash, self.cash_method) if amount < 20000 else (self.bank, self.bank_method)
        e = Expense.objects.create(organization=self.org, category=category, date=day, payee=self.rng.choice(
            ["Nepal Electricity Authority", "Nepal Telecom", "Office landlord", "Staff payroll", "Local transporter", "Stationery shop"]),
            amount=amount, tax_rate=self.vat if category.name in ("Utilities", "Communication", "Office supplies") else None,
            payment_method=method, paid_from_account=account, description=f"{category.name} – {day.strftime('%b %Y')}",
            created_by=self.users[Role.ACCOUNTANT])
        expense_services.calculate(e)
        e.save()
        expense_services.submit_expense(e, self.users[Role.ACCOUNTANT])
        expense_services.approve_expense(e, self.admin)

    def transfer(self, day):
        dest = self.rng.choice([self.warehouses["PKR"], self.warehouses["BRT"]])
        products = [p for p in self.stock_products if not p.track_batches and not p.track_serials and self.available(p, self.main) > p.reorder_level]
        if not products:
            return
        with transaction.atomic():
            t = StockTransfer.objects.create(organization=self.org, date=day, source_warehouse=self.main, destination_warehouse=dest,
                                             created_by=self.users[Role.WAREHOUSE], notes="Monthly replenishment")
            for p in self.rng.sample(products, k=min(4, len(products))):
                qty = (self.available(p, self.main) / 4).quantize(D("1"))
                if qty > 0:
                    StockTransferLine.objects.create(transfer=t, product=p, quantity=qty)
        if not t.lines.exists():
            t.delete()
            return
        stock.dispatch_transfer(t, self.users[Role.WAREHOUSE])
        if day < self.sim_end - dt.timedelta(days=3):
            stock.receive_transfer(t, self.users[Role.WAREHOUSE], date=day)

    def sales_return(self, day):
        invoices = list(SalesInvoice.objects.filter(organization=self.org, status="POSTED", invoice_date__lt=day,
                                                    invoice_date__gte=day - dt.timedelta(days=30), warehouse=self.main)
                        .exclude(lines__product__track_serials=True).order_by("id"))
        if not invoices:
            return
        invoice = self.rng.choice(invoices)
        line = invoice.lines.filter(product__product_type="STOCK", quantity__gt=1).first()
        if line is None:
            return
        with transaction.atomic():
            r = SalesReturn.objects.create(organization=self.org, invoice=invoice, customer=invoice.customer, warehouse=self.main,
                                           date=day, reason="Customer returned excess quantity", created_by=self.users[Role.SALES])
            rl = SalesReturnLine(sales_return=r, invoice_line=line, product=line.product, quantity=D(1), unit_price=line.unit_price,
                                 discount_percent=line.discount_percent, tax_rate=line.tax_rate,
                                 inspection="RESTOCK" if self.rng.random() < 0.8 else "DAMAGED", batch_number=line.batch_number)
            r.recalculate([rl])
            rl.save()
            r.save()
        sales_services.post_sales_return(r, self.users[Role.SALES])

    def open_items(self):
        """Leave realistic work in progress so every screen has something to act on."""
        yesterday = self.today - dt.timedelta(days=1)
        self.cursor = yesterday
        # Draft and submitted sales orders, an approved order awaiting delivery, a partial delivery.
        for status in ("draft", "submitted", "approved"):
            customer = self.rng.choice(self.customers)
            p = self.rng.choice([p for p in self.stock_products if not p.track_serials and not p.track_batches])
            with transaction.atomic():
                so = SalesOrder.objects.create(organization=self.org, customer=customer, warehouse=self.main, order_date=yesterday,
                                               payment_terms_days=customer.payment_terms_days, shipping_address=customer.shipping_address,
                                               number=next_number(self.org, "SO", yesterday), created_by=self.users[Role.SALES])
                line = SalesOrderLine(order=so, product=p, quantity=D(5), unit_price=p.selling_price, tax_rate=self.vat)
                so.recalculate([line])
                line.save()
                so.save()
            if status != "draft":
                sales_services.submit_order(so, self.users[Role.SALES])
            if status == "approved":
                sales_services.approve_order(so, self.users[Role.MANAGER], override_credit_limit=True)
        self.sales_cycle(yesterday, self.customers[1], partial=True, invoice=False)
        # A purchase order awaiting approval and one approved but not yet received.
        supplier = self.suppliers[2]
        with transaction.atomic():
            po = PurchaseOrder.objects.create(organization=self.org, supplier=supplier, warehouse=self.main, order_date=yesterday,
                                              number=next_number(self.org, "PO", yesterday), created_by=self.users[Role.PURCHASE])
            line = PurchaseOrderLine(order=po, product=self.products[8], quantity=D(25), unit_price=self.products[8].purchase_price, tax_rate=self.vat)
            po.recalculate([line])
            line.save()
            po.save()
        purchase_services.submit_po(po, self.users[Role.PURCHASE])
        self.purchase_cycle(yesterday, self.suppliers[4], [(self.products[15], D(40)), (self.products[16], D(40))], receive=False)
        # A draft payment voucher and an expense awaiting approval.
        open_bill = SupplierBill.objects.filter(organization=self.org, status="POSTED", balance_due__gt=0).first()
        if open_bill:
            PaymentVoucher.objects.create(organization=self.org, supplier=open_bill.supplier, date=yesterday,
                                          amount=open_bill.balance_due, payment_method=self.bank_method, paid_from_account=self.bank,
                                          reference="Pending approval", prepared_by=self.users[Role.ACCOUNTANT],
                                          created_by=self.users[Role.ACCOUNTANT],
                                          requested_allocations=[{"bill": open_bill.pk, "amount": str(open_bill.balance_due)}])
        e = Expense.objects.create(organization=self.org, category=self.expense_categories[0], date=yesterday, payee="Office landlord",
                                   amount=D(85000), payment_method=self.bank_method, paid_from_account=self.bank,
                                   description="Warehouse rent", created_by=self.users[Role.ACCOUNTANT])
        expense_services.calculate(e)
        e.save()
        expense_services.submit_expense(e, self.users[Role.ACCOUNTANT])
        # A customer advance (unapplied receipt) and a stock count in progress.
        pay.create_receipt(self.org, self.users[Role.ACCOUNTANT], customer=self.customers[4], date=yesterday, amount=D(150000),
                           payment_method=self.bank_method, deposit_account=self.bank, reference="Advance TRF7781",
                           notes="Advance against next order")
        count = StockCount.objects.create(organization=self.org, date=yesterday, warehouse=self.warehouses["PKR"],
                                          created_by=self.users[Role.WAREHOUSE], notes="Quarterly count")
        for b in StockBalance.objects.filter(warehouse=self.warehouses["PKR"], on_hand__gt=0)[:6]:
            StockCountLine.objects.create(count=count, product=b.product, system_quantity=b.on_hand)

