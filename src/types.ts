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

/** Types d'arme pour ranger les recettes, dans l'ordre d'affichage. */
export const WEAPON_TYPES = [
  { key: 'greatsword', label: 'Espadon' },
  { key: 'sword_shield', label: 'Épée et bouclier' },
  { key: 'mace_shield', label: 'Masse et bouclier' },
  { key: 'spellbook', label: 'Grimoire' },
  { key: 'orb', label: 'Orbe' },
  { key: 'staff', label: 'Bâton' },
  { key: 'bow', label: 'Arc' },
  { key: 'daggers', label: 'Dagues' },
] as const;
export type WeaponTypeKey = (typeof WEAPON_TYPES)[number]['key'];

/** Devine le type d'arme d'après le nom anglais de l'objet. */
export function detectWeaponType(name: string): WeaponTypeKey | null {
  const n = name.toLowerCase();
  if (n.includes('greatsword')) return 'greatsword';
  if (n.includes('mace')) return 'mace_shield';
  if (n.includes('sword')) return 'sword_shield';
  if (n.includes('spellbook')) return 'spellbook';
  if (/\borb\b/.test(n)) return 'orb';
  if (n.includes('staff')) return 'staff';
  if (/\bbow\b/.test(n)) return 'bow';
  if (n.includes('dagger')) return 'daggers';
  return null;
}

/** Le Marché n'affiche pas les armes craftées, sauf celles en Orichalcum. */
export const inMarket = (it: { category: CategoryKey; name: string }) =>
  it.category !== 'weapon' || /orichalcum/i.test(it.name);
