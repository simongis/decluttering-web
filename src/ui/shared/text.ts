// Small pure text helpers shared by the review components. No DOM.
import { fmtInt } from '../../domain/format';
import { t, tn } from '../../i18n';

const pluralKeys: Record<string, string> = {
  'owner|owners': 'common.unit.owners', 'item|items': 'common.unit.items', 'service|services': 'common.unit.services',
  'layer|layers': 'common.unit.layers', 'map or app|maps or apps': 'common.unit.maps', 'other owner|other owners': 'common.unit.otherOwners',
  'day|days': 'common.unit.days', 'year|years': 'common.unit.years', 'month|months': 'common.unit.months', 'credit|credits': 'common.unit.credits',
  'small service|small services': 'common.unit.smallServices', 'owner has|owners have': 'common.unit.ownerHas', 'send was|sends were': 'common.unit.sendWas',
  'digest|digests': 'common.unit.digests', 'email|emails': 'common.unit.emails', 'layer looks|layers look': 'common.unit.layerLooks',
  'service looks|services look': 'common.unit.serviceLooks', 'map or app uses|maps or apps use': 'common.unit.mapsAppsUse',
};

export const plural = (n: number, one: string, many: string): string => {
  const key = pluralKeys[`${one}|${many}`];
  return key ? tn(key as Parameters<typeof tn>[0], n, { count: fmtInt(n) }) : tn('common.quantity', n, { count: fmtInt(n), unit: n === 1 ? one : many });
};

/** Credits a month: one decimal under 10, whole numbers above. */
export const credit = (c: number): string => t('common.creditNumber', { amount: c < 10 ? c.toFixed(1) : fmtInt(c) });

export const firstName = (fullName: string): string => fullName.split(' ')[0] || fullName;

export const roleLabel = (role?: string): string =>
  role === 'org_admin' ? t('common.role.admin') : role === 'org_publisher' ? t('common.role.publisher') : t('common.role.member');

/** Weeks since a digest, at least 1, for "Nudged 3 weeks ago". */
export const weeksAgo = (days: number | null): number => Math.max(1, Math.round((days ?? 0) / 7));

/** Relative words for a nudge sent today, yesterday, or earlier. */
export function agoText(days: number | null): string {
  const d = Math.max(0, Math.floor(days ?? 0));
  if (d === 0) return t('common.ago.today');
  if (d === 1) return t('common.ago.yesterday');
  if (d < 7) return tn('common.ago.days', d, { count: String(d) });
  if (d < 63) { const w = Math.round(d / 7); return tn('common.ago.weeks', w, { count: String(w) }); }
  const m = Math.round(d / 30.4);
  return tn('common.ago.months', m, { count: String(m) });
}
