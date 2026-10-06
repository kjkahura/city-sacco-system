-- Security review, October 2026 (docs/audits/security-assessment-2026-10.md).
--
-- The till check (032) read the till without locking it, so two cash payouts
-- by the same teller at the same moment could both pass the till's limits and
-- the "would go negative" check. The till row is now locked for the posting.
CREATE OR REPLACE FUNCTION transactions_till_link() RETURNS trigger AS $$
DECLARE
  actor text := nullif(current_setting('app.actor', true), '');
  required boolean := coalesce(current_setting('app.till_required', true), '') = 'true';
  may_add boolean := coalesce(current_setting('app.till_add', true), 'true') = 'true';
  may_remove boolean := coalesce(current_setting('app.till_remove', true), 'true') = 'true';
  t tills%ROWTYPE;
  s int;
  moved numeric;
  after numeric;
BEGIN
  IF actor IS NULL OR NEW.channel_id IS NULL OR NEW.till_id IS NOT NULL THEN RETURN NEW; END IF;
  s := till_sign(NEW.kind);
  IF s = 0 THEN RETURN NEW; END IF;
  SELECT * INTO t FROM tills WHERE status = 'OPEN' AND lower(teller_email) = lower(actor) AND channel_id = NEW.channel_id FOR UPDATE;
  IF NOT FOUND THEN
    IF required AND EXISTS (SELECT 1 FROM transaction_channels WHERE id = NEW.channel_id AND is_default) THEN
      RAISE EXCEPTION 'NO_OPEN_TILL: open a till before posting cash transactions' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- The reference platform's Add Cash and Remove Cash: a teller's permission to post cash in or out through a till.
  IF s = 1 AND NOT may_add THEN
    RAISE EXCEPTION 'PERMISSION_REQUIRED: ADD_CASH, to post deposits and repayments through till %', t.till_code USING ERRCODE = '42501';
  END IF;
  IF s = -1 AND NOT may_remove THEN
    RAISE EXCEPTION 'PERMISSION_REQUIRED: REMOVE_CASH, to post withdrawals and disbursements through till %', t.till_code USING ERRCODE = '42501';
  END IF;
  moved := s * till_amount(NEW.kind, NEW.amount, NEW.allocation);
  after := till_expected(t.id) + moved;
  IF t.balance_constraint = 'HARD' AND ((t.min_balance IS NOT NULL AND after < t.min_balance) OR (t.max_balance IS NOT NULL AND after > t.max_balance)) THEN
    RAISE EXCEPTION 'TILL_BALANCE_CONSTRAINT: the till would hold % (limits % to %)', after, coalesce(t.min_balance::text, 'none'), coalesce(t.max_balance::text, 'none')
      USING ERRCODE = '23514';
  END IF;
  IF after < 0 THEN
    RAISE EXCEPTION 'TILL_WOULD_GO_NEGATIVE: the till holds % and this pays out %', after - moved, -moved USING ERRCODE = '23514';
  END IF;
  NEW.till_id := t.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
