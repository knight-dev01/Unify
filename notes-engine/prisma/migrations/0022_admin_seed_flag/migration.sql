-- Real admin role for the bootstrap account + seeded-content flag so the
-- admin activity feed shows human publishes, not boot-seeded demo rows.
update profiles set role = 'admin' where email = 'unify.admin@unify.learn';

alter table topic_notes add column if not exists is_seed boolean not null default false;
-- Bootstrap rows were inserted with no author; genuine publishes always
-- carry one. Mark the authorless rows as seed (one-time backfill).
update topic_notes set is_seed = true where author_id is null and is_seed = false;
