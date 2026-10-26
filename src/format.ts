const nf = new Intl.NumberFormat('fr-FR');
const df = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
});

export const formatKinah = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));
export const formatDateTime = (iso: string | null | undefined) => (iso ? df.format(new Date(iso)) : '—');

/** Accepte « 1 250 000 », « 1.250.000 », « 1,250,000 ». */
export function parseKinah(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type Trend = { dir: 'up' | 'down' | 'flat' | 'none'; pct: number };

export function trendOf(current: number | null, previous: number | null): Trend {
  if (current == null || previous == null) return { dir: 'none', pct: 0 };
  if (current === previous) return { dir: 'flat', pct: 0 };
  const pct = ((current - previous) / previous) * 100;
  return { dir: current > previous ? 'up' : 'down', pct };
}

/** Petite courbe SVG, valeurs de la plus ancienne à la plus récente. */
export function sparkline(values: number[], w = 120, h = 32): string {
  if (values.length < 2) return '<span class="muted">—</span>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = w / (values.length - 1);
  const y = (v: number) => (max === min ? h / 2 : h - 3 - ((v - min) / (max - min)) * (h - 6));
  const pts = values.map((v, i) => [Number((i * step).toFixed(1)), Number(y(v).toFixed(1))]);
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx}" cy="${ly}" r="2.5" fill="currentColor"/></svg>`;
}
