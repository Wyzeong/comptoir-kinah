-- =====================================================================
-- Recettes : Ebony Dragon Lord Mace et Splendent Ebony Dragon Lord Mace
-- Peut être relancé sans risque : rien n'est créé en double.
-- =====================================================================

-- 1. Objets (bound = true : lié, ni achetable ni revendable)
insert into public.items (name, category, grade, bound) values
  ('Splendent Dark Dragon Lord Mace',      'weapon',    'gold', true),
  ('Ebony Dragon Lord Mace',               'weapon',    'gold', true),
  ('Splendent Ebony Dragon Lord Mace',     'weapon',    'gold', true),
  ('Artisan''s Splendent Orichalcum Mace', 'material',  'gold', false),
  ('Artisan''s Ultimate Refining Stone',   'material',  'gold', false),
  ('Fine Durable Balaur Horn',             'material',  'blue', false),
  ('Wrathful Mind',                        'material',  'gold', false),
  ('Wrathful Will',                        'material',  'gold', false),
  ('Wrathful Ego',                         'material',  'gold', false),
  ('Radiant Orichalcum Ore',               'gathering', 'gold', false),
  ('Radiant Odyle',                        'gathering', 'gold', true)
on conflict on constraint items_name_norm_key do nothing;

-- 2. Recettes (combo de 25 % : l'Ebony peut sortir directement en Splendent Ebony)
insert into public.recipes (output_item_id, output_qty, combo_chance, combo_item_id)
select o.id, 1, 0.25, c.id
from public.items o, public.items c
where o.name_norm = 'ebony dragon lord mace' and c.name_norm = 'splendent ebony dragon lord mace'
on conflict (output_item_id) do update set combo_chance = excluded.combo_chance, combo_item_id = excluded.combo_item_id;

insert into public.recipes (output_item_id, output_qty)
select id, 1 from public.items where name_norm = 'splendent ebony dragon lord mace'
on conflict (output_item_id) do nothing;

-- 3. Composants
insert into public.recipe_components (recipe_id, item_id, qty)
select r.id, i.id, v.qty
from (values
  ('ebony dragon lord mace', 'splendent dark dragon lord mace',      1),
  ('ebony dragon lord mace', 'artisan''s splendent orichalcum mace', 1),
  ('ebony dragon lord mace', 'artisan''s ultimate refining stone',   6),
  ('ebony dragon lord mace', 'fine durable balaur horn',            41),
  ('ebony dragon lord mace', 'wrathful mind',                        3),
  ('ebony dragon lord mace', 'wrathful will',                        3),
  ('ebony dragon lord mace', 'wrathful ego',                        20),
  ('ebony dragon lord mace', 'radiant orichalcum ore',              15),
  ('ebony dragon lord mace', 'radiant odyle',                        9),
  ('splendent ebony dragon lord mace', 'ebony dragon lord mace',             1),
  ('splendent ebony dragon lord mace', 'artisan''s ultimate refining stone', 2),
  ('splendent ebony dragon lord mace', 'fine durable balaur horn',          21),
  ('splendent ebony dragon lord mace', 'wrathful ego',                       7),
  ('splendent ebony dragon lord mace', 'radiant orichalcum ore',             2),
  ('splendent ebony dragon lord mace', 'radiant odyle',                      3)
) as v(output_name, component_name, qty)
join public.items o on o.name_norm = v.output_name
join public.recipes r on r.output_item_id = o.id
join public.items i on i.name_norm = v.component_name
on conflict (recipe_id, item_id) do update set qty = excluded.qty;

-- 4. Ton stock actuel, d'après tes captures (compte admin)
insert into public.inventories (user_id, item_id, qty)
select (select user_id from public.members where role = 'admin' order by joined_at limit 1), i.id, v.qty
from (values
  ('artisan''s ultimate refining stone', 7),
  ('fine durable balaur horn',          65),
  ('wrathful mind',                      1),
  ('wrathful ego',                       6),
  ('radiant odyle',                     10)
) as v(name, qty)
join public.items i on i.name_norm = v.name
on conflict (user_id, item_id) do update set qty = excluded.qty, updated_at = now();
