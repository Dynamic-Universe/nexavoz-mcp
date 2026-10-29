-- Nexavoz: suscriptores y newsletter (ejecutar después de schema.sql)

create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  status text not null default 'pendiente' check (status in ('pendiente','activo','baja')),
  token text not null default replace(gen_random_uuid()::text, '-', ''),
  source text default 'web',
  created_at timestamptz default now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);

-- Registro de a quién se envió cada número (evita duplicados y permite reanudar)
create table if not exists newsletter_deliveries (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  sent_at timestamptz default now(),
  unique (issue_id, subscriber_id)
);

-- Sin políticas públicas: solo el servidor (service key) puede leer o escribir
alter table subscribers enable row level security;
alter table newsletter_deliveries enable row level security;
