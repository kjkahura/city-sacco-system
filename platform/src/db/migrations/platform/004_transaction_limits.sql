-- Per-user transaction limits, after Mambu's "Transactions Limits" on a
-- user: the largest loan a user may approve and the largest they may
-- disburse. Null means no limit for that user beyond their role. The limits
-- are checked in the tenant's currency at approval and disbursement; a loan
-- above the limit is refused with the limit in the message, so the answer to
-- "why can't I approve this" is on the screen.

ALTER TABLE platform.users
  ADD COLUMN IF NOT EXISTS approval_limit numeric(18,2),
  ADD COLUMN IF NOT EXISTS disbursement_limit numeric(18,2);
