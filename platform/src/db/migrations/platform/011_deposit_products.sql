-- Deposit products (tenant migration 036): permissions given to a user
-- directly follow the same rule as roles.
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['MAKE_DEPOSIT', 'ACTIVATE_MATURITY'],
    ['EDIT_SAVINGS_ACCOUNT', 'UNDO_MATURITY'],
    ['EDIT_SAVINGS_ACCOUNT', 'MAKE_EARLY_WITHDRAWALS'],
    ['EDIT_SAVINGS_ACCOUNT', 'POST_TRANSACTIONS_ON_DORMANT_ACCOUNTS']]
  LOOP
    UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
