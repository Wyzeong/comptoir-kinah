-- =====================================================================
-- v0.3.0 : lecture des captures (quota par joueur + rapprochement des noms)
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to authenticated;

-- Compteur d'utilisation de la lecture de captures, par joueur et par jour
create table if not exists public.ocr_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);
alter table public.ocr_usage enable row level security;  -- aucune policy : accès par la fonction seulement

-- Appelée par l'Edge Function avant chaque lecture : renvoie false si non membre ou quota atteint
create or replace function public.consume_ocr_quota()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  max_per_day constant int := 60;
  c int;
begin
  if not public.is_member() then
    return false;
  end if;
  insert into public.ocr_usage (user_id, day, count) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set count = public.ocr_usage.count + 1
  returning count into c;
  return c <= max_per_day;
end $$;

revoke execute on function public.consume_ocr_quota() from public, anon;
grant execute on function public.consume_ocr_quota() to authenticated;

-- Rapproche des noms lus sur une capture des objets connus.
-- Gère les noms tronqués par « … » ou « ... » (recherche par début de nom).
create or replace function public.match_items(names text[])
returns table (idx int, input text, item_id bigint, item_name text, score real)
language sql stable security invoker set search_path = '' as $$
  with inp as (
    select
      t.o::int as idx,
      t.n      as input,
      lower(btrim(regexp_replace(btrim(t.n), '(\.\.\.|…)$', ''))) as q,
      btrim(t.n) ~ '(\.\.\.|…)$' as truncated
    from unnest(names) with ordinality as t(n, o)
  )
  select inp.idx, inp.input, m.id, m.name, m.score
  from inp
  left join lateral (
    select c.id, c.name, c.score from (
      select i.id, i.name,
        case
          when i.name_norm = inp.q then 1.0::real
          when inp.truncated and length(inp.q) >= 3 and left(i.name_norm, length(inp.q)) = inp.q
            then greatest(0.9::real, extensions.similarity(i.name_norm, inp.q))
          else extensions.similarity(i.name_norm, inp.q)
        end as score
      from public.items i
    ) c
    where c.score >= 0.35
    order by c.score desc
    limit 1
  ) m on true
  order by inp.idx;
$$;

grant execute on function public.match_items(text[]) to authenticated;
