-- Deposits > Managing Deposit Accounts, after the reference platform: the account's own name
-- (The reference platform's account name, editable at any time). Empty means the product's
-- name, as before.
ALTER TABLE savings_accounts ADD COLUMN IF NOT EXISTS name text;
