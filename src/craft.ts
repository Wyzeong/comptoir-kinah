import { supabase } from './supabase';
import { PROFESSIONS, craftTypeLabel, professionOf, type CraftTypeKey, type ItemOverview, type ProfessionKey } from './types';
import { escapeHtml, formatKinah, parseKinah } from './format';
import { ICONS } from './icons';
import { openRecipeEditor, type RecipeDraft } from './recipe-editor';

interface Recipe {
  id: number;
  output_item_id: number;
  output_qty: number;
  combo_chance: number;
  combo_item_id: number | null;
  craft_type: CraftTypeKey | null;
  recipe_components: { item_id: number; qty: number }[];
}

interface Node {
  itemId: number;
  required: number;
  fromStock: number;
  available: number; // stock encore disponible en arrivant à cette étape
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
  let prof: ProfessionKey | 'none' = 'blacksmithing';
  let sub: CraftTypeKey | 'all' = 'all';
  let firstLoad = true;
  const modes = new Map<number, Mode>();
  const collapsed = new Set<string>(); // étapes réduites dans l'arbre (chemin d'objets)
  let foldable: string[] = [];
  let loadError: string | null = null;

  root.innerHTML = `<div class="craft-nav">
      <nav class="prof-tabs" aria-label="Métier"></nav>
      <nav class="sub-tabs" aria-label="Catégorie"></nav>
    </div>
    <div class="craft">
    <aside class="panel recipe-list">
      <h2 class="list-title">Recettes</h2>
      <button class="btn primary" data-action="new">Nouvelle recette</button>
      <input type="search" class="search" placeholder="Chercher une recette" aria-label="Chercher une recette" />
      <nav class="recipe-links"></nav>
    </aside>
    <section class="craft-main"></section>
  </div>`;
  const listEl = root.querySelector<HTMLElement>('.recipe-links')!;
  const profNav = root.querySelector<HTMLElement>('.prof-tabs')!;
  const subNav = root.querySelector<HTMLElement>('.sub-tabs')!;
  const titleEl = root.querySelector<HTMLElement>('.list-title')!;
  const mainEl = root.querySelector<HTMLElement>('.craft-main')!;
  const searchEl = root.querySelector<HTMLInputElement>('.search')!;

