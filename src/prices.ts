import { supabase } from './supabase';
import { CATEGORIES, categoryLabel, type CategoryKey, type ItemOverview } from './types';
import { escapeHtml, formatDateTime, formatKinah, parseKinah, sparkline, trendOf } from './format';

type Filter = CategoryKey | 'all';

export function mountPrices(root: HTMLElement, me: { id: string }) {
  let items: ItemOverview[] = [];
  let filter: Filter = 'all';
  let search = '';
  let openId: number | null = null;
  let loadError: string | null = null;

  root.innerHTML = `
    <div class="toolbar">
      <nav class="tabs" aria-label="Catégories"></nav>
      <div class="toolbar-actions">
        <input type="search" class="search" placeholder="Chercher un objet" aria-label="Chercher un objet" />
        <button class="btn primary" data-action="new-item">Ajouter un objet</button>
      </div>
    </div>
    <div class="list"></div>

    <dialog class="dialog" id="new-item-dialog">
      <form class="stack" id="new-item-form">
        <h2>Ajouter un objet</h2>
        <label>Nom exact dans le jeu
          <input name="name" required minlength="2" maxlength="120" autocomplete="off" />
        </label>
        <label>Catégorie
          <select name="category" required>
            ${CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}
          </select>
        </label>
        <label class="check"><input type="checkbox" name="bound" /> Objet lié (Bound) : pas de prix</label>
        <label>Prix actuel (kinah), facultatif
          <input name="price" inputmode="numeric" placeholder="ex. 125 000" autocomplete="off" />
        </label>
        <p class="error" hidden></p>
        <div class="row-end">
          <button type="button" class="btn" data-action="close-dialog">Annuler</button>
          <button type="submit" class="btn primary">Créer l'objet</button>
        </div>
      </form>
    </dialog>`;

  const tabsEl = root.querySelector<HTMLElement>('.tabs')!;
  const listEl = root.querySelector<HTMLElement>('.list')!;
  const searchEl = root.querySelector<HTMLInputElement>('.search')!;
  const dialog = root.querySelector<HTMLDialogElement>('#new-item-dialog')!;
  const newItemForm = root.querySelector<HTMLFormElement>('#new-item-form')!;

  async function load() {
    const { data, error } = await supabase.from('item_overview').select('*').order('name');
    loadError = error ? error.message : null;
    if (data) items = data as ItemOverview[];
    render();
  }

  function render() {
    const counts = new Map<Filter, number>([['all', items.length]]);
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);

    tabsEl.innerHTML = [{ key: 'all' as Filter, label: 'Tout' }, ...CATEGORIES]
      .map((c) => `<button class="tab" aria-pressed="${filter === c.key}" data-action="tab" data-key="${c.key}">
          ${c.label}<span class="count">${counts.get(c.key) ?? 0}</span></button>`)
      .join('');

    const q = search.trim().toLowerCase();
    const visible = items.filter(
      (it) => (filter === 'all' || it.category === filter) && (!q || it.name.toLowerCase().includes(q)),
    );

    if (loadError) {
      listEl.innerHTML = `<p class="error">Impossible de charger les prix : ${escapeHtml(loadError)}</p>`;
      return;
    }
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty">
        <p>${items.length === 0 ? 'Aucun objet pour l’instant.' : 'Aucun objet ne correspond.'}</p>
        <button class="btn primary" data-action="new-item">Ajouter un objet</button></div>`;
      return;
    }

    listEl.innerHTML = `<div class="table-wrap"><table class="prices">
      <thead><tr>
        <th>Objet</th><th class="num">Prix actuel</th><th class="num">Variation</th>
        <th class="num">Min / Moy / Max</th><th>Évolution</th><th>Dernier relevé</th>
      </tr></thead>
      <tbody>${visible.map(rowHtml).join('')}</tbody></table></div>`;
  }

  function rowHtml(it: ItemOverview): string {
    const t = trendOf(it.current_price, it.previous_price);
    const arrow = { up: '▲', down: '▼', flat: '＝', none: '' }[t.dir];
    const trendText =
      t.dir === 'none' ? '<span class="muted">—</span>'
      : t.dir === 'flat' ? '<span class="trend flat">stable</span>'
      : `<span class="trend ${t.dir}" title="Prix en ${t.dir === 'up' ? 'hausse' : 'baisse'}">${arrow} ${Math.abs(t.pct).toFixed(1)} %</span>`;
    const values = [...it.history].reverse().map((h) => h.p);
    const isOpen = openId === it.id;
    const last = it.history[0];

    return `
      <tr class="item-row${isOpen ? ' open' : ''}" data-action="toggle" data-id="${it.id}" tabindex="0" aria-expanded="${isOpen}">
        <td class="name">
          <span>${escapeHtml(it.name)}</span>
          ${filter === 'all' ? `<span class="cat">${categoryLabel(it.category)}</span>` : ''}
          ${it.bound ? '<span class="badge">Bound</span>' : ''}
        </td>
        <td class="num price">${it.bound ? '<span class="muted">non vendable</span>' : formatKinah(it.current_price)}</td>
        <td class="num">${trendText}</td>
        <td class="num muted">${it.min_price == null ? '—'
          : `${formatKinah(it.min_price)} / ${formatKinah(it.avg_price)} / ${formatKinah(it.max_price)}`}</td>
        <td class="spark-cell trend-${t.dir}">${sparkline(values)}</td>
        <td class="muted">${last ? `${formatDateTime(last.t)}<br><small>${escapeHtml(last.by ?? '?')}</small>` : '—'}</td>
      </tr>
      ${isOpen ? `<tr class="detail-row"><td colspan="6">${detailHtml(it)}</td></tr>` : ''}`;
  }

  function detailHtml(it: ItemOverview): string {
    const form = it.bound ? '' : `
      <form class="add-price" data-id="${it.id}">
        <label>Nouveau prix
          <input name="price" inputmode="numeric" placeholder="ex. 125 000" required autocomplete="off" />
        </label>
        <button class="btn primary" type="submit">Enregistrer le prix</button>
        <p class="error" hidden></p>
      </form>`;

    const rows = it.history.map((h, i) => {
      const prev = it.history[i + 1];
      const t = trendOf(h.p, prev?.p ?? null);
      const delta = t.dir === 'up' || t.dir === 'down'
        ? `<span class="trend ${t.dir}">${t.dir === 'up' ? '+' : '−'}${formatKinah(Math.abs(h.p - prev!.p))}</span>` : '';
      const del = h.uid === me.id
        ? `<button class="btn ghost small" data-action="delete-record" data-record="${h.id}" title="Supprimer ce relevé">Supprimer</button>` : '';
      return `<tr><td>${formatDateTime(h.t)}</td><td class="num">${formatKinah(h.p)}</td>
        <td class="num">${delta}</td><td>${escapeHtml(h.by ?? '?')}</td><td class="num">${del}</td></tr>`;
    }).join('');

    return `<div class="detail">
      ${form}
      ${it.history.length
        ? `<h3>Derniers relevés <small class="muted">(${it.history.length} sur 30 max)</small></h3>
           <table class="history"><thead><tr><th>Date</th><th class="num">Prix</th><th class="num">Écart</th><th>Relevé par</th><th></th></tr></thead>
           <tbody>${rows}</tbody></table>`
        : '<p class="muted">Aucun relevé pour cet objet.</p>'}
    </div>`;
  }

  function showError(form: HTMLFormElement, msg: string | null) {
    const p = form.querySelector<HTMLElement>('.error')!;
    p.hidden = !msg;
    p.textContent = msg ?? '';
  }

  // ---------- Événements ----------
  searchEl.addEventListener('input', () => { search = searchEl.value; render(); });

  root.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el || (e.target as HTMLElement).closest('form.add-price')) return;
    switch (el.dataset.action) {
      case 'tab':
        filter = el.dataset.key as Filter; render(); break;
      case 'toggle': {
        const id = Number(el.dataset.id);
        openId = openId === id ? null : id; render();
        if (openId) listEl.querySelector<HTMLInputElement>('form.add-price input')?.focus();
        break;
      }
      case 'new-item':
        newItemForm.reset(); showError(newItemForm, null); dialog.showModal(); break;
      case 'close-dialog':
        dialog.close(); break;
      case 'delete-record': {
        e.stopPropagation();
        if (!confirm('Supprimer ce relevé de prix ?')) return;
        const { error } = await supabase.from('price_records').delete().eq('id', Number(el.dataset.record));
        if (error) alert(`Suppression impossible : ${error.message}`);
        await load();
        break;
      }
    }
  });

  root.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr.item-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target as HTMLFormElement;
    e.preventDefault();

    if (form.classList.contains('add-price')) {
      const price = parseKinah(new FormData(form).get('price') as string);
      if (!price) return showError(form, 'Entre un prix en kinah, chiffres uniquement.');
      const { error } = await supabase.from('price_records').insert({ item_id: Number(form.dataset.id), price });
      if (error) return showError(form, `Enregistrement impossible : ${error.message}`);
      await load();
      return;
    }

    if (form === newItemForm) {
      const fd = new FormData(form);
      const name = (fd.get('name') as string).trim().replace(/\s+/g, ' ');
      const bound = fd.get('bound') === 'on';
      const rawPrice = (fd.get('price') as string).trim();
      const price = rawPrice ? parseKinah(rawPrice) : null;
      if (rawPrice && !price) return showError(form, 'Le prix doit être un nombre de kinah.');

      const { data, error } = await supabase.from('items')
        .insert({ name, category: fd.get('category'), bound }).select('id').single();
      if (error) {
        return showError(form, error.code === '23505' ? 'Cet objet existe déjà.' : `Création impossible : ${error.message}`);
      }
      if (price && !bound) {
        const r = await supabase.from('price_records').insert({ item_id: data.id, price });
        if (r.error) alert(`Objet créé, mais le prix n’a pas été enregistré : ${r.error.message}`);
      }
      dialog.close();
      openId = data.id;
      await load();
    }
  });

  void load();
}
