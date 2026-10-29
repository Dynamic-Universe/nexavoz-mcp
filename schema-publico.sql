-- Nexavoz: lectura pública de lo publicado (ejecutar DESPUÉS de schema.sql)

-- Números publicados
drop policy if exists "publico_lee_numeros" on issues;
create policy "publico_lee_numeros" on issues
  for select to anon using (status = 'publicado');

-- Artículos publicados de números publicados
drop policy if exists "publico_lee_articulos" on articles;
create policy "publico_lee_articulos" on articles
  for select to anon using (
    status = 'publicado' and exists (
      select 1 from issues i where i.id = articles.issue_id and i.status = 'publicado'
    )
  );

-- Archivos de números o artículos publicados
drop policy if exists "publico_lee_archivos" on assets;
create policy "publico_lee_archivos" on assets
  for select to anon using (
    exists (select 1 from issues i where i.id = assets.issue_id and i.status = 'publicado')
    or exists (
      select 1 from articles a join issues i on i.id = a.issue_id
      where a.id = assets.article_id and i.status = 'publicado' and a.status = 'publicado'
    )
  );

-- Secciones visibles para todos
drop policy if exists "publico_lee_secciones" on sections;
create policy "publico_lee_secciones" on sections for select to anon using (true);

-- Autores: solo nombre y bio (el email nunca es público)
drop policy if exists "publico_lee_autores" on authors;
create policy "publico_lee_autores" on authors for select to anon using (true);
revoke select on public.authors from anon;
grant select (id, name, bio) on public.authors to anon;
