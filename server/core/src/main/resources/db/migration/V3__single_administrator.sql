-- A database invariant supplements the advisory lock in the bootstrap transaction.
CREATE UNIQUE INDEX uk_users_single_administrator ON users ((true));

INSERT INTO settings(key,value)
SELECT 'auth.initialized','true'::jsonb WHERE EXISTS(SELECT 1 FROM users)
ON CONFLICT(key) DO NOTHING;
