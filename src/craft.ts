import { supabase } from './supabase';
import { type ItemOverview } from './types';
import { escapeHtml, formatKinah, parseKinah } from './format';
import { ICONS } from './icons';

interface Recipe {
  id: number;
  output_item_id: number;
  output_qty: number;
  combo_chance: number;
  combo_item_id: number | null;
  recipe_components: { item_id: number; qty: number }[];
}

interface Node {
  itemId: number;
  required: number;   // quantité demandée à ce niveau
  fromStock: number;  // prise dans le stock
  rest: number;       // à fabriquer ou à acheter
  mode: 'craft' | 'buy' | 'none'; // none = ni achetable ni craftable (objet lié à fournir)
  crafts: number;
  unit: number | null;
  cost: number;
  children: Node[];
  craftable: boolean;
}

type Mode = 'buy' | 'craft';

export function mountCraft(root: HTMLElement) {
  const items = new Map<number, ItemOverview>();
  const byOutput = new Map<number, Recipe>();
  let recipes: Recipe[] = [];
  let stock = new Map<number, number>();
  let kinah = 0;

  let selected: number | null = null;
  let count = 1;
  let comboPct: number | null = null;
  let tax = 0;
  let plan: 'worst' | 'combo' = 'worst';
  let search = '';
  const modes = new Map<number, Mode>();
  let loadError: string | null = null;

  root.innerHTML = `<div class="craft">
    <aside class="panel recipe-list">
      <h2>Recettes</h2>
      <input type="search" class="search" placeholder="Chercher une recette" aria-label="Chercher une recette" />
      <nav class="recipe-links"></nav>
    </aside>
    <section class="craft-main"></section>
  </div>`;
  const listEl = root.querySelector<HTMLElement>('.recipe-links')!;
  const mainEl = root.querySelector<HTMLElement>('.craft-main')!;
  const searchEl = root.querySelector<HTMLInputElement>('.search')!;

  async function load() {
    const [it, rc, inv, wal] = await Promise.all([
      supabase.from('item_overview').select('*'),
      supabase.from('recipes').select('id, output_item_id, output_qty, combo_chance, combo_item_id, recipe_components(item_id, qty)'),
      supabase.from('inventories').select('item_id, qty'),
      supabase.from('wallets').select('kinah').maybeSingle(),
    ]);
    const err = it.error ?? rc.error ?? inv.error ?? wal.error;
    loadError = err ? err.message : null;
    items.clear();
    for (const i of (it.data ?? []) as ItemOverview[]) items.set(i.id, i);
    recipes = ((rc.data ?? []) as Recipe[]).map((r) => ({ ...r, combo_chance: Number(r.combo_chance) }));
    byOutput.clear();
    for (const r of recipes) byOutput.set(r.output_item_id, r);
    stock = new Map(((inv.data ?? []) as { item_id: number; qty: number }[]).map((s) => [s.item_id, s.qty]));
    kinah = Number(wal.data?.kinah ?? 0);
    if (selected == null || !byOutput.has(selected)) selected = sortedRecipes()[0]?.output_item_id ?? null;
    render();
  }

  const nameOf = (id: number) => items.get(id)?.name ?? `Objet n°${id}`;
  const gradeOf = (id: number) => items.get(id)?.grade ?? 'white';
  const sortedRecipes = () => [...recipes].sort((a, b) => nameOf(a.output_item_id).localeCompare(nameOf(b.output_item_id)));

  function canBuy(id: number) {
    const it = items.get(id);
    return !!it && !it.bound;
  }

  function modeOf(id: number): Mode {
    const chosen = modes.get(id);
    if (chosen) return chosen;
    const it = items.get(id);
    return !it || it.bound || it.current_price == null ? 'craft' : 'buy';
  }

  /** Développe l'arbre de fabrication. pool = stock restant (null = valeur marché, sans stock). */
  function expand(itemId: number, qty: number, pool: Map<number, number> | null, path: number[], force = false): Node {
    const it = items.get(itemId);
    const recipe = byOutput.get(itemId);
    let fromStock = 0;
    if (pool && !force) {
      const have = pool.get(itemId) ?? 0;
      fromStock = Math.min(have, qty);
      pool.set(itemId, have - fromStock);
    }
    const rest = qty - fromStock;
    const craftable = !!recipe && !path.includes(itemId);

    if (craftable && (force || modeOf(itemId) === 'craft')) {
      const crafts = Math.ceil(rest / recipe!.output_qty);
      const children = crafts > 0
        ? recipe!.recipe_components.map((c) => expand(c.item_id, c.qty * crafts, pool, [...path, itemId]))
        : [];
      return { itemId, required: qty, fromStock, rest, mode: 'craft', crafts, unit: null,
        cost: children.reduce((s, c) => s + c.cost, 0), children, craftable };
    }
    const buyable = !!it && !it.bound;
    const unit = buyable ? it!.current_price : null;
    return { itemId, required: qty, fromStock, rest, mode: buyable ? 'buy' : 'none', crafts: 0, unit,
      cost: unit ? unit * rest : 0, children: [], craftable };
  }

  /** Combo applicable à la cible : 'skip' = une recette en amont peut donner directement la cible. */
  function comboContext(targetId: number) {
    const own = byOutput.get(targetId);
    const source = recipes.find((r) => r.combo_item_id === targetId && r.combo_chance > 0
      && own?.recipe_components.some((c) => c.item_id === r.output_item_id));
    if (source) return { kind: 'skip' as const, source };
    if (own && own.combo_item_id && own.combo_chance > 0) return { kind: 'bonus' as const, source: own };
    return null;
  }

  function flatten(n: Node, acc: Map<number, { required: number; fromStock: number; buy: number; missing: number; craft: number; unit: number | null }>, isRoot = true) {
    if (!isRoot) {
      const a = acc.get(n.itemId) ?? { required: 0, fromStock: 0, buy: 0, missing: 0, craft: 0, unit: n.unit };
      a.required += n.required;
      a.fromStock += n.fromStock;
      if (n.mode === 'buy') a.buy += n.rest;
      if (n.mode === 'none') a.missing += n.rest;
      if (n.mode === 'craft') a.craft += n.rest;
      a.unit = n.unit ?? a.unit;
      acc.set(n.itemId, a);
    }
    for (const c of n.children) flatten(c, acc, false);
    return acc;
  }

  function unknownPrices(n: Node): string[] {
    const own = n.mode === 'buy' && n.rest > 0 && n.unit == null ? [nameOf(n.itemId)] : [];
    return [...new Set([...own, ...n.children.flatMap(unknownPrices)])];
  }

  // ---------- Rendu ----------
  function render() {
    const q = search.trim().toLowerCase();
    listEl.innerHTML = sortedRecipes()
      .filter((r) => !q || nameOf(r.output_item_id).toLowerCase().includes(q))
      .map((r) => `<button class="recipe-link grade-${gradeOf(r.output_item_id)}${r.output_item_id === selected ? ' active' : ''}"
          data-action="select" data-id="${r.output_item_id}">${escapeHtml(nameOf(r.output_item_id))}</button>`)
      .join('') || '<p class="muted">Aucune recette.</p>';

    if (loadError) { mainEl.innerHTML = `<p class="error">Chargement impossible : ${escapeHtml(loadError)}</p>`; return; }
    if (selected == null) {
      mainEl.innerHTML = `<div class="panel empty"><p>Aucune recette pour l’instant. Envoie une capture de la fenêtre « Crafting Materials » pour en créer une.</p></div>`;
      return;
    }

    const target = selected;
    const combo = comboContext(target);
    const p = (comboPct ?? (combo ? combo.source.combo_chance * 100 : 0)) / 100;

    // Scénarios : valeur marché (sans stock) et achats réels (avec stock)
    const valueWorst = expand(target, count, null, [], true);
    const buyWorst = expand(target, count, new Map(stock), [], true);
    let valueCombo: Node | null = null;
    let buyCombo: Node | null = null;
    if (combo?.kind === 'skip') {
      valueCombo = expand(combo.source.output_item_id, count, null, [], true);
      buyCombo = expand(combo.source.output_item_id, count, new Map(stock), [], true);
    }
    const expected = valueCombo ? p * valueCombo.cost + (1 - p) * valueWorst.cost : valueWorst.cost;
    const shown = plan === 'combo' && buyCombo ? buyCombo : buyWorst;
    const materials = flatten(shown, new Map());
    const toBuy = shown.cost;
    const missingKinah = Math.max(0, toBuy - kinah);
    const unknown = unknownPrices(valueWorst);

    const it = items.get(target);
    const marketPrice = it && !it.bound ? it.current_price : null;
    const direct = marketPrice != null ? marketPrice * count : null;
    const margin = direct != null ? Math.round(direct * (1 - tax / 100) - expected) : null;

    const card = (label: string, value: string, note = '', cls = '') =>
      `<div class="stat-card ${cls}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;

    const costCards = valueCombo
      ? card('Coût sans combo', `${formatKinah(valueWorst.cost)} k`)
        + card('Coût avec combo', `${formatKinah(valueCombo.cost)} k`)
        + card('Coût moyen attendu', `${formatKinah(Math.round(expected))} k`, `avec ${Math.round(p * 100)} % de combo`, 'highlight')
      : card('Prix de revient', `${formatKinah(valueWorst.cost)} k`, 'valeur marché des composants', 'highlight');

    const tradeCards = direct == null
      ? card('Achat direct', 'Non achetable', it?.bound ? 'objet lié' : 'aucun prix relevé')
      : card('Achat direct', `${formatKinah(direct)} k`)
        + card('Marge si revente', `${margin! >= 0 ? '+' : '−'}${formatKinah(Math.abs(margin!))} k`, tax ? `taxe de ${tax} % déduite` : '', margin! >= 0 ? 'up' : 'down');

    mainEl.innerHTML = `
      <div class="page-head">
        <h1 class="grade-${gradeOf(target)}">${escapeHtml(nameOf(target))}</h1>
      </div>

      <div class="panel settings">
        <label>Quantité à fabriquer <input type="number" min="1" max="999" value="${count}" data-set="count" /></label>
        ${combo ? `<label>Chance de combo (%) <input type="number" min="0" max="100" step="1" value="${Math.round(p * 100)}" data-set="combo" /></label>` : ''}
        <label>Taxe de l’hôtel des ventes (%) <input type="number" min="0" max="50" step="0.5" value="${tax}" data-set="tax" /></label>
      </div>

      ${combo?.kind === 'skip' ? `<p class="combo-note">${ICONS.up}<span>En craftant <strong>${escapeHtml(nameOf(combo.source.output_item_id))}</strong>,
        ${Math.round(p * 100)} % de chance d’obtenir directement cet objet, sans passer par sa recette.</span></p>` : ''}
      ${combo?.kind === 'bonus' ? `<p class="combo-note">${ICONS.up}<span>${Math.round(p * 100)} % de chance d’obtenir directement
        <strong>${escapeHtml(nameOf(combo.source.combo_item_id!))}</strong> à la place.</span></p>` : ''}

      <div class="stat-cards">${costCards}${tradeCards}</div>
      ${unknown.length ? `<p class="warn">Prix inconnu, compté à 0 : ${unknown.map(escapeHtml).join(', ')}. Ajoute un prix depuis la page Marché.</p>` : ''}

      <section class="panel">
        <div class="panel-head"><h2>Arbre de fabrication</h2></div>
        <div class="table-wrap"><table class="tree">
          <thead><tr><th>Composant</th><th class="num">Requis</th><th>Obtention</th><th class="num">Coût marché</th></tr></thead>
          <tbody>${treeRows(valueWorst, 0, true)}</tbody>
        </table></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Ton stock et tes achats</h2>
          ${buyCombo ? `<label class="select-wrap"><span class="sr-only">Scénario</span>
            <select data-set="plan">
              <option value="worst"${plan === 'worst' ? ' selected' : ''}>Prévoir sans combo</option>
              <option value="combo"${plan === 'combo' ? ' selected' : ''}>Prévoir avec combo</option>
            </select>${ICONS.chevron}</label>` : ''}
        </div>
        <div class="table-wrap"><table class="materials">
          <thead><tr><th>Objet</th><th class="num">Requis</th><th class="num">En stock</th><th class="num">À acheter</th>
            <th class="num">Prix unitaire</th><th class="num">Coût</th></tr></thead>
          <tbody>${[...materials.entries()].map(([id, m]) => {
            const have = stock.get(id) ?? 0;
            const buyCell = m.missing > 0
              ? `<span class="trend down">${m.missing} à fournir</span>`
              : m.buy > 0 ? `<strong>${m.buy}</strong>`
              : m.craft > 0 ? `<span class="muted">${m.craft} à crafter</span>` : '<span class="trend up">OK</span>';
            return `<tr>
              <td><span class="item-name grade-${gradeOf(id)}">${escapeHtml(nameOf(id))}</span></td>
              <td class="num">${m.required}</td>
              <td class="num"><input class="stock-input" type="number" min="0" value="${have}" data-stock="${id}" aria-label="Stock de ${escapeHtml(nameOf(id))}" /></td>
              <td class="num">${buyCell}</td>
              <td class="num muted">${m.unit != null ? formatKinah(m.unit) : '—'}</td>
              <td class="num price">${m.buy > 0 && m.unit != null ? formatKinah(m.buy * m.unit) : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        <div class="budget">
          <div><span class="stat-label">Total à acheter</span><span class="stat-value">${formatKinah(toBuy)} k</span></div>
          <label>Tes kinah disponibles <input data-set="kinah" inputmode="numeric" value="${formatKinah(kinah)}" /></label>
          <div><span class="stat-label">Il te manque</span>
            <span class="stat-value ${missingKinah > 0 ? 'down' : 'up'}">${missingKinah > 0 ? `${formatKinah(missingKinah)} k` : 'Rien'}</span></div>
        </div>
      </section>`;
  }

  function treeRows(n: Node, depth: number, isRoot = false): string {
    const label = escapeHtml(nameOf(n.itemId));
    let how: string;
    if (isRoot) how = `Craft ×${n.crafts}`;
    else if (n.craftable) {
      const m = n.mode === 'craft' ? 'craft' : 'buy';
      const buyOk = canBuy(n.itemId);
      how = `<div class="toggle" role="group" aria-label="Acheter ou crafter">
        <button data-action="mode" data-id="${n.itemId}" data-mode="buy" aria-pressed="${m === 'buy'}"${buyOk ? '' : ' disabled'}>Acheter</button>
        <button data-action="mode" data-id="${n.itemId}" data-mode="craft" aria-pressed="${m === 'craft'}">Crafter</button></div>`;
    } else how = n.mode === 'buy' ? 'Achat' : '<span class="muted">À fournir (lié)</span>';
    const cost = n.mode === 'none' ? '—' : n.mode === 'buy' && n.unit == null ? '<span class="warn-inline">prix inconnu</span>' : formatKinah(n.cost);
    return `<tr class="depth-${Math.min(depth, 4)}">
        <td><span class="tree-name" style="--depth:${depth}"><span class="item-name grade-${gradeOf(n.itemId)}">${label}</span></span></td>
        <td class="num">${n.required}</td><td>${how}</td><td class="num price">${cost}</td>
      </tr>${n.children.map((c) => treeRows(c, depth + 1)).join('')}`;
  }

  // ---------- Événements ----------
  searchEl.addEventListener('input', () => { search = searchEl.value; render(); });

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'select') {
      selected = Number(el.dataset.id); comboPct = null; plan = 'worst'; render();
    }
    if (el.dataset.action === 'mode') {
      modes.set(Number(el.dataset.id), el.dataset.mode as Mode); render();
    }
  });

  root.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const set = el.dataset.set;
    if (set === 'count') count = Math.max(1, Math.min(999, Number(el.value) || 1));
    else if (set === 'combo') comboPct = Math.max(0, Math.min(100, Number(el.value) || 0));
    else if (set === 'tax') tax = Math.max(0, Math.min(50, Number(el.value) || 0));
    else if (set === 'plan') plan = el.value as 'worst' | 'combo';
    else if (set === 'kinah') {
      kinah = parseKinah(el.value) ?? 0;
      const { error } = await supabase.from('wallets').upsert({ kinah }, { onConflict: 'user_id' });
      if (error) alert(`Enregistrement des kinah impossible : ${error.message}`);
    } else if (el.dataset.stock) {
      const id = Number(el.dataset.stock);
      const qty = Math.max(0, Math.floor(Number(el.value) || 0));
      stock.set(id, qty);
      const { error } = await supabase.from('inventories').upsert({ item_id: id, qty }, { onConflict: 'user_id,item_id' });
      if (error) alert(`Enregistrement du stock impossible : ${error.message}`);
    } else return;
    render();
  });

  void load();
}
