"""Database-level guarantees for the general ledger.

* A posted or reversed journal entry must balance (Σ debit = Σ credit > 0). Checked by a
  deferred constraint trigger at commit, so lines can be inserted one by one inside the
  posting transaction.
* Lines of a posted/reversed entry cannot be deleted, and only their bank-reconciliation
  fields may change.
"""
from django.db import migrations

FORWARD = r"""
CREATE OR REPLACE FUNCTION accounting_check_journal_balanced() RETURNS trigger AS $$
DECLARE
    eid bigint;
    st varchar;
    d numeric;
    c numeric;
BEGIN
    IF TG_TABLE_NAME = 'accounting_journalentry' THEN
        eid := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        eid := OLD.entry_id;
    ELSE
        eid := NEW.entry_id;
    END IF;
    SELECT status INTO st FROM accounting_journalentry WHERE id = eid;
    IF st IS NULL OR st = 'DRAFT' THEN
        RETURN NULL;
    END IF;
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO d, c
      FROM accounting_journalline WHERE entry_id = eid;
    IF d <> c OR d = 0 THEN
        RAISE EXCEPTION 'Journal entry % is not balanced (debit %, credit %)', eid, d, c
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journalline_balanced
    AFTER INSERT OR UPDATE OR DELETE ON accounting_journalline
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION accounting_check_journal_balanced();

CREATE CONSTRAINT TRIGGER journalentry_balanced
    AFTER INSERT OR UPDATE ON accounting_journalentry
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION accounting_check_journal_balanced();

CREATE OR REPLACE FUNCTION accounting_protect_posted_lines() RETURNS trigger AS $$
DECLARE
    st varchar;
BEGIN
    SELECT status INTO st FROM accounting_journalentry WHERE id = OLD.entry_id;
    IF st IN ('POSTED', 'REVERSED') THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Lines of posted journal % cannot be deleted', OLD.entry_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.entry_id <> OLD.entry_id OR NEW.account_id <> OLD.account_id OR NEW.debit <> OLD.debit
           OR NEW.credit <> OLD.credit OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
           OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
            RAISE EXCEPTION 'Lines of posted journal % cannot be modified', OLD.entry_id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER journalline_protect_posted
    BEFORE UPDATE OR DELETE ON accounting_journalline
    FOR EACH ROW EXECUTE FUNCTION accounting_protect_posted_lines();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS journalline_protect_posted ON accounting_journalline;
DROP FUNCTION IF EXISTS accounting_protect_posted_lines();
DROP TRIGGER IF EXISTS journalentry_balanced ON accounting_journalentry;
DROP TRIGGER IF EXISTS journalline_balanced ON accounting_journalline;
DROP FUNCTION IF EXISTS accounting_check_journal_balanced();
"""


class Migration(migrations.Migration):
    dependencies = [("accounting", "0003_initial")]

    operations = [migrations.RunSQL(FORWARD, REVERSE)]
