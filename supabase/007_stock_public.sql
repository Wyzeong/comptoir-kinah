-- =====================================================================
-- v0.6.0 : le stock de chacun devient visible par tout le groupe
-- (chacun ne peut toujours modifier que le sien). Les kinah restent privés.
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================
drop policy if exists "stock: le sien" on public.inventories;

create policy "stock: lecture par le groupe" on public.inventories
  for select to authenticated using (public.is_member());
create policy "stock: ajout du sien" on public.inventories
  for insert to authenticated with check (user_id = auth.uid() and public.is_member());
create policy "stock: modification du sien" on public.inventories
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "stock: suppression du sien" on public.inventories
  for delete to authenticated using (user_id = auth.uid());
