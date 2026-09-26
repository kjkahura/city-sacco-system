'use strict';

const { pool } = require('../db/pool');
const { migrateTenant } = require('../db/migrate');
const { withTenant, TenantError } = require('../db/tenantContext');
const { hashPassword } = require('../auth/passwords');

const SLUG_RE = /^[a-z][a-z0-9_]{2,40}$/;

// Schema names Postgres or we reserve. A SACCO called "public" must not be
// able to claim the public schema.
const RESERVED = new Set([
  'public', 'platform', 'information_schema', 'pg_catalog', 'pg_toast',
  'admin', 'postgres', 'template', 'tenant',
]);

function toSchemaName(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new TenantError(
      'slug must be 3-41 chars, lowercase letters, digits and underscore, starting with a letter', 400
    );
  }
  if (RESERVED.has(slug)) throw new TenantError(`slug "${slug}" is reserved`, 409);
  return `tenant_${slug}`;
}

/**
 * Minimal chart of accounts every SACCO starts with.
 *
 * The fourth column is the regulatory class. Prudential ratios need to know
 * which liabilities are member deposits and which assets count as liquid,
 * and that cannot be derived from the account type alone. It is seeded here
 * as well as backfilled by migration 003, because provisioning seeds these
 * rows after migrations have already run.
 */
