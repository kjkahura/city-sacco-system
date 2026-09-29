-- Deposit accounts (tenant migration 037): permissions given to a user
-- directly follow the same rule as roles.
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
    UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
