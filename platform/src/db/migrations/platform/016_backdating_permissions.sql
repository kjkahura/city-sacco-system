-- Backdating loan and share postings needs its own permission now (security review, BIZ-2). Users and
-- API consumers given the deposit backdating permission directly keep the same reach.
UPDATE platform.users SET permissions = permissions || ARRAY['BACKDATE_LOAN_TRANSACTIONS', 'BACKDATE_SHARE_TRANSACTIONS']
 WHERE 'BACKDATE_SAVINGS_TRANSACTIONS' = ANY(permissions) AND NOT ('BACKDATE_LOAN_TRANSACTIONS' = ANY(permissions));
UPDATE platform.api_consumers SET permissions = permissions || ARRAY['BACKDATE_LOAN_TRANSACTIONS', 'BACKDATE_SHARE_TRANSACTIONS']
 WHERE 'BACKDATE_SAVINGS_TRANSACTIONS' = ANY(permissions) AND NOT ('BACKDATE_LOAN_TRANSACTIONS' = ANY(permissions));
