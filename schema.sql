-- Nexavoz: esquema para Supabase (pegar en SQL Editor y ejecutar)
create extension if not exists pgcrypto;

create table if not exists authors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  bio text,
  created_at timestamptz default now()
);

create table if not exists sections (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  description text
);

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  number int not null unique,
  title text not null,
  issue_date date,
  summary text,
  cover_url text,
  pdf_url text,
  status text not null default 'borrador' check (status in ('borrador','revision','publicado')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid references issues(id) on delete set null,
  section_id uuid references sections(id) on delete set null,
  author_id uuid references authors(id) on delete set null,
  title text not null,
  subtitle text,
  slug text unique,
  body text not null default '',
  status text not null default 'idea' check (status in ('idea','redaccion','revision','maquetado','publicado')),
  tags text[] not null default '{}',
  publish_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid references issues(id) on delete cascade,
  article_id uuid references articles(id) on delete cascade,
  kind text not null default 'imagen' check (kind in ('imagen','pdf','audio','video','otro')),
  url text not null,
  storage_path text,
  caption text,
  credit text,
  size_bytes bigint default 0,
  created_at timestamptz default now()
);

create index if not exists articles_issue_idx on articles(issue_id);
create index if not exists assets_issue_idx on assets(issue_id);
create index if not exists assets_article_idx on assets(article_id);

-- Seguridad: nadie con la clave pública puede leer; el MCP usa la service key.
alter table authors  enable row level security;
alter table sections enable row level security;
alter table issues   enable row level security;
alter table articles enable row level security;
alter table assets   enable row level security;

-- Bucket público para imágenes y PDF
insert into storage.buckets (id, name, public)
values ('revista', 'revista', true)
on conflict (id) do nothing;
