-- Nexavoz: campos para titulares, resúmenes y SEO (ejecutar después de schema.sql)
alter table articles
  add column if not exists summary text,
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists keywords text[] not null default '{}',
  add column if not exists headline_options text[] not null default '{}';

alter table issues
  add column if not exists seo_description text;