const SEED_GL = [
  ['100-100', 'Loan Portfolio',              'ASSET',     'LOAN_PORTFOLIO'],
  // Contra-asset. Classed with the portfolio so assets are reported net of
  // the allowance rather than gross.
  ['100-150', 'Allowance for Loan Losses',   'ASSET',     'LOAN_PORTFOLIO'],
  ['100-200', 'Cash on Hand',                'ASSET',     'LIQUID_ASSET'],
  ['100-210', 'Bank Account',                'ASSET',     'LIQUID_ASSET'],
  ['100-220', 'Mobile Money Settlement',     'ASSET',     'LIQUID_ASSET'],
  ['100-300', 'Interest Receivable',         'ASSET',     'OTHER_ASSET'],
  ['100-310', 'Fees Receivable',             'ASSET',     'OTHER_ASSET'],
  ['100-320', 'Penalties Receivable',        'ASSET',     'OTHER_ASSET'],
  ['200-100', 'Member Deposits',             'LIABILITY', 'MEMBER_DEPOSIT'],
  ['200-200', 'Dividends Payable',           'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['200-300', 'Taxes Payable',               'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['200-310', 'Loan Credit Balances',        'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['200-320', 'Funding Accounts',            'LIABILITY', 'MEMBER_DEPOSIT'],
  ['300-100', 'Share Capital',               'EQUITY',    'SHARE_CAPITAL'],
  ['300-200', 'Retained Earnings',           'EQUITY',    'INSTITUTIONAL_CAPITAL'],
  ['300-300', 'Statutory Reserve',           'EQUITY',    'INSTITUTIONAL_CAPITAL'],
  ['400-100', 'Interest Income on Loans',    'INCOME',    'INCOME'],
  ['400-200', 'Fee and Commission Income',   'INCOME',    'INCOME'],
  ['500-100', 'Interest Expense on Deposits','EXPENSE',   'EXPENSE'],
  ['500-200', 'Operating Expenses',          'EXPENSE',   'EXPENSE'],
  ['500-300', 'Loan Loss Provision',         'EXPENSE',   'EXPENSE'],
  ['500-310', 'Loan Write-off Expense',      'EXPENSE',   'EXPENSE'],
  ['100-330', 'Negative Interest Receivable', 'ASSET',    'OTHER_ASSET'],
  ['100-400', 'Overdraft Portfolio',         'ASSET',     'LOAN_PORTFOLIO'],
  ['100-410', 'Overdraft Interest Receivable', 'ASSET',   'OTHER_ASSET'],
  ['200-110', 'Interest Payable on Deposits', 'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['200-330', 'Withholding Tax Payable',     'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['200-340', 'Interest Received in Advance', 'LIABILITY', 'SHORT_TERM_LIABILITY'],
  ['290-100', 'Inter-branch Clearing',       'LIABILITY', 'OTHER_LIABILITY'],
  ['290-200', 'Settlement Clearing',         'LIABILITY', 'OTHER_LIABILITY'],
  ['290-900', 'Suspense: Products Without Accounting', 'LIABILITY', 'OTHER_LIABILITY'],
  ['300-900', 'Accounting Method Conversions', 'EQUITY',  'INSTITUTIONAL_CAPITAL'],
  ['400-300', 'Overdraft Interest Income',   'INCOME',    'INCOME'],
  ['400-310', 'Negative Interest Income',    'INCOME',    'INCOME'],
  ['400-400', 'Recoveries on Written-off Loans', 'INCOME', 'INCOME'],
  ['500-320', 'Overdraft Write-off Expense', 'EXPENSE',   'EXPENSE'],
];

const SEED_CHANNELS = [
  ['cash', 'Cash', 'CASH', '100-200'],
  ['mpesa', 'M-Pesa', 'MOBILE', '100-220'],
  ['bank', 'Bank Transfer', 'TRANSFER', '100-210'],
  ['cheque', 'Cheque', 'CHEQUE', '100-210'],
  ['payroll', 'Payroll Check-off', 'PAYROLL', '100-210'],
  ['internal', 'Internal', 'INTERNAL', null],
  ['settlement', 'Settlement account transfer', 'INTERNAL', '290-200'],
];

/**
 * Create a tenant: register it, build its schema, migrate it, seed the
 * chart of accounts and channels, and create the first admin.
 *
 * The registry row and the schema are created in one transaction so a failed
 * provision cannot leave a tenant that exists in one place but not the other.
 */
async function provisionTenant({
  slug, name, countryCode = 'KE', currencyCode = 'KES',
  timezone = 'Africa/Nairobi', plan = 'STANDARD',
  mfaRequiredRoles = null,   // null keeps the secure default (TENANT_ADMIN)
  adminEmail, adminPassword, adminName,
}) {
  const schemaName = toSchemaName(slug);
  if (!adminEmail || !adminPassword) {
    throw new TenantError('adminEmail and adminPassword are required', 400);
  }
  if (String(adminPassword).length < 12) {
    throw new TenantError('admin password must be at least 12 characters', 400);
  }

  const exists = await pool.query('SELECT 1 FROM platform.tenants WHERE slug = $1', [slug]);
  if (exists.rowCount) throw new TenantError(`tenant "${slug}" already exists`, 409);

  const client = await pool.connect();
  let tenant;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO platform.tenants (slug, schema_name, name, country_code, currency_code, timezone, plan, status,
                                     mfa_required_roles)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PROVISIONING',
               COALESCE($8::text[], ARRAY['TENANT_ADMIN']::text[])) RETURNING *`,
      [slug, schemaName, name, countryCode, currencyCode, timezone, plan, mfaRequiredRoles]
    );
    tenant = rows[0];
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  try {
    await migrateTenant(schemaName);

    await withTenant(schemaName, async (c) => {
      for (const [code, gname, type, regClass] of SEED_GL) {
        await c.query(
          `INSERT INTO gl_accounts (code, name, type, regulatory_class)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (code) DO UPDATE SET regulatory_class = EXCLUDED.regulatory_class`,
          [code, gname, type, regClass]
        );
      }
      for (const [id, cname, ctype, gl] of SEED_CHANNELS) {
        await c.query(
          'INSERT INTO transaction_channels (id, name, channel_type, gl_account_code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [id, cname, ctype, gl]
        );
      }
      await c.query(
        `INSERT INTO savings_products (id, name, annual_rate, gl_liability, gl_interest_exp, gl_fee_inc)
         VALUES ('SAV01','Ordinary Savings',4.000,'200-100','500-100','400-200') ON CONFLICT DO NOTHING`
      );
      await c.query(
        `INSERT INTO loan_products (id, name, method, monthly_rate, max_term, processing_fee, gl_portfolio, gl_interest_inc, gl_fee_inc)
         VALUES ('NL01','Normal Loan','FLAT',1.000,60,1000,'100-100','400-100','400-200') ON CONFLICT DO NOTHING`
      );
      await c.query(
        `INSERT INTO share_products (id, name, unit_price, min_units, gl_equity)
         VALUES ('SHR01','Ordinary Shares',100,10,'300-100') ON CONFLICT DO NOTHING`
      );
    });

    const hash = await hashPassword(adminPassword);
    await pool.query(
      `INSERT INTO platform.users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,'TENANT_ADMIN')`,
      [tenant.id, adminEmail, hash, adminName || adminEmail]
    );

    const { rows } = await pool.query(
      "UPDATE platform.tenants SET status='ACTIVE', updated_at=now() WHERE id=$1 RETURNING *",
      [tenant.id]
    );
    await pool.query(
      "INSERT INTO platform.audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,'TENANT_PROVISIONED',$3)",
      [tenant.id, adminEmail, JSON.stringify({ slug, schemaName })]
    );
    return rows[0];
  } catch (e) {
    // Provisioning failed partway. Leave the schema for inspection but mark
    // the tenant so nothing routes to a half-built book.
    await pool.query(
      "UPDATE platform.tenants SET status='SUSPENDED', updated_at=now() WHERE id=$1", [tenant.id]
    ).catch(() => {});
    throw new Error(`provisioning ${slug} failed: ${e.message}`);
  }
}

/** Irreversible. Drops the whole schema. */
async function deprovisionTenant(slug, { confirm } = {}) {
  if (confirm !== slug) throw new TenantError('confirm must equal the tenant slug', 400);
  const { rows } = await pool.query('SELECT * FROM platform.tenants WHERE slug = $1', [slug]);
  if (!rows.length) throw new TenantError('tenant not found', 404);
  const t = rows[0];

  const { rows: [{ format: ddl }] } = await pool.query(
    "SELECT format('DROP SCHEMA IF EXISTS %I CASCADE', $1::text)", [t.schema_name]
  );
  await pool.query(ddl);
  await pool.query('DELETE FROM platform.schema_migrations WHERE schema_name = $1', [t.schema_name]);
  await pool.query("UPDATE platform.tenants SET status='CLOSED', updated_at=now() WHERE id=$1", [t.id]);
  return { slug, dropped: t.schema_name };
}

async function listTenants() {
  const { rows } = await pool.query(
    'SELECT id, slug, schema_name, name, country_code, currency_code, status, plan, created_at FROM platform.tenants ORDER BY slug'
  );
  return rows;
}

async function getTenantBySlug(slug) {
  const { rows } = await pool.query('SELECT * FROM platform.tenants WHERE slug = $1', [slug]);
  return rows[0] || null;
}

module.exports = {
  provisionTenant, deprovisionTenant, listTenants, getTenantBySlug,
  toSchemaName, SLUG_RE, RESERVED,
};
