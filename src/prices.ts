import { supabase } from './supabase';
import { CATEGORIES, GRADES, categoryLabel, type CategoryKey, type ItemOverview } from './types';
import { escapeHtml, formatDateTime, formatKinah, parseKinah, sparkline, trendOf } from './format';
import { ICONS } from './icons';

type Filter = CategoryKey | 'all';
const PERIODS = [
  { days: 7, label: '7 derniers jours' },
  { days: 30, label: '30 derniers jours' },
  { days: 0, label: 'Tout l’historique' },
];

const gradeOptions = (selected = 'white') =>
  GRADES.map((g) => `<option value="${g.key}"${g.key === selected ? ' selected' : ''}>${g.label}</option>`).join('');

export function mountPrices(root: HTMLElement, me: { id: string }) {
  let items: ItemOverview[] = [];
  let filter: Filter = 'all';
  let search = '';
  let periodDays = 30;
  let openId: number | null = null;
  let loadError: string | null = null;

  root.innerHTML = `
    <div class="market">
      <div class="market-main">
        <div class="page-head">
          <h1>Vue du marché</h1>
          <label class="select-wrap">
            <span class="sr-only">Période de la courbe</span>
            <select class="period">${PERIODS.map((p) =>
              `<option value="${p.days}"${p.days === periodDays ? ' selected' : ''}>${p.label}</option>`).join('')}</select>
            ${ICONS.chevron}
          </label>
        </div>
        <div class="cat-cards" role="group" aria-label="Catégories"></div>

        <section class="panel">
          <div class="panel-head">
            <h2 class="market-title"></h2>
            <div class="panel-actions">
              <input type="search" class="search" placeholder="Chercher un objet" aria-label="Chercher un objet" />
              <button class="btn primary" data-action="new-item">Ajouter un objet</button>
            </div>
          </div>
          <div class="list"></div>
        </section>
      </div>

      <aside class="panel side">
        <h2>Mettre à jour par capture</h2>
        <p class="muted">Envoie une capture de l’hôtel des ventes : les prix détectés seront proposés à la validation.</p>
        <div class="dropzone" aria-disabled="true">
          ${ICONS.upload}
          <span>Glisse une capture ici</span>
        </div>
        <button class="btn cyan" disabled>Envoyer une capture</button>
        <p class="soon">Disponible dans la prochaine version.</p>
      </aside>
    </div>

    <dialog class="dialog" id="new-item-dialog">
      <form class="stack" id="new-item-form">
        <h2>Ajouter un objet</h2>
        <label>Nom exact dans le jeu
          <input name="name" required minlength="2" maxlength="120" autocomplete="off" />
        </label>
        <div class="two-cols">
          <label>Catégorie
            <select name="category" required>
              ${CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}
            </select>
          </label>
          <label>Rareté
            <select name="grade">${gradeOptions()}</select>
          </label>
        </div>
        <label class="check"><input type="checkbox" name="bound" /> Objet lié (Bound) : pas de prix</label>
        <label>Prix actuel (kinah), facultatif
          <input name="price" inputmode="numeric" placeholder="ex. 125 000" autocomplete="off" />
        </label>
        <p class="error" hidden></p>
        <div class="row-end">
          <button type="button" class="btn ghost" data-action="close-dialog">Annuler</button>
          <button type="submit" class="btn primary">Créer l’objet</button>
        </div>
      </form>
    </dialog>`;

  const cardsEl = root.querySelector<HTMLElement>('.cat-cards')!;
  const titleEl = root.querySelector<HTMLElement>('.market-title')!;
  const listEl = root.querySelector<HTMLElement>('.list')!;
  const searchEl = root.querySelector<HTMLInputElement>('.search')!;
  const periodEl = root.querySelector<HTMLSelectElement>('.period')!;
  const dialog = root.querySelector<HTMLDialogElement>('#new-item-dialog')!;
  const newItemForm = root.querySelector<HTMLFormElement>('#new-item-form')!;

  async function load() {
    const { data, error } = await supabase.from('item_overview').select('*').order('name');
    loadError = error ? error.message : null;
    if (data) items = data as ItemOverview[];
    render();
  }

  function render() {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);

    cardsEl.innerHTML = CATEGORIES.map((c) => {
      const active = filter === c.key;
      const n = counts.get(c.key) ?? 0;
      return `<button class="cat-card${active ? ' active' : ''}" aria-pressed="${active}" data-action="tab" data-key="${c.key}">
        ${active ? '<span class="active-badge">Actif</span>' : ''}
        ${ICONS[c.key]}
        <span class="cat-name">${c.label}</span>
        <span class="cat-count">${n} objet${n > 1 ? 's' : ''}</span>
      </button>`;
    }).join('');

    titleEl.textContent = filter === 'all' ? 'Tout le marché' : `Marché : ${categoryLabel(filter)}`;

    const q = search.trim().toLowerCase();
    const visible = items.filter(
      (it) => (filter === 'all' || it.category === filter) && (!q || it.name.toLowerCase().includes(q)),
    );

    if (loadError) {
      listEl.innerHTML = `<p class="error pad">Impossible de charger les prix : ${escapeHtml(loadError)}</p>`;
      return;
    }
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty">
        <p>${items.length === 0 ? 'Aucun objet pour l’instant. Ajoute le premier pour commencer le suivi.'
          : 'Aucun objet ne correspond à ta recherche.'}</p>
        <button class="btn primary" data-action="new-item">Ajouter un objet</button></div>`;
      return;
    }

    listEl.innerHTML = `<div class="table-wrap"><table class="prices">
      <thead><tr>
        <th>Objet</th><th>Catégorie</th><th class="num">Prix actuel<span class="sub">en kinah</span></th>
        <th>Tendance</th><th>Historique</th><th class="center">Détails</th>
      </tr></thead>
      <tbody>${visible.map(rowHtml).join('')}</tbody></table></div>`;
  }

  function periodValues(it: ItemOverview): number[] {
    const since = periodDays ? Date.now() - periodDays * 86_400_000 : 0;
    return it.history.filter((h) => new Date(h.t).getTime() >= since).reverse().map((h) => h.p);
  }

  function rowHtml(it: ItemOverview): string {
    const t = trendOf(it.current_price, it.previous_price);
    const trend =
      t.dir === 'none' ? '<span class="muted">—</span>'
      : t.dir === 'flat' ? '<span class="trend flat">Stable</span>'
      : `<span class="trend ${t.dir}">${t.dir === 'up' ? ICONS.up : ICONS.down}
          <span><span class="trend-word">${t.dir === 'up' ? 'Hausse' : 'Baisse'}</span>
          <span class="trend-pct">${Math.abs(t.pct).toFixed(1)} %</span></span></span>`;
    const isOpen = openId === it.id;

    return `
      <tr class="item-row${isOpen ? ' open' : ''}" data-action="toggle" data-id="${it.id}" tabindex="0" aria-expanded="${isOpen}">
        <td>
          <div class="item">
            <span class="item-icon grade-${it.grade}">${ICONS[it.category]}</span>
            <span class="item-name grade-${it.grade}">[${escapeHtml(it.name)}]</span>
            ${it.bound ? '<span class="badge">Bound</span>' : ''}
          </div>
        </td>
        <td class="muted">${categoryLabel(it.category)}</td>
        <td class="num price">${it.bound ? '<span class="muted">non vendable</span>'
          : it.current_price == null ? '<span class="muted">—</span>' : `${formatKinah(it.current_price)} kinah`}</td>
        <td>${trend}</td>
        <td class="spark-cell trend-${t.dir}">${sparkline(periodValues(it), `sp${it.id}`)}</td>
        <td class="center"><span class="stats-btn" title="Voir les détails">${ICONS.stats}</span></td>
      </tr>
      ${isOpen ? `<tr class="detail-row"><td colspan="6">${detailHtml(it)}</td></tr>` : ''}`;
  }

  function detailHtml(it: ItemOverview): string {
    const stats = it.min_price == null ? '' : `
      <dl class="stats">
        <div><dt>Min</dt><dd>${formatKinah(it.min_price)}</dd></div>
        <div><dt>Moyenne</dt><dd>${formatKinah(it.avg_price)}</dd></div>
        <div><dt>Max</dt><dd>${formatKinah(it.max_price)}</dd></div>
        <div><dt>Relevés</dt><dd>${it.history.length}<small> / 30</small></dd></div>
      </dl>`;

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
        ? `<button class="btn ghost small" data-action="delete-record" data-record="${h.id}">Supprimer</button>` : '';
      return `<tr><td>${formatDateTime(h.t)}</td><td class="num">${formatKinah(h.p)}</td>
        <td class="num">${delta}</td><td>${escapeHtml(h.by ?? '?')}</td><td class="num">${del}</td></tr>`;
    }).join('');

    return `<div class="detail">
      <div class="detail-top">
        ${stats}
        <label class="grade-edit">Rareté
          <select data-grade-for="${it.id}">${gradeOptions(it.grade)}</select>
        </label>
      </div>
      ${form}
      ${it.history.length
        ? `<div class="history-wrap"><table class="history"><thead><tr><th>Date</th><th class="num">Prix</th><th class="num">Écart</th><th>Relevé par</th><th></th></tr></thead>
           <tbody>${rows}</tbody></table></div>`
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
  periodEl.addEventListener('change', () => { periodDays = Number(periodEl.value); render(); });

  root.addEventListener('change', async (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-grade-for]');
    if (!sel) return;
    const { error } = await supabase.from('items').update({ grade: sel.value }).eq('id', Number(sel.dataset.gradeFor));
    if (error) alert(`Modification impossible : ${error.message}`);
    await load();
  });

  root.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.detail-row select, .detail-row input')) return;
    const el = target.closest<HTMLElement>('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'tab': {
        const key = el.dataset.key as CategoryKey;
        filter = filter === key ? 'all' : key; // recliquer sur la carte active réaffiche tout
        render();
        break;
      }
      case 'toggle': {
        const id = Number(el.dataset.id);
        openId = openId === id ? null : id;
        render();
        if (openId) listEl.querySelector<HTMLInputElement>('form.add-price input')?.focus();
        break;
      }
      case 'new-item':
        newItemForm.reset(); showError(newItemForm, null); dialog.showModal(); break;
      case 'close-dialog':
        dialog.close(); break;
      case 'delete-record': {
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
        .insert({ name, category: fd.get('category'), grade: fd.get('grade'), bound }).select('id').single();
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
