-- =====================================================================
-- v0.7.0 : plus aucun objet lié, chaque objet peut avoir un prix
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
update public.items set bound = false where bound;
