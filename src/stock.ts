import { supabase } from './supabase';
import { CATEGORIES, GRADES, categoryLabel, type ItemOverview } from './types';
import { escapeHtml, formatKinah, parseKinah } from './format';
import { ICONS } from './icons';

export function mountStock(root: HTMLElement, me: { id: string }) {
  const items = new Map<number, ItemOverview>();
  let members: { id: string; display_name: string }[] = [];
  let rows: { item_id: number; qty: number }[] = [];
  let viewing = me.id;
  let kinah = 0;
  let search = '';
  let loadError: string | null = null;

  root.innerHTML = `
    <div class="page-head">
      <h1>Stock</h1>
      <label class="select-wrap"><span class="sr-only">Stock de</span>
        <select class="viewer"></select>${ICONS.chevron}</label>
    </div>
    <div class="stock-layout">
      <section class="panel">
        <div class="panel-head">
          <h2 class="stock-title"></h2>
          <input type="search" class="search" placeholder="Chercher dans le stock" aria-label="Chercher dans le stock" />
        </div>
        <div class="stock-list"></div>
      </section>
      <aside class="panel side stock-side"></aside>
    </div>`;

  const viewerEl = root.querySelector<HTMLSelectElement>('.viewer')!;
  const titleEl = root.querySelector<HTMLElement>('.stock-title')!;
  const listEl = root.querySelector<HTMLElement>('.stock-list')!;
  const sideEl = root.querySelector<HTMLElement>('.stock-side')!;
  const searchEl = root.querySelector<HTMLInputElement>('.search')!;

  async function load() {
    const [it, mb, inv, wal] = await Promise.all([
      supabase.from('item_overview').select('*').order('name'),
      supabase.from('members').select('user_id, profiles(display_name)'),
      supabase.from('inventories').select('item_id, qty').eq('user_id', viewing),
      supabase.from('wallets').select('kinah').maybeSingle(),
    ]);
    const err = it.error ?? mb.error ?? inv.error ?? wal.error;
    loadError = err ? err.message : null;
    items.clear();
    for (const i of (it.data ?? []) as ItemOverview[]) items.set(i.id, i);
    members = ((mb.data ?? []) as unknown as { user_id: string; profiles: { display_name: string } | null }[])
      .map((m) => ({ id: m.user_id, display_name: m.profiles?.display_name ?? '?' }))
      .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.display_name.localeCompare(b.display_name)));
    rows = ((inv.data ?? []) as typeof rows).filter((r) => r.qty > 0);
    kinah = Number(wal.data?.kinah ?? 0);
    render();
  }

  const mine = () => viewing === me.id;
  const nameOf = (id: number) => items.get(id)?.name ?? `Objet n°${id}`;

  function render() {
    viewerEl.innerHTML = members.map((m) =>
      `<option value="${m.id}"${m.id === viewing ? ' selected' : ''}>${m.id === me.id ? 'Mon stock' : `Stock de ${escapeHtml(m.display_name)}`}</option>`).join('');
    titleEl.textContent = mine() ? 'Mes objets' : `Objets de ${members.find((m) => m.id === viewing)?.display_name ?? '?'}`;

    sideEl.innerHTML = mine() ? `
      <h2>Ajouter au stock</h2>
      <form class="stack add-stock" autocomplete="off">
        <label>Objet <input name="item" list="stock-items" required placeholder="Nom exact dans le jeu" /></label>
        <datalist id="stock-items">${[...items.values()].map((i) => `<option value="${escapeHtml(i.name)}"></option>`).join('')}</datalist>
        <div class="new-item-fields stack" hidden>
          <p class="muted">Cet objet n’existe pas encore : il sera créé.</p>
          <label>Catégorie <select name="category"><option value="">Choisir…</option>
            ${CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}</select></label>
          <label>Rareté <select name="grade">${GRADES.map((g) => `<option value="${g.key}">${g.label}</option>`).join('')}</select></label>
        </div>
        <label>Quantité possédée <input name="qty" type="number" min="1" required value="1" /></label>
        <button class="btn cyan" type="submit">Ajouter au stock</button>
        <p class="error" hidden></p>
      </form>
      <label class="kinah-field">Mes kinah disponibles
        <input data-kinah inputmode="numeric" value="${formatKinah(kinah)}" /></label>`
      : `<h2>Lecture seule</h2><p class="muted">Tu consultes le stock d’un coéquipier. Seul lui peut le modifier.</p>`;

    if (loadError) { listEl.innerHTML = `<p class="error pad">Chargement impossible : ${escapeHtml(loadError)}</p>`; return; }

    const q = search.trim().toLowerCase();
    const visible = rows
      .filter((r) => !q || nameOf(r.item_id).toLowerCase().includes(q))
      .sort((a, b) => nameOf(a.item_id).localeCompare(nameOf(b.item_id)));
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty"><p>${rows.length === 0
        ? (mine() ? 'Ton stock est vide. Ajoute un objet avec le formulaire.' : 'Ce stock est vide.')
        : 'Aucun objet ne correspond.'}</p></div>`;
      return;
    }

    let total = 0;
    const body = visible.map((r) => {
      const it = items.get(r.item_id);
      const value = it && it.current_price != null ? it.current_price * r.qty : null;
      if (value) total += value;
      return `<tr>
        <td><div class="item"><span class="item-icon grade-${it?.grade ?? 'white'}">${ICONS[it?.category ?? 'material']}</span>
          <span class="item-name grade-${it?.grade ?? 'white'}">${escapeHtml(nameOf(r.item_id))}</span></div></td>
        <td class="muted">${it ? categoryLabel(it.category) : ''}</td>
        <td class="num">${mine()
          ? `<input class="stock-input" type="number" min="0" value="${r.qty}" data-qty="${r.item_id}" aria-label="Quantité de ${escapeHtml(nameOf(r.item_id))}" />`
          : r.qty}</td>
        <td class="num price">${value != null ? `${formatKinah(value)} k` : '<span class="muted">—</span>'}</td>
        <td class="num">${mine() ? `<button class="btn ghost small" data-remove="${r.item_id}">Retirer</button>` : ''}</td>
      </tr>`;
    }).join('');

    listEl.innerHTML = `<div class="table-wrap"><table class="stock-table">
      <thead><tr><th>Objet</th><th>Catégorie</th><th class="num">Quantité</th><th class="num">Valeur marché</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>
      <div class="budget"><div><span class="stat-label">Valeur totale du stock</span><span class="stat-value">${formatKinah(total)} k</span></div></div>`;
  }

  async function setQty(itemId: number, qty: number) {
    const { error } = qty > 0
      ? await supabase.from('inventories').upsert({ item_id: itemId, qty, updated_at: new Date().toISOString() }, { onConflict: 'user_id,item_id' })
      : await supabase.from('inventories').delete().eq('user_id', me.id).eq('item_id', itemId);
    if (error) alert(`Enregistrement du stock impossible : ${error.message}`);
  }

  // ---------- Événements ----------
  viewerEl.addEventListener('change', () => { viewing = viewerEl.value; search = ''; searchEl.value = ''; void load(); });
  searchEl.addEventListener('input', () => { search = searchEl.value; render(); });

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.name !== 'item') return;
    const known = [...items.values()].some((i) => i.name.toLowerCase() === el.value.trim().toLowerCase());
    root.querySelector<HTMLElement>('.new-item-fields')!.hidden = known || el.value.trim().length < 2;
  });

  root.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.qty) {
      await setQty(Number(el.dataset.qty), Math.max(0, Math.floor(Number(el.value) || 0)));
      await load();
    } else if (el.matches('[data-kinah]')) {
      kinah = parseKinah(el.value) ?? 0;
      const { error } = await supabase.from('wallets').upsert({ kinah, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) alert(`Enregistrement des kinah impossible : ${error.message}`);
      el.value = formatKinah(kinah);
    }
  });

  root.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (!btn) return;
    if (!confirm(`Retirer ${nameOf(Number(btn.dataset.remove))} du stock ?`)) return;
    await setQty(Number(btn.dataset.remove), 0);
    await load();
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target as HTMLFormElement;
    if (!form.classList.contains('add-stock')) return;
    e.preventDefault();
    const fd = new FormData(form);
    const err = form.querySelector<HTMLElement>('.error')!;
    const fail = (m: string) => { err.hidden = false; err.textContent = m; };
    err.hidden = true;

    const name = (fd.get('item') as string).trim().replace(/\s+/g, ' ');
    const qty = Math.floor(Number(fd.get('qty')) || 0);
    if (qty < 1) return fail('Indique une quantité d’au moins 1.');
    let item = [...items.values()].find((i) => i.name.toLowerCase() === name.toLowerCase());
    let itemId = item?.id;
    if (!itemId) {
      if (!fd.get('category')) return fail('Choisis une catégorie pour créer cet objet.');
      const { data, error } = await supabase.from('items')
        .insert({ name, category: fd.get('category'), grade: fd.get('grade') })
        .select('id').single();
      if (error) return fail(`Création de l’objet impossible : ${error.message}`);
      itemId = data.id;
    }
    const current = rows.find((r) => r.item_id === itemId)?.qty ?? 0;
    await setQty(itemId!, current + qty);
    await load();
    root.querySelector<HTMLInputElement>('.add-stock input[name=item]')?.focus();
  });

  void load();
}
