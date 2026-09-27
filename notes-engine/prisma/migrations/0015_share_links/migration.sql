-- Expiring share links (viral loop): any signed-in user shares a week as
-- /s/:token. Links die at expires_at (24h / 7d / 30d picker); views counts
-- opens. Readers need no account; completing/XP stays signed-in only.
create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  user_id uuid not null references profiles(id) on delete cascade,
  course text not null,
  week int not null,
  expires_at timestamptz not null,
  views int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists share_links_user_idx on share_links (user_id);
create index if not exists share_links_token_idx on share_links (token);
alter table share_links enable row level security;
