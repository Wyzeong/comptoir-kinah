import { supabase } from './supabase';
import { CATEGORIES, GRADES, type CategoryKey, type ItemOverview } from './types';
import { escapeHtml } from './format';

export interface RecipeDraft {
  recipeId?: number;
  outputName: string;
  outputQty: number;
  combo: boolean;
  comboPct: number;
  comboName: string;
  components: { name: string; qty: number }[];
}

interface EditorOptions {
  title: string;
  draft: RecipeDraft;
  items: ItemOverview[];
  hasRecipe: (itemId: number) => boolean;
  onSaved: (outputId: number, next?: RecipeDraft) => void | Promise<void>;
  onDeleted?: () => void | Promise<void>;
}

const categoryOptions = (selected: CategoryKey) =>
  CATEGORIES.map((c) => `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${c.label}</option>`).join('');
const gradeOptions = (selected = 'gold') =>
  GRADES.map((g) => `<option value="${g.key}"${g.key === selected ? ' selected' : ''}>${g.label}</option>`).join('');

/** Champs « catégorie + rareté » affichés seulement si le nom saisi n'existe pas encore. */
const newFields = (cat: CategoryKey) => `
  <div class="new-fields" hidden>
    <span class="muted new-hint">Nouvel objet :</span>
    <select data-role="category" aria-label="Catégorie du nouvel objet">${categoryOptions(cat)}</select>
    <select data-role="grade" aria-label="Rareté du nouvel objet">${gradeOptions()}</select>
  </div>`;

const componentRow = (name = '', qty = 1) => `
  <div class="comp-row">
    <div class="comp-main">
      <input data-role="name" list="re-items" value="${escapeHtml(name)}" placeholder="Nom du composant" aria-label="Composant" />
      <input data-role="qty" type="number" min="1" value="${qty}" aria-label="Quantité" />
      <button type="button" class="btn ghost small" data-re="remove" aria-label="Retirer ce composant">Retirer</button>
    </div>
    ${newFields('material')}
  </div>`;

