-- Web Push subscriptions (browser push notifications, third leg next to
-- in-app bell + Brevo email). One row per browser subscription; rows are
-- pruned automatically when the push service reports them dead (410/404).
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
