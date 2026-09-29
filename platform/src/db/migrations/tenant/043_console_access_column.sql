-- The console access right on roles keeps its value under the name
-- console_access. A tenant migrated before 032 was reworded has the right in
-- an older boolean *_access column: it is renamed. A new tenant already has
-- console_access from 032, and nothing happens.
DO $$
DECLARE c text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'roles' AND column_name = 'console_access') THEN
    SELECT column_name INTO c FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'roles' AND data_type = 'boolean'
       AND column_name LIKE '%\_access' AND column_name <> 'api_access'
     ORDER BY ordinal_position LIMIT 1;
    IF c IS NULL THEN
      ALTER TABLE roles ADD COLUMN console_access boolean NOT NULL DEFAULT true;
    ELSE
      EXECUTE format('ALTER TABLE roles RENAME COLUMN %I TO console_access', c);
    END IF;
  END IF;
END $$;
