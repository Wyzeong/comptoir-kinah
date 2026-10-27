export const CATEGORIES = [
  { key: 'gathering', label: 'Gathering' },
  { key: 'weapon', label: 'Armes' },
  { key: 'accessory', label: 'Bijoux' },
  { key: 'armor', label: 'Armure' },
  { key: 'material', label: 'Composants de craft' },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];
export const categoryLabel = (k: CategoryKey) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

/** Couleur de rareté affichée dans le jeu. */
export const GRADES = [
  { key: 'white', label: 'Blanc' },
  { key: 'green', label: 'Vert' },
  { key: 'blue', label: 'Bleu' },
  { key: 'gold', label: 'Or' },
  { key: 'orange', label: 'Orange' },
  { key: 'purple', label: 'Violet' },
] as const;
export type GradeKey = (typeof GRADES)[number]['key'];

export interface HistoryEntry {
  id: number;
  p: number;      // prix
  t: string;      // date ISO
  uid: string | null;
  by: string | null;
}

export interface ItemOverview {
  id: number;
  name: string;
  category: CategoryKey;
  grade: GradeKey;
  bound: boolean;
  created_at: string;
  current_price: number | null;
  previous_price: number | null;
  last_recorded_at: string | null;
  min_price: number | null;
  max_price: number | null;
  avg_price: number | null;
  history: HistoryEntry[]; // du plus récent au plus ancien, 30 max
}

/** Métiers et sous-catégories de craft, comme dans le menu du jeu (sans « Materials »). */
export const PROFESSIONS = [
  { key: 'blacksmithing', label: 'Blacksmithing', subs: [
    { key: 'greatsword', label: 'Greatsword' }, { key: 'longsword', label: 'Longsword' }, { key: 'dagger', label: 'Dagger' },
    { key: 'mace', label: 'Mace' }, { key: 'guard', label: 'Guard' }] },
  { key: 'armorsmithing', label: 'Armorsmithing', subs: [
    { key: 'helm', label: 'Helm' }, { key: 'pauldrons', label: 'Pauldrons' }, { key: 'top', label: 'Top' },
    { key: 'legs', label: 'Legs' }, { key: 'gloves', label: 'Gloves' }, { key: 'shoes', label: 'Shoes' }, { key: 'cloak', label: 'Cloak' }] },
  { key: 'handicrafting', label: 'Handicrafting', subs: [
    { key: 'bow', label: 'Bow' }, { key: 'staff', label: 'Staff' }, { key: 'necklace', label: 'Necklace' },
    { key: 'earrings', label: 'Earrings' }, { key: 'ring', label: 'Ring' }, { key: 'bracelet', label: 'Bracelet' }] },
  { key: 'alchemy', label: 'Alchemy', subs: [
    { key: 'spellbook', label: 'Spellbook' }, { key: 'orb', label: 'Orb' }, { key: 'potion', label: 'Potion' },
    { key: 'scroll', label: 'Scroll' }, { key: 'manastone', label: 'Manastone' }] },
] as const;

export type ProfessionKey = (typeof PROFESSIONS)[number]['key'];
export type CraftTypeKey = (typeof PROFESSIONS)[number]['subs'][number]['key'];

export const professionOf = (t: string | null) => PROFESSIONS.find((p) => p.subs.some((s) => s.key === t))?.key ?? null;
export const craftTypeLabel = (t: string | null) =>
  PROFESSIONS.flatMap((p) => [...p.subs]).find((s) => s.key === t)?.label ?? 'Non classée';

/** Devine la sous-catégorie d'après le nom anglais de l'objet. */
export function detectCraftType(name: string): CraftTypeKey | null {
  const n = name.toLowerCase();
  const rules: [RegExp, CraftTypeKey][] = [
    [/greatsword/, 'greatsword'], [/longsword|\bsword\b/, 'longsword'], [/dagger/, 'dagger'], [/\bmace\b/, 'mace'],
    [/\bguard\b|\bshield\b/, 'guard'],
    [/\bhelm|\bhat\b|\bhood\b|headgear/, 'helm'], [/pauldron|shoulder/, 'pauldrons'],
    [/breastplate|jerkin|tunic|robe|hauberk|chest|\btop\b/, 'top'], [/greaves|leggings|pants|\blegs?\b/, 'legs'],
    [/glove|gauntlet/, 'gloves'], [/boots|shoes/, 'shoes'], [/cloak|cape/, 'cloak'],
    [/\bbow\b/, 'bow'], [/\bstaff\b/, 'staff'], [/necklace|amulet|pendant/, 'necklace'], [/earring/, 'earrings'],
    [/\bring\b/, 'ring'], [/bracelet/, 'bracelet'],
    [/spellbook/, 'spellbook'], [/\borb\b/, 'orb'], [/potion/, 'potion'], [/scroll/, 'scroll'], [/manastone/, 'manastone'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? null;
}

/** Le Marché n'affiche pas les armes craftées, sauf celles en Orichalcum. */
export const inMarket = (it: { category: CategoryKey; name: string }) =>
  it.category !== 'weapon' || /orichalcum/i.test(it.name);
