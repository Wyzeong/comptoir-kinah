import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { CATEGORIES, GRADES, type ItemOverview } from './types';
import { escapeHtml, formatKinah, parseKinah } from './format';
import { ICONS } from './icons';

interface OcrRow { name: string; unit_price: number | null; quantity: number | null; truncated: boolean }

interface Line {
  key: number;
  raw: string;            // nom lu sur la capture
  truncated: boolean;
  listings: number;       // nombre d'annonces regroupées
  price: number | null;   // prix unitaire le plus bas
  score: number | null;   // qualité du rapprochement (1 = exact)
  action: 'item' | 'new' | 'ignore';
  itemId: number | null;
  include: boolean;
  newName: string;
  newCategory: string;
  newGrade: string;
}

const MAX_WIDTH = 2000;

export function initCapture(side: HTMLElement, opts: { getItems: () => ItemOverview[]; onSaved: () => Promise<void> }) {
  side.innerHTML = `
    <h2>Mettre à jour par capture</h2>
    <p class="muted">Colle une capture de l’hôtel des ventes avec Ctrl+V, glisse-la ici ou choisis un fichier.</p>
    <label class="dropzone" tabindex="0">
      ${ICONS.upload}
      <span class="dz-text">Glisse une capture ici</span>
      <input type="file" accept="image/png,image/jpeg,image/webp" hidden />
    </label>
    <button class="btn cyan" type="button" data-cap="pick">Envoyer une capture</button>
    <p class="cap-status" role="status" hidden></p>
    <dialog class="dialog wide" id="review-dialog"></dialog>`;

  const dropzone = side.querySelector<HTMLLabelElement>('.dropzone')!;
  const fileInput = side.querySelector<HTMLInputElement>('input[type=file]')!;
  const pickBtn = side.querySelector<HTMLButtonElement>('[data-cap=pick]')!;
  const statusEl = side.querySelector<HTMLElement>('.cap-status')!;
  const dialog = side.querySelector<HTMLDialogElement>('#review-dialog')!;

  let lines: Line[] = [];
  let busy = false;

  function setStatus(msg: string, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', isError);
  }

  function setBusy(b: boolean) {
    busy = b;
    pickBtn.disabled = b;
    dropzone.classList.toggle('busy', b);
    side.querySelector('.dz-text')!.textContent = b ? 'Lecture en cours…' : 'Glisse une capture ici';
  }

  // ---------- Entrées : fichier, glisser-déposer, collage ----------
  pickBtn.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) void handleFile(f); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleFile(f);
  });
  document.addEventListener('paste', (e) => {
    if (dialog.open || !side.isConnected) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) { e.preventDefault(); void handleFile(f); }
  });

  async function handleFile(file: Blob) {
    if (busy) return;
    if (!file.type.startsWith('image/')) return setStatus('Ce fichier n’est pas une image.', true);
    setBusy(true);
    setStatus('Envoi de la capture à Gemini…');
    try {
      const img = await prepareImage(file);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      const { data, error } = await supabase.functions
        .invoke('read-screenshot', {
          body: { image: img.data, mimeType: img.mimeType, mode: 'market' },
          signal: ctrl.signal,
        })
        .finally(() => clearTimeout(timer));
      if (ctrl.signal.aborted) throw new Error('Pas de réponse après 2 minutes. Réessaie, ou change de modèle Gemini.');
      if (error) throw new Error(await functionErrorMessage(error));
      const rows: OcrRow[] = Array.isArray(data?.rows) ? data.rows : [];
      if (rows.length === 0) return setStatus('Aucun objet détecté sur cette capture.', true);
      lines = await buildLines(rows);
      setStatus('');
      openReview(img.url);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Préparation des lignes ----------
  async function buildLines(rows: OcrRow[]): Promise<Line[]> {
    const groups = new Map<string, { raw: string; truncated: boolean; listings: number; price: number | null }>();
    for (const r of rows) {
      const raw = String(r.name ?? '').trim();
      if (!raw) continue;
      const price = Number.isSafeInteger(r.unit_price) && (r.unit_price as number) > 0 ? (r.unit_price as number) : null;
      const k = raw.toLowerCase();
      const g = groups.get(k);
      if (!g) groups.set(k, { raw, truncated: !!r.truncated || /(\.\.\.|…)$/.test(raw), listings: 1, price });
      else {
        g.listings++;
        if (price != null && (g.price == null || price < g.price)) g.price = price;
      }
    }
    const list = [...groups.values()];
    const { data: matches, error } = await supabase.rpc('match_items', { names: list.map((g) => g.raw) });
    if (error) throw new Error(`Rapprochement des noms impossible : ${error.message}`);

    const items = opts.getItems();
    return list.map((g, i) => {
      const m = (matches as { idx: number; item_id: number | null; score: number | null }[]).find((x) => x.idx === i + 1);
      const itemId = m?.item_id ?? null;
      const bound = itemId != null && items.find((it) => it.id === itemId)?.bound === true;
      return {
        key: i, raw: g.raw, truncated: g.truncated, listings: g.listings, price: g.price,
        score: m?.score ?? null,
        action: itemId ? 'item' : 'new',
        itemId,
        include: g.price != null && !bound,
        newName: g.raw.replace(/\s*(\.\.\.|…)$/, ''),
        newCategory: '',
        newGrade: 'white',
      };
    });
  }

  // ---------- Fenêtre de validation ----------
  function openReview(imageUrl: string) {
    const hasNew = lines.some((l) => l.action === 'new');
    dialog.innerHTML = `
      <form class="review stack">
        <div class="review-head">
          <div>
            <h2>Prix détectés</h2>
            <p class="muted">Vérifie chaque ligne avant d’enregistrer. Les relevés seront enregistrés à ton nom.</p>
          </div>
          <a href="${imageUrl}" target="_blank" rel="noopener" title="Ouvrir la capture en grand">
            <img class="review-thumb" src="${imageUrl}" alt="Capture envoyée" />
          </a>
        </div>
        ${hasNew ? `<label class="bulk">Catégorie de tous les nouveaux objets
          <select data-bulk><option value="">Choisir…</option>
            ${CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}</select></label>` : ''}
        <div class="table-wrap"><table class="review-table">
          <thead><tr><th><span class="sr-only">Inclure</span></th><th>Lu sur la capture</th><th>Objet</th><th class="num">Prix unitaire</th></tr></thead>
          <tbody></tbody>
        </table></div>
        <p class="error" hidden></p>
        <div class="review-foot">
          <span class="muted review-count"></span>
          <div class="row-end">
            <button type="button" class="btn ghost" data-review="cancel">Annuler</button>
            <button type="submit" class="btn primary">Enregistrer les prix</button>
          </div>
        </div>
      </form>`;
    renderRows();
    dialog.showModal();
    dialog.querySelector<HTMLSelectElement>('select[data-f=action]')?.focus();
  }

  function renderRows() {
    const items = [...opts.getItems()].sort((a, b) => a.name.localeCompare(b.name));
    const tbody = dialog.querySelector('tbody')!;
    tbody.innerHTML = lines.map((l) => {
      const item = l.itemId != null ? items.find((it) => it.id === l.itemId) : undefined;
      const status = l.action === 'new' ? ['new', 'Inconnu']
        : l.action === 'ignore' ? ['off', 'Ignoré']
        : (l.score ?? 0) >= 0.9 ? ['ok', 'Reconnu'] : ['maybe', 'À vérifier'];
      const chips = [
        `<span class="chip ${status[0]}">${status[1]}</span>`,
        l.truncated ? '<span class="chip off">Nom tronqué</span>' : '',
        l.listings > 1 ? `<span class="chip off">${l.listings} annonces, prix le plus bas</span>` : '',
        item?.bound ? '<span class="chip off">Lié : pas de prix</span>' : '',
      ].join('');
      const selected = l.action === 'item' ? `item:${l.itemId}` : l.action;
      const options = `
        <option value="ignore"${selected === 'ignore' ? ' selected' : ''}>Ignorer</option>
        <option value="new"${selected === 'new' ? ' selected' : ''}>Créer un nouvel objet</option>
        <optgroup label="Objets connus">${items.map((it) =>
          `<option value="item:${it.id}"${selected === `item:${it.id}` ? ' selected' : ''}>${escapeHtml(it.name)}</option>`).join('')}
        </optgroup>`;
      const newFields = l.action !== 'new' ? '' : `
        <div class="new-fields">
          <input data-f="newName" value="${escapeHtml(l.newName)}" aria-label="Nom complet du nouvel objet" placeholder="Nom complet" />
          <select data-f="newCategory" aria-label="Catégorie"><option value="">Catégorie…</option>
            ${CATEGORIES.map((c) => `<option value="${c.key}"${l.newCategory === c.key ? ' selected' : ''}>${c.label}</option>`).join('')}</select>
          <select data-f="newGrade" aria-label="Rareté">
            ${GRADES.map((g) => `<option value="${g.key}"${l.newGrade === g.key ? ' selected' : ''}>${g.label}</option>`).join('')}</select>
        </div>`;
      return `<tr data-key="${l.key}" class="st-${status[0]}${l.include ? '' : ' excluded'}">
        <td><input type="checkbox" data-f="include" ${l.include ? 'checked' : ''} aria-label="Inclure cette ligne" /></td>
        <td><div class="raw">${escapeHtml(l.raw)}</div><div class="chips">${chips}</div></td>
        <td><select data-f="action" aria-label="Objet correspondant">${options}</select>${newFields}</td>
        <td class="num"><input class="price-input" data-f="price" inputmode="numeric" value="${l.price == null ? '' : formatKinah(l.price)}"
          placeholder="illisible" aria-label="Prix unitaire" /></td>
      </tr>`;
    }).join('');
    updateCount();
  }

  function updateCount() {
    const n = lines.filter((l) => l.include).length;
    dialog.querySelector('.review-count')!.textContent = `${n} prix à enregistrer`;
  }

  function lineOf(el: Element): Line | undefined {
    const tr = el.closest<HTMLElement>('tr[data-key]');
    return tr ? lines.find((l) => l.key === Number(tr.dataset.key)) : undefined;
  }

  dialog.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.matches('[data-bulk]')) {
      for (const l of lines) if (l.action === 'new') l.newCategory = el.value;
      return renderRows();
    }
    const l = lineOf(el);
    if (!l) return;
    switch (el.dataset.f) {
      case 'include': l.include = (el as HTMLInputElement).checked; break;
      case 'action': {
        const v = el.value;
        if (v === 'ignore') { l.action = 'ignore'; l.include = false; }
        else if (v === 'new') { l.action = 'new'; l.itemId = null; l.include = l.price != null; }
        else {
          l.action = 'item';
          l.itemId = Number(v.slice(5));
          l.score = 1;
          l.include = l.price != null && !opts.getItems().find((it) => it.id === l.itemId)?.bound;
        }
        break;
      }
      case 'newCategory': l.newCategory = el.value; return;
      case 'newGrade': l.newGrade = el.value; return;
      default: return;
    }
    renderRows();
  });

  dialog.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const l = lineOf(el);
    if (!l) return;
    if (el.dataset.f === 'newName') l.newName = el.value;
    if (el.dataset.f === 'price') {
      l.price = parseKinah(el.value);
      if (l.price != null && l.action !== 'ignore' && !l.include) {
        l.include = true;
        el.closest('tr')!.classList.remove('excluded');
        el.closest('tr')!.querySelector<HTMLInputElement>('[data-f=include]')!.checked = true;
      }
      updateCount();
    }
  });

  dialog.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-review=cancel]')) dialog.close();
  });

  dialog.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const errEl = form.querySelector<HTMLElement>('.error')!;
    const fail = (msg: string) => { errEl.hidden = false; errEl.textContent = msg; };
    errEl.hidden = true;

    const chosen = lines.filter((l) => l.include && l.action !== 'ignore');
    if (chosen.length === 0) return fail('Aucune ligne cochée.');
    for (const l of chosen) {
      if (l.price == null) return fail(`Prix manquant pour « ${l.raw} ».`);
      if (l.action === 'new') {
        if (l.newName.trim().length < 2) return fail(`Indique le nom complet de « ${l.raw} ».`);
        if (!l.newCategory) return fail(`Choisis une catégorie pour « ${l.newName} ».`);
      }
    }

    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true;
    try {
      const records: { item_id: number; price: number }[] = [];
      for (const l of chosen) {
        let id = l.itemId;
        if (l.action === 'new') id = await createItem(l);
        records.push({ item_id: id!, price: l.price! });
      }
      const { error } = await supabase.from('price_records').insert(records);
      if (error) throw new Error(`Enregistrement des prix impossible : ${error.message}`);
      dialog.close();
      await opts.onSaved();
      setStatus(`${records.length} prix enregistré${records.length > 1 ? 's' : ''}.`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
    }
  });

  async function createItem(l: Line): Promise<number> {
    const name = l.newName.trim().replace(/\s+/g, ' ');
    const { data, error } = await supabase.from('items')
      .insert({ name, category: l.newCategory, grade: l.newGrade }).select('id').single();
    if (!error) return data.id;
    if (error.code === '23505') {
      // Un mate l'a créé entre-temps : on récupère l'objet existant
      const existing = await supabase.from('items').select('id').eq('name_norm', name.toLowerCase()).single();
      if (existing.data) return existing.data.id;
    }
    throw new Error(`Création de « ${name} » impossible : ${error.message}`);
  }
}

// ---------- Utilitaires ----------
async function prepareImage(file: Blob): Promise<{ data: string; mimeType: string; url: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Conversion de l’image impossible.'))), 'image/jpeg', 0.92));
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('Lecture de l’image impossible.'));
    r.readAsDataURL(blob);
  });
  return { data: dataUrl.split(',')[1], mimeType: 'image/jpeg', url: URL.createObjectURL(blob) };
}

async function functionErrorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null);
    if (body?.error) return body.error;
  }
  return error instanceof Error ? `Lecture impossible : ${error.message}` : 'Lecture impossible.';
}
