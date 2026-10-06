-- Backdating loan and share postings needs its own permission now (security review, BIZ-2). Roles
-- that could backdate deposit transactions keep the same reach, so no SACCO's staff lose a right they had.
UPDATE roles SET permissions = permissions || ARRAY['BACKDATE_LOAN_TRANSACTIONS', 'BACKDATE_SHARE_TRANSACTIONS']
 WHERE 'BACKDATE_SAVINGS_TRANSACTIONS' = ANY(permissions) AND NOT ('BACKDATE_LOAN_TRANSACTIONS' = ANY(permissions));
