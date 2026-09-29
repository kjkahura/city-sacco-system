-- Deposits > Deposit Accounts (the life cycle), offset loans, after the reference platform.
-- Every setting added here starts where the platform already was: a new
-- account opens ACTIVE, no product offsets, and running accounts keep
-- their state.

-- --------------------------------------------------------------------------
-- The state a new account starts in. ACTIVE is the platform's rule so far;
-- The reference platform's are PENDING_APPROVAL and APPROVED, and an approved account becomes
-- ACTIVE with its first transaction.
-- --------------------------------------------------------------------------
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS initial_state text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE savings_products DROP CONSTRAINT IF EXISTS savings_products_initial_state_check;
ALTER TABLE savings_products ADD CONSTRAINT savings_products_initial_state_check
  CHECK (initial_state IN ('ACTIVE', 'PENDING_APPROVAL', 'APPROVED'));

-- The reference platform's "Allow accounts to be used for Offset": an account of the product
-- may be the offset account of a loan whose product enables offset.
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS allow_offset boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------------
-- Account states. The old PENDING (never written by the platform) is
-- The reference platform's PENDING_APPROVAL. A closed account records how it was closed:
-- REJECTED, WITHDRAWN or WRITTEN_OFF (the reference platform's CLOSED_REJECTED,
-- WITHDRAWN and CLOSED_WRITTEN_OFF); null is a plain close.
-- --------------------------------------------------------------------------
ALTER TABLE savings_accounts DROP CONSTRAINT IF EXISTS savings_accounts_status_check;
UPDATE savings_accounts SET status = 'PENDING_APPROVAL' WHERE status = 'PENDING';
ALTER TABLE savings_accounts ADD CONSTRAINT savings_accounts_status_check
  CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED', 'MATURED', 'CLOSED'));
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS closed_as text;
ALTER TABLE savings_accounts DROP CONSTRAINT IF EXISTS savings_accounts_closed_as_check;
ALTER TABLE savings_accounts ADD CONSTRAINT savings_accounts_closed_as_check
  CHECK (closed_as IS NULL OR (status = 'CLOSED' AND closed_as IN ('REJECTED', 'WITHDRAWN', 'WRITTEN_OFF')));
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS state_before_lock text;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS approved_on date;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS activated_on date;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS locked_on date;
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS in_arrears_since date;

-- An account in arrears is open: it counts for the holder being ACTIVE.
CREATE OR REPLACE FUNCTION refresh_member_state(mid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cur text; nxt text;
BEGIN
  SELECT status INTO cur FROM members WHERE id = mid;
  IF cur IS NULL OR cur NOT IN ('INACTIVE', 'ACTIVE') THEN RETURN; END IF;
  nxt := CASE WHEN
      EXISTS (SELECT 1 FROM loan_accounts l WHERE l.member_id = mid AND l.status IN ('ACTIVE', 'IN_ARREARS', 'LOCKED'))
      OR EXISTS (SELECT 1 FROM savings_accounts a WHERE a.member_id = mid AND a.status IN ('ACTIVE', 'IN_ARREARS', 'DORMANT', 'LOCKED', 'MATURED'))
    THEN 'ACTIVE' ELSE 'INACTIVE' END;
  IF nxt = cur THEN RETURN; END IF;
  UPDATE members SET status = nxt, activated_at = COALESCE(activated_at, CASE WHEN nxt = 'ACTIVE' THEN now() END) WHERE id = mid;
  INSERT INTO member_state_changes (member_id, from_state, to_state, action) VALUES (mid, cur, nxt, 'AUTOMATIC');
END $$;

-- --------------------------------------------------------------------------
-- Offset loans (the reference platform's "Enable Offset"): a dynamic term loan, declining
-- balance with equal instalments, simple interest on principal and
-- interest. Its linked deposit account is the offset account.
-- --------------------------------------------------------------------------
ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS offset_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE loan_products DROP CONSTRAINT IF EXISTS loan_products_offset_shape;
ALTER TABLE loan_products ADD CONSTRAINT loan_products_offset_shape
  CHECK (NOT offset_enabled OR (product_type = 'DYNAMIC_TERM' AND method = 'REDUCING_EQUAL_INSTALLMENTS'
                                AND interest_type = 'SIMPLE' AND simple_base = 'PRINCIPAL_AND_INTEREST' AND settlement_enabled));

-- --------------------------------------------------------------------------
-- The reference platform's deposit account permissions for what this adds, given to the
-- roles that hold the matching permission. Deleting an account is left to
-- administrators.
-- --------------------------------------------------------------------------
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['EDIT_SAVINGS_ACCOUNT', 'APPROVE_SAVINGS'],
    ['EDIT_SAVINGS_ACCOUNT', 'LOCK_SAVINGS_ACCOUNT'],
    ['EDIT_SAVINGS_ACCOUNT', 'UNLOCK_SAVINGS_ACCOUNT'],
    ['CLOSE_SAVINGS_ACCOUNTS', 'REOPEN_SAVINGS_ACCOUNT'],
    ['CLOSE_SAVINGS_ACCOUNTS', 'REVERSE_SAVINGS_ACCOUNT_WRITE_OFF']]
  LOOP
    UPDATE roles SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
