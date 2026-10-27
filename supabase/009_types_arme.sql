-- =====================================================================
-- v0.9.0 : type d'arme sur les recettes
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.recipes
  add column if not exists weapon_type text
  check (weapon_type in ('greatsword', 'sword_shield', 'mace_shield', 'spellbook', 'orb', 'staff', 'bow', 'daggers'));

-- Classement des recettes existantes d'après le nom de l'objet fabriqué
update public.recipes r
set weapon_type = case
    when i.name_norm like '%greatsword%' then 'greatsword'
    when i.name_norm like '%mace%'       then 'mace_shield'
    when i.name_norm like '%sword%'      then 'sword_shield'
    when i.name_norm like '%spellbook%'  then 'spellbook'
    when i.name_norm like '%orb%'        then 'orb'
    when i.name_norm like '%staff%'      then 'staff'
    when i.name_norm like '%bow%'        then 'bow'
    when i.name_norm like '%dagger%'     then 'daggers'
  end
from public.items i
where i.id = r.output_item_id and r.weapon_type is null;
