-- Credit arrangements (tenant migration 035): permissions given to a user
-- directly follow the same rule as roles. A user holding a loan permission
-- is given the matching credit arrangement permission.
DO $$
DECLARE pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['VIEW_LOAN_ACCOUNT_DETAILS', 'VIEW_LINE_OF_CREDIT_DETAILS'],
    ['CREATE_LOAN_ACCOUNT', 'CREATE_LINES_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'EDIT_LINES_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'ADD_ACCOUNTS_TO_LINE_OF_CREDIT'],
    ['EDIT_LOAN_ACCOUNT', 'REMOTE_ACCOUNTS_FROM_LINE_OF_CREDIT'],
    ['APPROVE_LOANS', 'APPROVE_LINE_OF_CREDIT'],
    ['APPROVE_LOANS', 'UNDO_APPROVE_LINE_OF_CREDIT'],
    ['WITHDRAW_LOAN_ACCOUNTS', 'WITHDRAW_LINE_OF_CREDIT'],
    ['UNDO_WITHDRAW_LOAN_ACCOUNTS', 'UNDO_WITHDRAW_LINE_OF_CREDIT'],
    ['REJECT_LOANS', 'REJECT_LINE_OF_CREDIT'],
    ['UNDO_REJECT_LOANS', 'UNDO_REJECT_LINE_OF_CREDIT'],
    ['CLOSE_LOAN_ACCOUNTS', 'CLOSE_LINES_OF_CREDIT'],
    ['DELETE_LOAN_ACCOUNT', 'DELETE_LINES_OF_CREDIT']]
  LOOP
    UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY[pair[2]]::text[]) c ORDER BY c)
     WHERE pair[1] = ANY (permissions) AND NOT (pair[2] = ANY (permissions));
  END LOOP;
END $$;
