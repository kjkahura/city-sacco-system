-- Run once as the owner role (sacco), with psql or Cloud SQL Studio, then store the password
-- in Secret Manager as sacco-app-db-password and set the repository variable APP_DB_USER=sacco_app
-- (security review, CFG-8). The service then connects as sacco_app; migrations and scheduled
-- jobs keep connecting as sacco.
--
--   psql "host=... dbname=sacco user=sacco" -v pw="'<a long random password>'" -f platform/deploy/security/db-roles.sql
CREATE ROLE sacco_app LOGIN PASSWORD :pw NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE sacco TO sacco_app;
-- Branch-limited users run as sacco_branch_scoped (row security); the service must be able to switch to it.
GRANT sacco_branch_scoped TO sacco_app;
SELECT platform.grant_app_role('platform');
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_log FROM sacco_app;
SELECT platform.grant_app_role(schema_name) FROM platform.tenants WHERE status <> 'CLOSED';
-- Tables and sequences the owner makes later (new SACCOs, platform and tenant migrations) are granted by the migrations.
-- With the service on this role, new SACCOs and sandboxes are made by the owner: `cli tenant:create` and the
-- jobs, not the /admin control plane, which needs CREATE on the database.
