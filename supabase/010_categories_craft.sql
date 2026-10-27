-- =====================================================================
-- v0.10.0 : recettes rangées comme dans le jeu (métier > sous-catégorie)
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
alter table public.recipes
  add column if not exists craft_type text
  check (craft_type in (
    'greatsword', 'longsword', 'dagger', 'mace', 'guard',                         -- Blacksmithing
    'helm', 'pauldrons', 'top', 'legs', 'gloves', 'shoes', 'cloak',               -- Armorsmithing
    'bow', 'staff', 'necklace', 'earrings', 'ring', 'bracelet',                   -- Handicrafting
    'spellbook', 'orb', 'potion', 'scroll', 'manastone'                           -- Alchemy
  ));

-- Reprise de l'ancien classement par type d'arme
update public.recipes set craft_type = case weapon_type
    when 'greatsword'   then 'greatsword'
    when 'sword_shield' then 'longsword'
    when 'mace_shield'  then 'mace'
    when 'daggers'      then 'dagger'
    else weapon_type
  end
where craft_type is null and weapon_type is not null;

alter table public.recipes drop column if exists weapon_type;
