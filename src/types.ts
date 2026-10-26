export const CATEGORIES = [
  { key: 'gathering', label: 'Gathering' },
  { key: 'weapon', label: 'Armes' },
  { key: 'accessory', label: 'Bijoux' },
  { key: 'armor', label: 'Armure' },
  { key: 'material', label: 'Composants de craft' },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

export const categoryLabel = (k: CategoryKey) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

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
