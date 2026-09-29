-- The activity types a user's dashboard feed shows (the reference platform's Latest Activity
-- settings). NULL shows every type.
ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS activity_types text[];
