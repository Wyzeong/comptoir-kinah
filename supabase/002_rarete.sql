-- =====================================================================
-- v0.2.0 : couleur de rareté des objets
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.items
  add column if not exists grade text not null default 'white'
  check (grade in ('white', 'green', 'blue', 'gold', 'orange', 'purple'));

-- On recrée la vue en ajoutant la colonne grade à la fin
create or replace view public.item_overview with (security_invoker = true) as
select
  i.id, i.name, i.category, i.bound, i.created_at,
  s.current_price, s.previous_price, s.last_recorded_at,
  s.min_price, s.max_price, s.avg_price,
  coalesce(s.history, '[]'::jsonb) as history,
  i.grade
from public.items i
left join lateral (
  select
    (array_agg(r.price order by r.recorded_at desc))[1] as current_price,
    (array_agg(r.price order by r.recorded_at desc))[2] as previous_price,
    max(r.recorded_at)                                 as last_recorded_at,
    min(r.price)                                       as min_price,
    max(r.price)                                       as max_price,
    round(avg(r.price))::bigint                        as avg_price,
    jsonb_agg(
      jsonb_build_object('id', r.id, 'p', r.price, 't', r.recorded_at,
                         'uid', r.recorded_by, 'by', p.display_name)
      order by r.recorded_at desc
    ) as history
  from (
    select * from public.price_records pr
    where pr.item_id = i.id
    order by pr.recorded_at desc
    limit 30
  ) r
  left join public.profiles p on p.id = r.recorded_by
) s on true;
