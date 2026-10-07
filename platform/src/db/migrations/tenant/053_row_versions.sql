-- Optimistic locking for configuration (lib/versioning). Two administrators
-- editing the same product, channel or custom field: the second save used
-- to overwrite the first without either knowing. Each of these rows now
-- carries a version, raised by any change to it; GET returns it as an ETag,
-- and a PUT or PATCH sent with If-Match is refused with 412 when the row has
-- changed since. Reordering (sort_order), the updated_at stamp and the
-- account number counter (id_next, moved by every account opened) do not
-- count as a change, so rearranging a list or opening an account does not
-- refuse someone's edit. A product's fees are part of the product: adding,
-- changing or deleting a fee raises the product's version.

CREATE OR REPLACE FUNCTION bump_row_version() RETURNS trigger AS $$
BEGIN
  IF NEW.row_version IS DISTINCT FROM OLD.row_version THEN
    -- Raised on purpose (a fee changed, below): keep it.
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'row_version' - 'sort_order' - 'updated_at' - 'id_next')
     IS DISTINCT FROM (to_jsonb(OLD) - 'row_version' - 'sort_order' - 'updated_at' - 'id_next') THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE savings_products ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE transaction_channels ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE custom_field_sets ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

DROP TRIGGER IF EXISTS loan_products_row_version ON loan_products;
CREATE TRIGGER loan_products_row_version BEFORE UPDATE ON loan_products
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS savings_products_row_version ON savings_products;
CREATE TRIGGER savings_products_row_version BEFORE UPDATE ON savings_products
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS transaction_channels_row_version ON transaction_channels;
CREATE TRIGGER transaction_channels_row_version BEFORE UPDATE ON transaction_channels
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS custom_field_sets_row_version ON custom_field_sets;
CREATE TRIGGER custom_field_sets_row_version BEFORE UPDATE ON custom_field_sets
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
DROP TRIGGER IF EXISTS custom_field_definitions_row_version ON custom_field_definitions;
CREATE TRIGGER custom_field_definitions_row_version BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

CREATE OR REPLACE FUNCTION bump_product_version_for_fee() RETURNS trigger AS $$
DECLARE
  pid text := COALESCE(NEW.product_id, OLD.product_id);
BEGIN
  IF TG_TABLE_NAME = 'loan_product_fees' THEN
    UPDATE loan_products SET row_version = row_version + 1 WHERE id = pid;
  ELSE
    UPDATE savings_products SET row_version = row_version + 1 WHERE id = pid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loan_product_fees_bump_product ON loan_product_fees;
CREATE TRIGGER loan_product_fees_bump_product AFTER INSERT OR UPDATE OR DELETE ON loan_product_fees
  FOR EACH ROW EXECUTE FUNCTION bump_product_version_for_fee();
DROP TRIGGER IF EXISTS savings_product_fees_bump_product ON savings_product_fees;
CREATE TRIGGER savings_product_fees_bump_product AFTER INSERT OR UPDATE OR DELETE ON savings_product_fees
  FOR EACH ROW EXECUTE FUNCTION bump_product_version_for_fee();
