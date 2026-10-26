"""Create an organisation with its default chart of accounts and an administrator.

    python manage.py create_organization --name "Acme Traders" --code acme \
        --admin-email admin@acme.com --admin-name "Admin" [--admin-password ...]
"""
import getpass

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.organizations.models import Organization
from apps.organizations.setup import bootstrap_organization
from apps.users.models import Membership, User
from apps.users.roles import Role


class Command(BaseCommand):
    help = "Create an organisation (with default accounts, taxes, units and numbering) and its Company Admin."

    def add_arguments(self, parser):
        parser.add_argument("--name", required=True)
        parser.add_argument("--code", required=True)
        parser.add_argument("--admin-email", required=True)
        parser.add_argument("--admin-name", default="Administrator")
        parser.add_argument("--admin-password")

    @transaction.atomic
    def handle(self, *args, **opts):
        if Organization.objects.filter(code=opts["code"]).exists():
            raise CommandError(f"Organisation code '{opts['code']}' already exists.")
        org = bootstrap_organization(Organization.objects.create(name=opts["name"], code=opts["code"]))
        user = User.objects.filter(email__iexact=opts["admin_email"]).first()
        if user is None:
            password = opts["admin_password"] or getpass.getpass("Admin password: ")
            from django.contrib.auth.password_validation import validate_password

            validate_password(password)
            user = User.objects.create_user(opts["admin_email"], password, full_name=opts["admin_name"], default_organization=org)
        Membership.objects.create(user=user, organization=org, role=Role.COMPANY_ADMIN)
        self.stdout.write(self.style.SUCCESS(f"Created {org.name} (id {org.pk}); admin {user.email}. "
                                             "Next: create a fiscal year in Administration → Fiscal years."))
