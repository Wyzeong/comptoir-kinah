-- =====================================================================
-- v0.5.0 : recettes de craft, stock et kinah des joueurs
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Une recette par objet fabriqué
create table public.recipes (
  id             bigint generated always as identity primary key,
  output_item_id bigint not null unique references public.items(id) on delete cascade,
  output_qty     int not null default 1 check (output_qty > 0),
  combo_chance   numeric(5,4) not null default 0 check (combo_chance between 0 and 1),
  combo_item_id  bigint references public.items(id) on delete set null, -- objet obtenu directement en cas de combo
  created_by     uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);

create table public.recipe_components (
  recipe_id bigint not null references public.recipes(id) on delete cascade,
  item_id   bigint not null references public.items(id) on delete cascade,
  qty       int not null check (qty > 0),
  primary key (recipe_id, item_id)
);

-- Stock de chaque joueur (visible par lui seul)
create table public.inventories (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  item_id    bigint not null references public.items(id) on delete cascade,
  qty        int not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- Kinah disponibles de chaque joueur (visibles par lui seul)
create table public.wallets (
  user_id    uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  kinah      bigint not null default 0 check (kinah >= 0),
  updated_at timestamptz not null default now()
);

alter table public.recipes           enable row level security;
alter table public.recipe_components enable row level security;
alter table public.inventories       enable row level security;
alter table public.wallets           enable row level security;

create policy "recettes: lecture"      on public.recipes for select to authenticated using (public.is_member());
create policy "recettes: création"     on public.recipes for insert to authenticated with check (public.is_member());
create policy "recettes: modification" on public.recipes for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "recettes: suppression"  on public.recipes for delete to authenticated using (public.is_admin());

create policy "composants: lecture"      on public.recipe_components for select to authenticated using (public.is_member());
create policy "composants: création"     on public.recipe_components for insert to authenticated with check (public.is_member());
create policy "composants: modification" on public.recipe_components for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "composants: suppression"  on public.recipe_components for delete to authenticated using (public.is_member());

create policy "stock: le sien" on public.inventories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());
create policy "kinah: les siens" on public.wallets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member());

grant select, insert, update, delete on public.recipes, public.recipe_components,
  public.inventories, public.wallets to authenticated;
grant usage on all sequences in schema public to authenticated;
