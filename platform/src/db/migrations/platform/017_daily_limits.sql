-- Daily limits (security review, BIZ-6): what one user, or one API consumer, may deposit, withdraw
-- (transfers included) or take as repayments in a day, summed. NULL is no daily limit, as before.
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS daily_deposit_limit numeric(18,2) CHECK (daily_deposit_limit >= 0);
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS daily_withdrawal_limit numeric(18,2) CHECK (daily_withdrawal_limit >= 0);
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS daily_repayment_limit numeric(18,2) CHECK (daily_repayment_limit >= 0);
-- API consumers had no transaction limits at all: per transaction and per day, NULL for none.
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS deposit_limit numeric(18,2) CHECK (deposit_limit >= 0);
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS withdrawal_limit numeric(18,2) CHECK (withdrawal_limit >= 0);
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS repayment_limit numeric(18,2) CHECK (repayment_limit >= 0);
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS daily_deposit_limit numeric(18,2) CHECK (daily_deposit_limit >= 0);
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS daily_withdrawal_limit numeric(18,2) CHECK (daily_withdrawal_limit >= 0);
ALTER TABLE platform.api_consumers ADD COLUMN IF NOT EXISTS daily_repayment_limit numeric(18,2) CHECK (daily_repayment_limit >= 0);
