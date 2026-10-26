-- =====================================================================
-- v0.4.0 : retrait de la lecture des captures (Gemini)
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
drop function if exists public.consume_ocr_quota();
drop function if exists public.match_items(text[]);
drop table if exists public.ocr_usage;
