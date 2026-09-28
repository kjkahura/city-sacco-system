-- Clients and Groups, after the reference platform: permissions given to a user directly
-- follow the same rule as roles (tenant migration 033). What EDIT_CLIENT
-- allowed before now has codes of its own, and a user who held it keeps
-- what it did.
UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['VIEW_GROUP_DETAILS']::text[]) c ORDER BY c)
 WHERE 'VIEW_CLIENT_DETAILS' = ANY (permissions);
UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['CREATE_GROUP']::text[]) c ORDER BY c)
 WHERE 'CREATE_CLIENT' = ANY (permissions);
UPDATE platform.users SET permissions = ARRAY(SELECT DISTINCT c FROM unnest(permissions || ARRAY['APPROVE_CLIENT', 'REJECT_CLIENT',
    'EXIT_CLIENT', 'BLACKLIST_CLIENT', 'UNDO_CLIENT_STATE_CHANGED', 'CHANGE_CLIENT_TYPE', 'MANAGE_CLIENT_ASSOCIATION', 'EDIT_CLIENT_ID',
    'EDIT_BLACKLISTED_CLIENT_CFV', 'EDIT_GROUP', 'CHANGE_GROUP_TYPE', 'MANAGE_GROUP_ASSOCIATION', 'EDIT_GROUP_ID']::text[]) c ORDER BY c)
 WHERE 'EDIT_CLIENT' = ANY (permissions);
