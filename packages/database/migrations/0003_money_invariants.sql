-- Ported from the frozen React Native repo (migrations/0002_phase1.sql). These are the
-- last line of defence: application code checks both rules first, but a bug there must
-- still not be able to write money that does not add up.

CREATE OR REPLACE FUNCTION brainpal_check_ledger_family() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_family uuid;
  account_family uuid;
BEGIN
  SELECT family_id INTO tx_family FROM ledger_transactions WHERE id = NEW.transaction_id;
  SELECT family_id INTO account_family FROM money_accounts WHERE id = NEW.account_id;
  IF tx_family IS NULL OR account_family IS NULL OR tx_family <> account_family THEN
    RAISE EXCEPTION 'ledger entry family mismatch';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS brainpal_ledger_family_trigger ON ledger_entries;
--> statement-breakpoint
CREATE TRIGGER brainpal_ledger_family_trigger
  BEFORE INSERT OR UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION brainpal_check_ledger_family();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION brainpal_check_balanced_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  debits bigint;
  credits bigint;
BEGIN
  target_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
  INTO debits, credits
  FROM ledger_entries WHERE transaction_id = target_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %: debits %, credits %', target_id, debits, credits;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS brainpal_balanced_transaction_trigger ON ledger_entries;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER brainpal_balanced_transaction_trigger
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION brainpal_check_balanced_transaction();
