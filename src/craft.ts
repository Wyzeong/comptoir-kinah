import { supabase } from './supabase';
import { WEAPON_TYPES, type ItemOverview, type WeaponTypeKey } from './types';
import { escapeHtml, formatKinah, parseKinah } from './format';
import { ICONS } from './icons';
import { openRecipeEditor, type RecipeDraft } from './recipe-editor';

interface Recipe {
  id: number;
  output_item_id: number;
  output_qty: number;
  combo_chance: number;
  combo_item_id: number | null;
  weapon_type: WeaponTypeKey | null;
  recipe_components: { item_id: number; qty: number }[];
}

interface Node {
  itemId: number;
  required: number;
  fromStock: number;
  rest: number;
  mode: 'craft' | 'buy' | 'none';
  crafts: number;
  unit: number | null;
  cost: number;
  children: Node[];
  craftable: boolean;
  viaCombo: boolean; // obtenu par le combo de son premier enfant (étape « Splendent » sautée)
}

type Mode = 'buy' | 'craft';
type Scenario = 'never' | 'always';

export function mountCraft(root: HTMLElement, me: { id: string }) {
  const items = new Map<number, ItemOverview>();
  const byOutput = new Map<number, Recipe>();
  let recipes: Recipe[] = [];
  let stock = new Map<number, number>();
  let kinah = 0;

  let selected: number | null = null;
  let count = 1;
  let comboPct: number | null = null; // réglage de la page, appliqué à tous les combos de l'arbre
  let tax = 0;
  let plan: Scenario = 'never';
  let search = '';
  const modes = new Map<number, Mode>();
  let loadError: string | null = null;

  root.innerHTML = `<div class="craft">
    <aside class="panel recipe-list">
      <h2>Recettes</h2>
      <button class="btn primary" data-action="new">Nouvelle recette</button>
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
      supabase.from('recipes').select('id, output_item_id, output_qty, combo_chance, combo_item_id, weapon_type, recipe_components(item_id, qty)'),
      supabase.from('inventories').select('item_id, qty').eq('user_id', me.id),
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
  const chance = (r: Recipe) => (comboPct ?? r.combo_chance * 100) / 100;

  function modeOf(id: number): Mode {
    const chosen = modes.get(id);
    if (chosen) return chosen;
    return items.get(id)?.current_price == null ? 'craft' : 'buy';
  }

  /** Recette X dont le combo donne directement `itemId`, si X est un composant de la recette de `itemId` et qu'on crafte X. */
  function comboSource(itemId: number, path: number[]): Recipe | null {
    const own = byOutput.get(itemId);
    if (!own) return null;
    const src = recipes.find((r) => r.combo_item_id === itemId && r.combo_chance > 0
      && own.recipe_components.some((c) => c.item_id === r.output_item_id));
    if (!src || path.includes(src.output_item_id) || modeOf(src.output_item_id) === 'buy') return null;
    return src;
  }

  /** Développe l'arbre. pool = stock restant (null = valeur marché sans stock). */
  function expand(itemId: number, qty: number, pool: Map<number, number> | null, path: number[], scen: Scenario, force = false): Node {
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
    const base = { itemId, required: qty, fromStock, rest, craftable, viaCombo: false };

    if (craftable && (force || modeOf(itemId) === 'craft')) {
      const crafts = Math.ceil(rest / recipe!.output_qty);
      const sub = [...path, itemId];
      const src = scen === 'always' ? comboSource(itemId, path) : null;
      let children: Node[] = [];
      if (crafts > 0 && src) {
        // Combo réussi : on crafte X et on obtient directement cet objet, sa propre recette est sautée
        children = [expand(src.output_item_id, crafts, pool, sub, scen, true)];
      } else if (crafts > 0) {
        children = recipe!.recipe_components.map((c) => expand(c.item_id, c.qty * crafts, pool, sub, scen));
      }
      return { ...base, mode: 'craft', crafts, unit: null, cost: children.reduce((s, c) => s + c.cost, 0), children, viaCombo: !!src };
    }
    const unit = it ? it.current_price : null;
    return { ...base, mode: it ? 'buy' : 'none', crafts: 0, unit, cost: unit ? unit * rest : 0, children: [] };
  }

  /** Coût moyen attendu (valeur marché) : à chaque étape sautable, combo avec sa probabilité. */
  function expectedCost(itemId: number, qty: number, path: number[], force = false): number {
    const it = items.get(itemId);
    const recipe = byOutput.get(itemId);
    const craftable = !!recipe && !path.includes(itemId);
    if (!(craftable && (force || modeOf(itemId) === 'craft'))) return (it?.current_price ?? 0) * qty;
    const crafts = Math.ceil(qty / recipe!.output_qty);
    const sub = [...path, itemId];
    const src = comboSource(itemId, path);
    if (!src) return recipe!.recipe_components.reduce((s, c) => s + expectedCost(c.item_id, c.qty * crafts, sub), 0);
    const viaX = expectedCost(src.output_item_id, crafts, sub, true);
    const others = recipe!.recipe_components
      .filter((c) => c.item_id !== src.output_item_id)
      .reduce((s, c) => s + expectedCost(c.item_id, c.qty * crafts, sub), 0);
    return viaX + (1 - chance(src)) * others;
  }

  function countCombos(n: Node): number {
    return (n.viaCombo ? 1 : 0) + n.children.reduce((s, c) => s + countCombos(c), 0);
  }

  function flatten(n: Node, acc: Map<number, { buy: number; missing: number; unit: number | null }>, isRoot = true) {
    if (!isRoot && n.rest > 0 && (n.mode === 'buy' || n.mode === 'none')) {
      const a = acc.get(n.itemId) ?? { buy: 0, missing: 0, unit: n.unit };
      if (n.mode === 'buy') a.buy += n.rest; else a.missing += n.rest;
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
    const shownRecipes = sortedRecipes().filter((r) => !q || nameOf(r.output_item_id).toLowerCase().includes(q));
    const link = (r: Recipe) => `<button class="recipe-link grade-${gradeOf(r.output_item_id)}${r.output_item_id === selected ? ' active' : ''}"
          data-action="select" data-id="${r.output_item_id}">${escapeHtml(nameOf(r.output_item_id))}
          ${r.combo_chance > 0 ? `<span class="combo-tag">combo ${Math.round(r.combo_chance * 100)} %</span>` : ''}</button>`;
    const groups = [...WEAPON_TYPES.map((w) => ({ key: w.key as string, label: w.label })), { key: '', label: 'Autres' }]
      .map((g) => ({ ...g, list: shownRecipes.filter((r) => (r.weapon_type ?? '') === g.key) }))
      .filter((g) => g.list.length > 0);
    const selectedType = selected != null ? byOutput.get(selected)?.weapon_type ?? '' : null;
    listEl.innerHTML = groups.map((g) => `
      <details class="recipe-group" ${q || g.key === selectedType ? 'open' : ''}>
        <summary>${g.label}<span class="count">${g.list.length}</span></summary>
        <div class="recipe-group-list">${g.list.map(link).join('')}</div>
      </details>`).join('') || '<p class="muted">Aucune recette.</p>';

    if (loadError) { mainEl.innerHTML = `<p class="error">Chargement impossible : ${escapeHtml(loadError)}</p>`; return; }
    if (selected == null) {
      mainEl.innerHTML = `<div class="panel empty"><p>Aucune recette pour l’instant.</p>
        <button class="btn primary" data-action="new">Créer la première recette</button></div>`;
      return;
    }

    const target = selected;
    const recipe = byOutput.get(target)!;
    const valueNever = expand(target, count, null, [], 'never', true);
    const valueAlways = expand(target, count, null, [], 'always', true);
    const combos = countCombos(valueAlways);
    const expected = combos ? expectedCost(target, count, [], true) : valueNever.cost;
    const shown = expand(target, count, new Map(stock), [], combos ? plan : 'never', true);
    const shopping = [...flatten(shown, new Map()).entries()];
    const toBuy = shown.cost;
    const missingKinah = Math.max(0, toBuy - kinah);
    const unknown = unknownPrices(valueNever);

    const marketPrice = items.get(target)?.current_price ?? null;
    const direct = marketPrice != null ? marketPrice * count : null;
    const margin = direct != null ? Math.round(direct * (1 - tax / 100) - expected) : null;
    const anyCombo = combos > 0 || recipe.combo_chance > 0;
    const pctShown = Math.round((comboPct ?? (recipes.find((r) => r.combo_chance > 0)?.combo_chance ?? 0.25) * 100));

    const card = (label: string, value: string, note = '', cls = '') =>
      `<div class="stat-card ${cls}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ''}</div>`;

    const costCards = combos
      ? card('Coût sans combo', `${formatKinah(valueNever.cost)} k`, 'aucun combo ne passe')
        + card('Coût avec combo', `${formatKinah(valueAlways.cost)} k`, `${combos} étape${combos > 1 ? 's' : ''} sautée${combos > 1 ? 's' : ''}`)
        + card('Coût moyen attendu', `${formatKinah(Math.round(expected))} k`, `avec ${pctShown} % de combo à chaque étape`, 'highlight')
      : card('Prix de revient', `${formatKinah(valueNever.cost)} k`, 'valeur marché des composants', 'highlight');

    const tradeCards = direct == null
      ? card('Achat direct', 'Prix inconnu', 'ajoute un prix depuis la page Marché')
      : card('Achat direct', `${formatKinah(direct)} k`)
        + card('Marge si revente', `${margin! >= 0 ? '+' : '−'}${formatKinah(Math.abs(margin!))} k`, tax ? `taxe de ${tax} % déduite` : '', margin! >= 0 ? 'up' : 'down');

    mainEl.innerHTML = `
      <div class="page-head">
        <h1 class="grade-${gradeOf(target)}">${escapeHtml(nameOf(target))}</h1>
        <div class="row-end">
          <button class="btn" data-action="duplicate">Dupliquer</button>
          <button class="btn" data-action="edit">Modifier la recette</button>
        </div>
      </div>

      <div class="panel settings">
        <label>Quantité à fabriquer <input type="number" min="1" max="999" value="${count}" data-set="count" /></label>
        ${anyCombo ? `<label>Chance de combo (%) <input type="number" min="0" max="100" step="1" value="${pctShown}" data-set="combo" /></label>` : ''}
        <label>Taxe de l’hôtel des ventes (%) <input type="number" min="0" max="50" step="0.5" value="${tax}" data-set="tax" /></label>
      </div>

      ${recipe.combo_item_id && recipe.combo_chance > 0 ? `<p class="combo-note">${ICONS.up}<span>${Math.round(chance(recipe) * 100)} % de chance
        d’obtenir directement <strong>${escapeHtml(nameOf(recipe.combo_item_id))}</strong> à la place.</span></p>` : ''}

      <div class="stat-cards">${costCards}${tradeCards}</div>
      ${unknown.length ? `<p class="warn">Prix inconnu, compté à 0 : ${unknown.map(escapeHtml).join(', ')}.</p>` : ''}

      <section class="panel">
        <div class="panel-head">
          <h2>Arbre de fabrication</h2>
          ${combos ? `<label class="select-wrap"><span class="sr-only">Scénario</span>
            <select data-set="plan">
              <option value="never"${plan === 'never' ? ' selected' : ''}>Prévoir sans combo</option>
              <option value="always"${plan === 'always' ? ' selected' : ''}>Prévoir avec combo</option>
            </select>${ICONS.chevron}</label>` : ''}
        </div>
        <div class="table-wrap"><table class="tree">
          <thead><tr><th>Composant</th><th class="num">Stock / requis</th><th>Obtention</th>
            <th class="num">Prix unitaire</th><th class="num">À acheter</th></tr></thead>
          <tbody>${treeRows(shown, 0, true)}</tbody>
        </table></div>
        <p class="hint">Le stock est partagé entre les étapes. Modifie-le depuis la page Stock. Tape un prix dans la colonne « Prix unitaire » pour l’enregistrer pour tout le groupe.</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Liste d’achats</h2></div>
        ${shopping.length === 0 ? '<p class="muted pad">Rien à acheter : ton stock couvre tout.</p>' : `
        <div class="table-wrap"><table class="materials">
          <thead><tr><th>Objet</th><th class="num">Quantité</th><th class="num">Prix unitaire</th><th class="num">Coût</th></tr></thead>
          <tbody>${shopping.map(([id, m]) => `<tr>
              <td><span class="item-name grade-${gradeOf(id)}">${escapeHtml(nameOf(id))}</span></td>
              <td class="num">${m.missing > 0 ? `<span class="trend down">${m.missing} introuvable</span>` : `<strong>${m.buy}</strong>`}</td>
              <td class="num muted">${m.missing > 0 ? '—' : m.unit != null ? formatKinah(m.unit) : '<span class="warn-inline">prix inconnu</span>'}</td>
              <td class="num price">${m.missing > 0 || m.unit == null ? '—' : formatKinah(m.buy * m.unit)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`}
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
    if (n.viaCombo) how = `<span class="combo-tag">Combo : en craftant ${escapeHtml(nameOf(n.children[0].itemId))}</span>`;
    else if (isRoot) how = `Craft ×${n.crafts}`;
    else if (n.craftable) {
      const m = n.mode === 'craft' ? 'craft' : 'buy';
      how = `<div class="toggle" role="group" aria-label="Acheter ou crafter">
        <button data-action="mode" data-id="${n.itemId}" data-mode="buy" aria-pressed="${m === 'buy'}">Acheter</button>
        <button data-action="mode" data-id="${n.itemId}" data-mode="craft" aria-pressed="${m === 'craft'}">Crafter</button></div>`;
    } else how = n.mode === 'buy' ? 'Achat' : '<span class="muted">Introuvable</span>';

    const ratio = isRoot ? `${n.required}` : `<span class="ratio ${n.mode === 'craft' ? '' : n.fromStock >= n.required ? 'ok' : 'short'}">${n.fromStock}/${n.required}</span>`;
    const priceCell = n.mode === 'buy'
      ? `<input class="price-cell" inputmode="numeric" data-price="${n.itemId}" value="${n.unit != null ? formatKinah(n.unit) : ''}"
          placeholder="prix ?" aria-label="Prix unitaire de ${label}" />`
      : '<span class="muted">—</span>';
    const cost = n.mode !== 'buy' ? '<span class="muted">—</span>'
      : n.rest === 0 ? '<span class="trend up">en stock</span>'
      : n.unit == null ? `<span class="warn-inline">${n.rest} × ?</span>`
      : `${formatKinah(n.cost)}<small class="muted"> (${n.rest})</small>`;
    return `<tr class="depth-${Math.min(depth, 4)}">
        <td><span class="tree-name" style="--depth:${depth}"><span class="item-name grade-${gradeOf(n.itemId)}">${label}</span></span></td>
        <td class="num">${ratio}</td><td>${how}</td><td class="num">${priceCell}</td><td class="num price">${cost}</td>
      </tr>${n.children.map((c) => treeRows(c, depth + 1)).join('')}`;
  }

  // ---------- Éditeur ----------
  function draftFrom(r: Recipe | undefined, keepOutput: boolean): RecipeDraft {
    if (!r) return { weaponType: null, outputName: '', outputQty: 1, combo: false, comboPct: 25, comboName: '', components: [] };
    return {
      recipeId: keepOutput ? r.id : undefined,
      weaponType: r.weapon_type,
      outputName: keepOutput ? nameOf(r.output_item_id) : '',
      outputQty: r.output_qty,
      combo: r.combo_chance > 0,
      comboPct: Math.round(r.combo_chance * 100) || 25,
      comboName: keepOutput && r.combo_item_id ? nameOf(r.combo_item_id) : '',
      components: r.recipe_components.map((c) => ({ name: nameOf(c.item_id), qty: c.qty })),
    };
  }

  function editor(title: string, draft: RecipeDraft) {
    openRecipeEditor({
      title,
      draft,
      items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)),
      hasRecipe: (id) => byOutput.has(id),
      onSaved: async (outputId, next) => {
        selected = outputId;
        await load();
        if (next && confirm(`Le combo donne « ${next.outputName} », qui n’a pas encore de recette. La créer maintenant ?`)) {
          editor(`Recette : ${next.outputName}`, next);
        }
      },
      onDeleted: async () => { selected = null; await load(); },
    });
  }

  // ---------- Événements ----------
  searchEl.addEventListener('input', () => { search = searchEl.value; render(); });

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'select': selected = Number(el.dataset.id); plan = 'never'; render(); break;
      case 'mode': modes.set(Number(el.dataset.id), el.dataset.mode as Mode); render(); break;
      case 'new': editor('Nouvelle recette', draftFrom(undefined, false)); break;
      case 'edit': if (selected != null) editor('Modifier la recette', draftFrom(byOutput.get(selected), true)); break;
      case 'duplicate':
        if (selected != null) editor(`Nouvelle recette (copie de ${nameOf(selected)})`, draftFrom(byOutput.get(selected), false));
        break;
    }
  });

  root.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const set = el.dataset.set;
    if (set === 'count') count = Math.max(1, Math.min(999, Number(el.value) || 1));
    else if (set === 'combo') comboPct = Math.max(0, Math.min(100, Number(el.value) || 0));
    else if (set === 'tax') tax = Math.max(0, Math.min(50, Number(el.value) || 0));
    else if (set === 'plan') plan = el.value as Scenario;
    else if (set === 'kinah') {
      kinah = parseKinah(el.value) ?? 0;
      const { error } = await supabase.from('wallets').upsert({ kinah }, { onConflict: 'user_id' });
      if (error) alert(`Enregistrement des kinah impossible : ${error.message}`);
    } else if (el.dataset.price) {
      const price = parseKinah(el.value);
      const id = Number(el.dataset.price);
      if (!price || price === items.get(id)?.current_price) { render(); return; }
      const { error } = await supabase.from('price_records').insert({ item_id: id, price });
      if (error) { alert(`Enregistrement du prix impossible : ${error.message}`); return; }
      await load();
      return;
    } else return;
    render();
  });

  void load();
}
