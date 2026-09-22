-- Regulatory returns, defined as data.
--
-- A return is a list of numbered lines, each of which is either a sum over
-- part of the chart of accounts or an arithmetic expression over other
-- lines. Defining them as rows rather than as code means a new form, or a
-- changed one, is an INSERT and not a release.
--
-- No official form is shipped. The only template here is a sample, flagged
-- as such, so there is something to render and test against. Nobody should
-- mistake it for a SASRA return, and `is_official` exists so the renderer
-- can say plainly which it is looking at.

CREATE TABLE IF NOT EXISTS return_templates (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  -- POINT_IN_TIME reads balances as at a date (a balance sheet return).
  -- PERIOD reads movement between two dates (an income return).
  period_kind text NOT NULL DEFAULT 'POINT_IN_TIME'
              CHECK (period_kind IN ('POINT_IN_TIME','PERIOD')),
  -- False until a human confirms the line items against the published form.
  is_official boolean NOT NULL DEFAULT false,
  source_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_lines (
  id            bigserial PRIMARY KEY,
  template_code text NOT NULL REFERENCES return_templates(code) ON DELETE CASCADE,
  -- The reference the form itself uses (1, 2a, B14). Expressions refer to
  -- other lines by this, so it is what the regulator's numbering says.
  ref           text NOT NULL,
  line_no       int NOT NULL,
  label         text NOT NULL,
  -- GL_CODES / REGULATORY_CLASSES / ACCOUNT_TYPES sum a slice of the chart
  -- of accounts. EXPRESSION computes from other lines. HEADING is a label
  -- with no value, because printed forms have those.
  measure       text NOT NULL CHECK (measure IN
                ('GL_CODES','REGULATORY_CLASSES','ACCOUNT_TYPES','EXPRESSION','HEADING')),
  selector      text[],
  -- Balances are debit-positive internally. A liability line wants +1 for a
  -- credit balance, so it carries sign -1.
  sign          int NOT NULL DEFAULT 1 CHECK (sign IN (1,-1)),
  expression    text,
  note          text,
  UNIQUE (template_code, ref)
);

CREATE INDEX IF NOT EXISTS return_lines_template_idx ON return_lines (template_code, line_no);

-- A line has to know where its number comes from.
ALTER TABLE return_lines DROP CONSTRAINT IF EXISTS return_lines_source_present;
ALTER TABLE return_lines ADD CONSTRAINT return_lines_source_present CHECK (
  (measure = 'HEADING')
  OR (measure = 'EXPRESSION' AND expression IS NOT NULL)
  OR (measure IN ('GL_CODES','REGULATORY_CLASSES','ACCOUNT_TYPES')
      AND selector IS NOT NULL AND array_length(selector, 1) > 0)
);

-- --------------------------------------------------------------------------
-- Sample template. Not a regulatory form.
-- --------------------------------------------------------------------------

INSERT INTO return_templates (code, name, description, period_kind, is_official, source_note) VALUES
  ('SAMPLE_FINPOS', 'Sample statement of financial position',
   'A worked example showing how a return is defined: class sums, a sign flip for liabilities and equity, and totals as expressions over other lines.',
   'POINT_IN_TIME', false,
   'SAMPLE ONLY. Line items are invented for demonstration. Replace with the published form before filing anything.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO return_lines (template_code, ref, line_no, label, measure, selector, sign, expression, note) VALUES
  ('SAMPLE_FINPOS', 'A',  10, 'ASSETS',                      'HEADING',             NULL, 1, NULL, NULL),
  ('SAMPLE_FINPOS', 'A1', 20, 'Liquid assets',               'REGULATORY_CLASSES', ARRAY['LIQUID_ASSET'], 1, NULL, NULL),
  ('SAMPLE_FINPOS', 'A2', 30, 'Net loan portfolio',          'REGULATORY_CLASSES', ARRAY['LOAN_PORTFOLIO'], 1, NULL, 'Net of the loan loss allowance, which is classed with the portfolio.'),
  ('SAMPLE_FINPOS', 'A3', 40, 'Other assets',                'REGULATORY_CLASSES', ARRAY['OTHER_ASSET'], 1, NULL, NULL),
  ('SAMPLE_FINPOS', 'A9', 50, 'Total assets',                'EXPRESSION',          NULL, 1, 'A1 + A2 + A3', NULL),
  ('SAMPLE_FINPOS', 'L',  60, 'LIABILITIES',                 'HEADING',             NULL, 1, NULL, NULL),
  ('SAMPLE_FINPOS', 'L1', 70, 'Member deposits',             'REGULATORY_CLASSES', ARRAY['MEMBER_DEPOSIT'], -1, NULL, NULL),
  ('SAMPLE_FINPOS', 'L2', 80, 'Other liabilities',           'REGULATORY_CLASSES', ARRAY['SHORT_TERM_LIABILITY','OTHER_LIABILITY'], -1, NULL, NULL),
  ('SAMPLE_FINPOS', 'L9', 90, 'Total liabilities',           'EXPRESSION',          NULL, 1, 'L1 + L2', NULL),
  ('SAMPLE_FINPOS', 'E',  100, 'EQUITY',                     'HEADING',             NULL, 1, NULL, NULL),
  ('SAMPLE_FINPOS', 'E1', 110, 'Share capital',              'REGULATORY_CLASSES', ARRAY['SHARE_CAPITAL'], -1, NULL, NULL),
  ('SAMPLE_FINPOS', 'E2', 120, 'Institutional capital',      'REGULATORY_CLASSES', ARRAY['INSTITUTIONAL_CAPITAL'], -1, NULL, NULL),
  ('SAMPLE_FINPOS', 'E3', 130, 'Surplus not yet closed',     'ACCOUNT_TYPES',      ARRAY['INCOME','EXPENSE'], -1, NULL, 'Income less expenses still sitting in the profit and loss accounts.'),
  ('SAMPLE_FINPOS', 'E9', 140, 'Total equity',               'EXPRESSION',          NULL, 1, 'E1 + E2 + E3', NULL),
  ('SAMPLE_FINPOS', 'X1', 150, 'Assets less liabilities and equity', 'EXPRESSION',  NULL, 1, 'A9 - L9 - E9', 'Zero when the book balances.')
ON CONFLICT (template_code, ref) DO NOTHING;
