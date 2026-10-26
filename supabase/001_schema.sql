-- =====================================================================
-- Comptoir du Kinah — schéma v1 (partie 1 : prix de l'hôtel des ventes)
-- À exécuter UNE fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- ---------- Joueurs ----------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table public.members (
  user_id   uuid primary key references public.profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('member', 'admin')),
  joined_at timestamptz not null default now()
);

-- Code d'invitation du groupe (illisible depuis le site : aucune policy)
create table public.app_settings (
  id          int primary key default 1 check (id = 1),
  invite_code text not null
);

-- Profil créé automatiquement à la première connexion Discord
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data -> 'custom_claims' ->> 'global_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1),
      'Joueur'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

create function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'admin');
$$;

-- Rejoindre le groupe avec le code d'invitation
create function public.join_group(code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Non connecté';
  end if;
  if not exists (select 1 from public.app_settings where invite_code = code) then
    return false;
  end if;
  insert into public.members (user_id) values (auth.uid()) on conflict do nothing;
  return true;
end $$;

-- ---------- Objets et relevés de prix ----------
create type public.item_category as enum ('gathering', 'weapon', 'accessory', 'armor', 'material');

create table public.items (
  id         bigint generated always as identity primary key,
  name       text not null check (length(btrim(name)) between 2 and 120),
  name_norm  text generated always as (lower(btrim(name))) stored,
  category   public.item_category not null,
  bound      boolean not null default false,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint items_name_norm_key unique (name_norm)
);

create table public.price_records (
  id          bigint generated always as identity primary key,
  item_id     bigint not null references public.items(id) on delete cascade,
  price       bigint not null check (price > 0),
  recorded_by uuid default auth.uid() references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now()
);

create index price_records_item_time_idx on public.price_records (item_id, recorded_at desc);

-- Vue de synthèse : prix actuel, précédent, stats et historique des 30 derniers relevés
create view public.item_overview with (security_invoker = true) as
select
  i.id, i.name, i.category, i.bound, i.created_at,
  s.current_price, s.previous_price, s.last_recorded_at,
  s.min_price, s.max_price, s.avg_price,
  coalesce(s.history, '[]'::jsonb) as history
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

-- ---------- Sécurité (Row Level Security) ----------
alter table public.profiles      enable row level security;
alter table public.members       enable row level security;
alter table public.app_settings  enable row level security;
alter table public.items         enable row level security;
alter table public.price_records enable row level security;

create policy "profiles: lecture membres" on public.profiles
  for select to authenticated using (public.is_member() or id = auth.uid());
create policy "profiles: modifier le sien" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members: lecture membres" on public.members
  for select to authenticated using (public.is_member());

create policy "items: lecture" on public.items
  for select to authenticated using (public.is_member());
create policy "items: création" on public.items
  for insert to authenticated with check (public.is_member());
create policy "items: modification" on public.items
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "items: suppression admin" on public.items
  for delete to authenticated using (public.is_admin());

create policy "prix: lecture" on public.price_records
  for select to authenticated using (public.is_member());
create policy "prix: ajout à son nom" on public.price_records
  for insert to authenticated with check (public.is_member() and recorded_by = auth.uid());
create policy "prix: suppression des siens ou admin" on public.price_records
  for delete to authenticated using (recorded_by = auth.uid() or public.is_admin());

-- ---------- Droits explicites ----------
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.items, public.price_records to authenticated;
grant select on public.item_overview to authenticated;
grant usage on all sequences in schema public to authenticated;
revoke all on public.app_settings from anon, authenticated;
revoke execute on function public.join_group(text) from public, anon;
grant execute on function public.join_group(text) to authenticated;
