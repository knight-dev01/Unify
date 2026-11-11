-- Important messages from Unify can be pinned to the top of Notifications.
-- "Clear all" leaves pinned ones; each can still be deleted on its own.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