  async function load() {
    const [it, rc, inv, wal] = await Promise.all([
      supabase.from('item_overview').select('*'),
      supabase.from('recipes').select('id, output_item_id, output_qty, combo_chance, combo_item_id, craft_type, recipe_components(item_id, qty)'),
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
    if (selected != null && !byOutput.has(selected)) selected = null;
    if (firstLoad && selected == null) {
      // Ouvre la première rubrique qui contient des recettes
      const first = sortedRecipes()[0];
      if (first) { prof = professionOf(first.craft_type) ?? 'none'; selected = first.output_item_id; }
      firstLoad = false;
    }
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
    const available = pool ? pool.get(itemId) ?? 0 : 0;
    if (pool && !force) {
      const have = pool.get(itemId) ?? 0;
      fromStock = Math.min(have, qty);
      pool.set(itemId, have - fromStock);
    }
    const rest = qty - fromStock;
    const craftable = !!recipe && !path.includes(itemId);
    const base = { itemId, required: qty, fromStock, available, rest, craftable, viaCombo: false };

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

  function countNodes(n: Node): number {
    return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
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
    // Onglets métier et sous-catégorie, comme dans le jeu
    const hasUnclassified = recipes.some((r) => !professionOf(r.craft_type));
    if (prof === 'none' && !hasUnclassified) prof = 'blacksmithing';
    const profTabs = [...PROFESSIONS.map((p) => ({ key: p.key as string, label: p.label as string })),
      ...(hasUnclassified ? [{ key: 'none', label: 'Non classées' }] : [])];
    profNav.innerHTML = profTabs.map((p) =>
      `<button class="prof-tab${p.key === prof ? ' active' : ''}" data-action="prof" data-key="${p.key}" aria-pressed="${p.key === prof}">${p.label}</button>`).join('');
    const subs = PROFESSIONS.find((p) => p.key === prof)?.subs ?? [];
    subNav.innerHTML = [{ key: 'all', label: 'All' }, ...subs].map((s) =>
      `<button class="sub-tab${s.key === sub ? ' active' : ''}" data-action="sub" data-key="${s.key}" aria-pressed="${s.key === sub}">${s.label}</button>`).join('');
    subNav.hidden = prof === 'none';

    const inRubric = (r: Recipe) => (professionOf(r.craft_type) ?? 'none') === prof && (sub === 'all' || r.craft_type === sub);
    const shownRecipes = sortedRecipes().filter((r) => (q ? nameOf(r.output_item_id).toLowerCase().includes(q) : inRubric(r)));
    if (!q && (selected == null || !shownRecipes.some((r) => r.output_item_id === selected))) {
      selected = shownRecipes[0]?.output_item_id ?? null;
    }
    titleEl.textContent = q ? 'Résultats de recherche'
      : prof === 'none' ? 'Non classées'
      : sub === 'all' ? (PROFESSIONS.find((p) => p.key === prof)?.label ?? '') : craftTypeLabel(sub);
    listEl.innerHTML = shownRecipes.map((r) => `<button class="recipe-link grade-${gradeOf(r.output_item_id)}${r.output_item_id === selected ? ' active' : ''}"
          data-action="select" data-id="${r.output_item_id}">${escapeHtml(nameOf(r.output_item_id))}
          <span class="recipe-meta">${q || sub === 'all' ? `<span class="type-tag">${craftTypeLabel(r.craft_type)}</span>` : ''}
          ${r.combo_chance > 0 ? `<span class="combo-tag">combo ${Math.round(r.combo_chance * 100)} %</span>` : ''}</span></button>`)
      .join('') || `<p class="muted">${q ? 'Aucune recette ne correspond.' : 'Aucune recette dans cette rubrique.'}</p>`;

    if (loadError) { mainEl.innerHTML = `<p class="error">Chargement impossible : ${escapeHtml(loadError)}</p>`; return; }
    if (selected == null) {
      mainEl.innerHTML = `<div class="panel empty"><p>Aucune recette dans cette rubrique pour l’instant.</p>
        <button class="btn primary" data-action="new">Créer une recette</button></div>`;
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
          <button class="btn cyan-outline" data-action="crafted" data-id="${target}" data-n="${count}">J’ai crafté</button>
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
          <div class="row-end">
          <button class="btn small" data-action="expand-all">Tout déplier</button>
          <button class="btn small" data-action="collapse-all">Tout réduire</button>
          ${combos ? `<label class="select-wrap"><span class="sr-only">Scénario</span>
            <select data-set="plan">
              <option value="never"${plan === 'never' ? ' selected' : ''}>Prévoir sans combo</option>
              <option value="always"${plan === 'always' ? ' selected' : ''}>Prévoir avec combo</option>
            </select>${ICONS.chevron}</label>` : ''}
          </div>
        </div>
        <div class="table-wrap"><table class="tree">
          <thead><tr><th>Composant</th><th class="num">Stock / requis</th><th>Obtention</th>
            <th class="num">Prix unitaire</th><th class="num">À acheter</th></tr></thead>
          <tbody>${(foldable = [], treeRows(shown, 0, true, String(shown.itemId)))}</tbody>
        </table></div>
        <p class="hint">Le stock est partagé entre les étapes : modifie-le avec − et + ou en tapant la quantité possédée. Tape un prix dans la colonne « Prix unitaire » pour l’enregistrer pour tout le groupe.</p>
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

  function treeRows(n: Node, depth: number, isRoot = false, key = ''): string {
    const label = escapeHtml(nameOf(n.itemId));
    let how: string;
    if (n.viaCombo) how = `<span class="combo-tag">Combo : en craftant ${escapeHtml(nameOf(n.children[0].itemId))}</span>`;
    else if (isRoot) how = `Craft ×${n.crafts}`;
    else if (n.craftable) {
      const m = n.mode === 'craft' ? 'craft' : 'buy';
      how = `<div class="how"><div class="toggle" role="group" aria-label="Acheter ou crafter">
        <button data-action="mode" data-id="${n.itemId}" data-mode="buy" aria-pressed="${m === 'buy'}">Acheter</button>
        <button data-action="mode" data-id="${n.itemId}" data-mode="craft" aria-pressed="${m === 'craft'}">Crafter</button></div>
        ${m === 'craft' ? `<button class="btn small" data-action="crafted" data-id="${n.itemId}" data-n="${Math.max(1, n.crafts)}"
          title="Retirer du stock les composants de ce craft">Crafté</button>` : ''}</div>`;
    } else how = n.mode === 'buy' ? 'Achat' : '<span class="muted">Introuvable</span>';

    const have = stock.get(n.itemId) ?? 0;
    const state = n.mode === 'craft' ? '' : n.fromStock >= n.required ? 'ok' : 'short';
    const ratio = isRoot ? `${n.required}` : `<div class="stock-edit ${state}"
        title="Tu en possèdes ${have}. ${n.fromStock} utilisé${n.fromStock > 1 ? 's' : ''} à cette étape, ${n.required} requis.">
        <button type="button" data-action="stock-dec" data-id="${n.itemId}" aria-label="Retirer 1 ${label} du stock"${have > 0 ? '' : ' disabled'}>−</button>
        <input class="stock-cell" type="number" min="0" value="${have}" data-stockedit="${n.itemId}" aria-label="Stock de ${label}" />
        <button type="button" data-action="stock-inc" data-id="${n.itemId}" aria-label="Ajouter 1 ${label} au stock">+</button>
        <span class="req">/ ${n.required}</span>
      </div>${have > n.available ? `<small class="used-before">dont ${have - n.available} déjà utilisé${have - n.available > 1 ? 's' : ''} plus haut</small>` : ''}`;
    const priceCell = n.mode === 'buy'
      ? `<input class="price-cell" inputmode="numeric" data-price="${n.itemId}" value="${n.unit != null ? formatKinah(n.unit) : ''}"
          placeholder="prix ?" aria-label="Prix unitaire de ${label}" />`
      : '<span class="muted">—</span>';
    const hasChildren = n.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(key);
    if (hasChildren && !isRoot) foldable.push(key);
    const toggle = hasChildren
      ? `<button class="tree-toggle${isCollapsed ? '' : ' open'}" data-action="fold" data-key="${key}" aria-expanded="${!isCollapsed}"
          aria-label="${isCollapsed ? 'Déplier' : 'Réduire'} les étapes de ${label}">${ICONS.chevron}</button>`
      : '<span class="tree-spacer"></span>';
    const hidden = isCollapsed ? countNodes(n) - 1 : 0;
    const cost = n.mode === 'craft' && isCollapsed
      ? `<span class="subtotal">${formatKinah(n.cost)}</span>`
      : n.mode !== 'buy' ? '<span class="muted">—</span>'
      : n.rest === 0 ? '<span class="trend up">en stock</span>'
      : n.unit == null ? `<span class="warn-inline">${n.rest} × ?</span>`
      : `${formatKinah(n.cost)}<small class="muted"> (${n.rest})</small>`;
    return `<tr class="depth-${Math.min(depth, 4)}">
        <td><span class="tree-name" style="--depth:${depth}">${toggle}<span class="item-name grade-${gradeOf(n.itemId)}">${label}</span>
          ${hidden ? `<small class="muted folded-note">${hidden} étape${hidden > 1 ? 's' : ''} masquée${hidden > 1 ? 's' : ''}</small>` : ''}</span></td>
        <td class="num">${ratio}</td><td>${how}</td><td class="num">${priceCell}</td><td class="num price">${cost}</td>
      </tr>${isCollapsed ? '' : n.children.map((c) => treeRows(c, depth + 1, false, `${key}/${c.itemId}`)).join('')}`;
  }

  // ---------- Éditeur ----------
  function draftFrom(r: Recipe | undefined, keepOutput: boolean): RecipeDraft {
    if (!r) return { craftType: sub !== 'all' ? sub : null, outputName: '', outputQty: 1, combo: false, comboPct: 25, comboName: '', components: [] };
    return {
      recipeId: keepOutput ? r.id : undefined,
      craftType: r.craft_type,
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
        // Affiche la rubrique de la recette enregistrée
        const t = byOutput.get(outputId)?.craft_type ?? null;
        prof = professionOf(t) ?? 'none';
        sub = t ?? 'all';
        render();
        if (next && confirm(`Le combo donne « ${next.outputName} », qui n’a pas encore de recette. La créer maintenant ?`)) {
          editor(`Recette : ${next.outputName}`, next);
        }
      },
      onDeleted: async () => { selected = null; await load(); },
    });
  }

  // ---------- Stock modifié depuis l'arbre ----------
  const saveTimers = new Map<number, number>();
  function setStock(itemId: number, qty: number) {
    stock.set(itemId, Math.max(0, qty));
    render();
    // Enregistrement groupé : plusieurs clics rapides sur + ou − ne font qu'un envoi
    clearTimeout(saveTimers.get(itemId));
    saveTimers.set(itemId, window.setTimeout(async () => {
      const value = stock.get(itemId) ?? 0;
      const { error } = value > 0
        ? await supabase.from('inventories').upsert({ item_id: itemId, qty: value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,item_id' })
        : await supabase.from('inventories').delete().eq('user_id', me.id).eq('item_id', itemId);
      if (error) alert(`Enregistrement du stock impossible : ${error.message}`);
    }, 400));
  }

  // ---------- « J'ai crafté » : retire les composants du stock ----------
  function openCraftedDialog(itemId: number, initialCrafts: number) {
    const recipe = byOutput.get(itemId);
    if (!recipe) return;
    const comboItem = recipe.combo_item_id && recipe.combo_chance > 0 ? recipe.combo_item_id : null;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog wide';
    document.body.append(dialog);
    let crafts = initialCrafts;

    const rowsHtml = () => recipe.recipe_components.map((c) => {
      const need = c.qty * crafts;
      const have = stock.get(c.item_id) ?? 0;
      const after = Math.max(0, have - need);
      return `<tr class="${have < need ? 'short-row' : ''}">
        <td><span class="item-name grade-${gradeOf(c.item_id)}">${escapeHtml(nameOf(c.item_id))}</span></td>
        <td class="num">−${need}</td><td class="num">${have}</td>
        <td class="num"><strong>${after}</strong>${have < need ? `<small class="trend down"> (il en manquait ${need - have})</small>` : ''}</td>
      </tr>`;
    }).join('');

    dialog.innerHTML = `<form class="stack">
      <h2>J’ai crafté : ${escapeHtml(nameOf(itemId))}</h2>
      <label class="inline">Nombre de crafts <input type="number" name="crafts" min="1" max="999" value="${crafts}" /></label>
      <div class="table-wrap"><table class="materials">
        <thead><tr><th>Composant retiré</th><th class="num">Quantité</th><th class="num">Stock actuel</th><th class="num">Stock après</th></tr></thead>
        <tbody class="crafted-rows">${rowsHtml()}</tbody>
      </table></div>
      <fieldset class="re-block">
        <legend>Objet obtenu</legend>
        <label class="check"><input type="radio" name="result" value="${itemId}" checked /> ${escapeHtml(nameOf(itemId))}</label>
        ${comboItem ? `<label class="check"><input type="radio" name="result" value="${comboItem}" /> ${escapeHtml(nameOf(comboItem))} <span class="combo-tag">combo</span></label>` : ''}
        <label class="check"><input type="checkbox" name="addOutput" checked /> Ajouter l’objet obtenu à mon stock</label>
      </fieldset>
      <p class="error" hidden></p>
      <div class="row-end">
        <button type="button" class="btn ghost" data-close>Annuler</button>
        <button type="submit" class="btn primary">Retirer du stock</button>
      </div>
    </form>`;

    const form = dialog.querySelector('form')!;
    form.querySelector<HTMLInputElement>('input[name=crafts]')!.addEventListener('input', (e) => {
      crafts = Math.max(1, Math.min(999, Math.floor(Number((e.target as HTMLInputElement).value) || 1)));
      dialog.querySelector('.crafted-rows')!.innerHTML = rowsHtml();
    });
    dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const resultId = Number(fd.get('result'));
      const changes = new Map<number, number>();
      for (const c of recipe.recipe_components) {
        changes.set(c.item_id, Math.max(0, (changes.get(c.item_id) ?? stock.get(c.item_id) ?? 0) - c.qty * crafts));
      }
      if (fd.get('addOutput') === 'on') {
        changes.set(resultId, (changes.get(resultId) ?? stock.get(resultId) ?? 0) + recipe.output_qty * crafts);
      }
      const now = new Date().toISOString();
      const { error } = await supabase.from('inventories').upsert(
        [...changes.entries()].map(([item_id, qty]) => ({ item_id, qty, updated_at: now })),
        { onConflict: 'user_id,item_id' },
      );
      if (error) {
        const p = form.querySelector<HTMLElement>('.error')!;
        p.hidden = false;
        p.textContent = `Mise à jour du stock impossible : ${error.message}`;
        return;
      }
      for (const [id, qty] of changes) stock.set(id, qty);
      dialog.close();
      render();
    });

    dialog.showModal();
  }

  // ---------- Événements ----------
  searchEl.addEventListener('input', () => { search = searchEl.value; render(); });

  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'select': selected = Number(el.dataset.id); plan = 'never'; render(); break;
      case 'prof': prof = el.dataset.key as ProfessionKey | 'none'; sub = 'all'; selected = null; search = ''; searchEl.value = ''; render(); break;
      case 'sub': sub = el.dataset.key as CraftTypeKey | 'all'; selected = null; search = ''; searchEl.value = ''; render(); break;
      case 'mode': modes.set(Number(el.dataset.id), el.dataset.mode as Mode); render(); break;
      case 'fold': {
        const k = el.dataset.key!;
        if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
        render();
        break;
      }
      case 'expand-all': collapsed.clear(); render(); break;
      case 'crafted': openCraftedDialog(Number(el.dataset.id), Number(el.dataset.n) || 1); break;
      case 'stock-inc': case 'stock-dec': {
        const id = Number(el.dataset.id);
        setStock(id, (stock.get(id) ?? 0) + (el.dataset.action === 'stock-inc' ? 1 : -1));
        break;
      }
      case 'collapse-all': for (const k of foldable) collapsed.add(k); render(); break;
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
    } else if (el.dataset.stockedit) {
      setStock(Number(el.dataset.stockedit), Math.floor(Number(el.value) || 0));
      return;
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
