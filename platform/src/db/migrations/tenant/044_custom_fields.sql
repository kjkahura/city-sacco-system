-- Custom fields, after the reference platform's Custom Fields page
-- (docs/audits/audit-custom-fields.md).

-- 1. Link types: CLIENT_LINK points at individuals, GROUP_LINK at groups.
--    MEMBER_LINK becomes GROUP_LINK where every stored value is a group,
--    and CLIENT_LINK otherwise.
ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS custom_field_definitions_field_type_check;

DO $$
DECLARE
  d record;
  tbl text;
  scope text;
  total int;
  groups int;
BEGIN
  FOR d IN SELECT * FROM custom_field_definitions WHERE field_type = 'MEMBER_LINK' LOOP
    tbl := CASE d.entity
      WHEN 'MEMBER' THEN 'members' WHEN 'GROUP' THEN 'members' WHEN 'LOAN_ACCOUNT' THEN 'loan_accounts'
      WHEN 'SAVINGS_ACCOUNT' THEN 'savings_accounts' WHEN 'SAVINGS_PRODUCT' THEN 'savings_products'
      WHEN 'GUARANTOR' THEN 'loan_guarantors' WHEN 'COLLATERAL' THEN 'loan_collateral' WHEN 'BRANCH' THEN 'branches'
      WHEN 'CENTRE' THEN 'centres' WHEN 'USER' THEN 'platform.users' WHEN 'TRANSACTION_CHANNEL' THEN 'transactions'
      WHEN 'CREDIT_ARRANGEMENT' THEN 'credit_arrangements' END;
    scope := CASE WHEN d.entity = 'USER'
      THEN ' AND r.tenant_id = (SELECT id FROM platform.tenants WHERE schema_name = current_schema())' ELSE '' END;
    IF tbl IS NULL THEN
      total := 0; groups := 0;
    ELSE
      -- lax mode reads a standard set's object and each entry of a grouped set alike.
      EXECUTE format(
        'SELECT count(*)::int, count(*) FILTER (WHERE m.holder_type = ''GROUP'')::int
           FROM %s r, jsonb_path_query(r.custom_fields, %L::jsonpath) v
           LEFT JOIN members m ON m.id::text = v #>> ''{}''
          WHERE true%s',
        tbl, CASE WHEN d.set_id IS NULL THEN format('lax $."%s"', d.id) ELSE format('lax $."%s"."%s"', d.set_id, d.id) END, scope)
        INTO total, groups;
    END IF;
    UPDATE custom_field_definitions
       SET field_type = CASE WHEN total > 0 AND total = groups THEN 'GROUP_LINK' ELSE 'CLIENT_LINK' END
     WHERE id = d.id;
  END LOOP;
END $$;

ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_field_definitions_field_type_check CHECK (field_type IN
  ('FREE_TEXT', 'SELECTION', 'NUMBER', 'CHECKBOX', 'DATE', 'DATE_TIME', 'CLIENT_LINK', 'GROUP_LINK', 'USER_LINK'));

-- 2. A dependent selection follows its parent's usage, including whether it
--    is available for all items.
UPDATE custom_field_definitions d
   SET available_for_all = p.available_for_all, usage = p.usage
  FROM custom_field_definitions p
 WHERE d.dependent_on = p.id
   AND (d.available_for_all IS DISTINCT FROM p.available_for_all OR d.usage IS DISTINCT FROM p.usage);

-- 3. Transactions by type (transfers). A transaction-channel set whose every
--    field is used by the internal channel alone (the channel transfers were
--    posted through) moves to the new entity, used for transfers.
WITH movable AS (
  SELECT s.id FROM custom_field_sets s
   WHERE s.entity = 'TRANSACTION_CHANNEL'
     AND EXISTS (SELECT 1 FROM custom_field_definitions d WHERE d.set_id = s.id)
     AND NOT EXISTS (
       SELECT 1 FROM custom_field_definitions d
        WHERE d.set_id = s.id
          AND (d.available_for_all OR d.usage -> 'items' IS NULL
               OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(d.usage -> 'items') k) IS DISTINCT FROM ARRAY['internal']))
)
, moved_defs AS (
  UPDATE custom_field_definitions d
     SET entity = 'TRANSACTION_TYPE', usage = jsonb_build_object('items', jsonb_build_object('TRANSFER', d.usage -> 'items' -> 'internal'))
   WHERE d.set_id IN (SELECT id FROM movable)
  RETURNING d.id
)
UPDATE custom_field_sets SET entity = 'TRANSACTION_TYPE' WHERE id IN (SELECT id FROM movable);

-- 4. Definitions are ordered across their entity (sets first, then fields).
WITH ordered AS (
  SELECT d.id, row_number() OVER (PARTITION BY d.entity ORDER BY s.sort_order NULLS FIRST, d.set_id NULLS FIRST, d.sort_order, d.id) AS n
    FROM custom_field_definitions d LEFT JOIN custom_field_sets s ON s.id = d.set_id
)
UPDATE custom_field_definitions d SET sort_order = o.n FROM ordered o WHERE o.id = d.id AND d.sort_order IS DISTINCT FROM o.n;
