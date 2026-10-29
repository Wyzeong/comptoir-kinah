-- =====================================================================
-- v0.14.0 : ordre des recettes, partagé par tout le groupe
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.recipes add column if not exists sort_order int;

-- Enregistre l'ordre d'une liste de recettes (1, 2, 3… dans l'ordre des ids reçus)
create or replace function public.reorder_recipes(ids bigint[])
returns void language sql security invoker set search_path = '' as $$
  update public.recipes r set sort_order = t.o
  from unnest(ids) with ordinality as t(id, o)
  where r.id = t.id;
$$;

revoke execute on function public.reorder_recipes(bigint[]) from public, anon;
grant execute on function public.reorder_recipes(bigint[]) to authenticated;
