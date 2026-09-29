-- Working with deposit accounts (tenant migration 039): permissions given to
-- a user directly follow the same rule as roles.
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['MAKE_DEPOSIT', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_WITHDRAWAL', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_TRANSFER', 'BACKDATE_SAVINGS_TRANSACTIONS'],
    ['MAKE_TRANSFER', 'MAKE_INTER_CLIENTS_TRANSFERS'],
    ['APPLY_SAVINGS_ADJUSTMENTS', 'BULK_DEPOSIT_CORRECTIONS'],
    ['VIEW_SAVINGS_ACCOUNT_DETAILS', 'VIEW_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'CREATE_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'UPDATE_HOLDS'],
    ['EDIT_SAVINGS_ACCOUNT', 'DELETE_HOLDS']]
  LOOP
    UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