export function openRecipeEditor(opts: EditorOptions) {
  const known = new Map(opts.items.map((i) => [i.name.trim().toLowerCase(), i.id]));
  const d = opts.draft;

  const dialog = document.createElement('dialog');
  dialog.className = 'dialog wide recipe-dialog';
  dialog.innerHTML = `
    <form class="stack recipe-form" autocomplete="off">
      <h2>${escapeHtml(opts.title)}</h2>

      <fieldset class="re-block">
        <legend>Objet fabriqué</legend>
        <div class="field-group" data-group="output">
          <div class="comp-main">
            <input data-role="name" name="output" list="re-items" required value="${escapeHtml(d.outputName)}"
              placeholder="ex. Star Dragon Lord Mace" aria-label="Objet fabriqué" />
            <label class="inline">Quantité produite <input data-role="qty" name="outputQty" type="number" min="1" value="${d.outputQty}" /></label>
          </div>
          ${newFields('weapon')}
        </div>
      </fieldset>

      <fieldset class="re-block">
        <legend>Combo</legend>
        <label class="check"><input type="checkbox" name="combo" ${d.combo ? 'checked' : ''} /> Cette recette peut faire un combo</label>
        <div class="combo-fields stack" ${d.combo ? '' : 'hidden'}>
          <label class="inline">Chance de combo (%) <input name="comboPct" type="number" min="1" max="100" value="${d.comboPct}" /></label>
          <div class="field-group" data-group="combo">
            <label>Objet obtenu directement en cas de combo
              <input data-role="name" name="comboName" list="re-items" value="${escapeHtml(d.comboName)}" placeholder="ex. Splendent Star Dragon Lord Mace" />
            </label>
            ${newFields('weapon')}
          </div>
        </div>
      </fieldset>

      <fieldset class="re-block">
        <legend>Composants</legend>
        <div class="comp-list">${(d.components.length ? d.components : [{ name: '', qty: 1 }]).map((c) => componentRow(c.name, c.qty)).join('')}</div>
        <button type="button" class="btn" data-re="add">Ajouter un composant</button>
      </fieldset>

      <p class="error" hidden></p>
      <div class="review-foot">
        <div>${d.recipeId && opts.onDeleted ? '<button type="button" class="btn ghost danger" data-re="delete">Supprimer la recette</button>' : ''}</div>
        <div class="row-end">
          <button type="button" class="btn ghost" data-re="cancel">Annuler</button>
          <button type="submit" class="btn primary">Enregistrer la recette</button>
        </div>
      </div>
    </form>
    <datalist id="re-items">${opts.items.map((i) => `<option value="${escapeHtml(i.name)}"></option>`).join('')}</datalist>`;
  document.body.append(dialog);

  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const errEl = form.querySelector<HTMLElement>('.error')!;
  const fail = (m: string) => { errEl.hidden = false; errEl.textContent = m; errEl.scrollIntoView({ block: 'nearest' }); };

  const isKnown = (name: string) => known.has(name.trim().toLowerCase());
  function refreshNewFields(input: HTMLInputElement) {
    const group = input.closest('.comp-row, .field-group');
    const nf = group?.querySelector<HTMLElement>('.new-fields');
    if (nf) nf.hidden = isKnown(input.value) || input.value.trim().length < 2;
  }
  form.querySelectorAll<HTMLInputElement>('input[data-role=name]').forEach(refreshNewFields);

  form.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.role === 'name') refreshNewFields(el);
  });
  form.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.name === 'combo') form.querySelector<HTMLElement>('.combo-fields')!.hidden = !el.checked;
  });
  form.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-re]');
    if (!btn) return;
    switch (btn.dataset.re) {
      case 'add': {
        form.querySelector('.comp-list')!.insertAdjacentHTML('beforeend', componentRow());
        form.querySelector<HTMLInputElement>('.comp-row:last-child input[data-role=name]')!.focus();
        break;
      }
      case 'remove': btn.closest('.comp-row')!.remove(); break;
      case 'cancel': dialog.close(); break;
      case 'delete': {
        if (!confirm('Supprimer définitivement cette recette ?')) return;
        const { data, error } = await supabase.from('recipes').delete().eq('id', d.recipeId!).select('id');
        if (error) return fail(`Suppression impossible : ${error.message}`);
        if (!data?.length) return fail('Seul un admin peut supprimer une recette.');
        dialog.close();
        await opts.onDeleted?.();
        break;
      }
    }
  });
  dialog.addEventListener('close', () => dialog.remove());

  async function ensureItem(name: string, group: Element): Promise<number> {
    const clean = name.trim().replace(/\s+/g, ' ');
    const id = known.get(clean.toLowerCase());
    if (id) return id;
    const category = group.querySelector<HTMLSelectElement>('[data-role=category]')!.value;
    const grade = group.querySelector<HTMLSelectElement>('[data-role=grade]')!.value;
    const { data, error } = await supabase.from('items').insert({ name: clean, category, grade }).select('id').single();
    if (!error) { known.set(clean.toLowerCase(), data.id); return data.id; }
    if (error.code === '23505') {
      const ex = await supabase.from('items').select('id').eq('name_norm', clean.toLowerCase()).single();
      if (ex.data) return ex.data.id;
    }
    throw new Error(`Création de « ${clean} » impossible : ${error.message}`);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const outGroup = form.querySelector('[data-group=output]')!;
    const outputName = (form.elements.namedItem('output') as HTMLInputElement).value.trim();
    const outputQty = Math.floor(Number((form.elements.namedItem('outputQty') as HTMLInputElement).value) || 0);
    const combo = (form.elements.namedItem('combo') as HTMLInputElement).checked;
    const comboPct = Number((form.elements.namedItem('comboPct') as HTMLInputElement).value) || 0;
    const comboName = (form.elements.namedItem('comboName') as HTMLInputElement).value.trim();

    if (outputName.length < 2) return fail('Indique l’objet fabriqué.');
    if (outputQty < 1) return fail('La quantité produite doit être d’au moins 1.');
    if (combo && (comboPct <= 0 || comboPct > 100)) return fail('La chance de combo doit être comprise entre 1 et 100 %.');
    if (combo && comboName.length < 2) return fail('Indique l’objet obtenu en cas de combo.');
    if (combo && comboName.toLowerCase() === outputName.toLowerCase()) return fail('L’objet du combo doit être différent de l’objet fabriqué.');

    const rows = [...form.querySelectorAll<HTMLElement>('.comp-row')]
      .map((r) => ({
        el: r,
        name: r.querySelector<HTMLInputElement>('[data-role=name]')!.value.trim(),
        qty: Math.floor(Number(r.querySelector<HTMLInputElement>('[data-role=qty]')!.value) || 0),
      }))
      .filter((r) => r.name);
    if (rows.length === 0) return fail('Ajoute au moins un composant.');
    for (const r of rows) {
      if (r.qty < 1) return fail(`Quantité invalide pour « ${r.name} ».`);
      if (r.name.toLowerCase() === outputName.toLowerCase()) return fail('Un objet ne peut pas être son propre composant.');
    }

    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true;
    try {
      const outputId = await ensureItem(outputName, outGroup);
      const comboId = combo ? await ensureItem(comboName, form.querySelector('[data-group=combo]')!) : null;

      // Composants (les doublons sont additionnés)
      const comps = new Map<number, number>();
      for (const r of rows) {
        const id = await ensureItem(r.name, r.el);
        comps.set(id, (comps.get(id) ?? 0) + r.qty);
      }

      const payload = { output_item_id: outputId, output_qty: outputQty, combo_chance: combo ? comboPct / 100 : 0, combo_item_id: comboId };
      const saved = d.recipeId
        ? await supabase.from('recipes').update(payload).eq('id', d.recipeId).select('id').single()
        : await supabase.from('recipes').upsert(payload, { onConflict: 'output_item_id' }).select('id').single();
      if (saved.error) throw new Error(saved.error.code === '23505'
        ? 'Une autre recette fabrique déjà cet objet.' : `Enregistrement de la recette impossible : ${saved.error.message}`);
      const recipeId = saved.data.id;

      const del = await supabase.from('recipe_components').delete().eq('recipe_id', recipeId);
      if (del.error) throw new Error(`Mise à jour des composants impossible : ${del.error.message}`);
      const ins = await supabase.from('recipe_components')
        .insert([...comps.entries()].map(([item_id, qty]) => ({ recipe_id: recipeId, item_id, qty })));
      if (ins.error) throw new Error(`Enregistrement des composants impossible : ${ins.error.message}`);

      // Si le combo mène à un objet sans recette, on propose d'enchaîner sur sa recette « Splendent »
      const next: RecipeDraft | undefined = comboId && !opts.hasRecipe(comboId)
        ? { outputName: comboName, outputQty: 1, combo: false, comboPct: 25, comboName: '', components: [{ name: outputName, qty: 1 }] }
        : undefined;
      dialog.close();
      await opts.onSaved(outputId, next);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
    }
  });

  dialog.showModal();
  form.querySelector<HTMLInputElement>('input[name=output]')!.focus();
}
