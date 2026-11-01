// DC-147c: the usage sentences shared by the row's bars and the item panel (docs/research/usage-representation.md 5.4 and
// 6.1: the headline is in days, never a count; dates are UTC). Light DOM free: strings only.
import type { UsageHeadline } from '../../domain/usage-series';
import type { RowBars } from '../../domain/usage-bars';
import { DAY } from '../../domain/format';
import { formatDate, formatNumber, t, tn } from '../../i18n';

/** "3 March 2026", the UTC day `daysAgo` before the scan. */
export const longDate = (ref: number, daysAgo: number): string =>
  formatDate((Math.floor(ref / DAY) - daysAgo) * DAY, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A YYYY-MM-DD UTC date as "3 March 2026". */
export const longIso = (iso: string): string => formatDate(Date.parse(`${iso}T00:00:00Z`), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The panel's headline sentence for the series (span 365 or 730); `fam`: several layers shown together. */
export function sayHeadline(h: UsageHeadline, fam: boolean): string {
  if (h.allNotRead) return t(fam ? 'review.panel.head.notReadFam' : 'review.panel.head.notRead');
  const y = h.span === 365 ? 'y1' : 'y2';
  let s: string;
  if (h.lastUse) s = tn(`review.panel.head.used.${y}`, h.requestDays, { count: formatNumber(h.requestDays), date: longIso(h.lastUse.date) });
  else if (h.lastUseEver) s = t(`review.panel.head.noneBut.${y}`, { date: longIso(h.lastUseEver.date) });
  else s = t(h.sweepTouchDays > 0 ? `review.panel.head.sweepOnly.${y}` : `review.panel.head.none.${y}`);
  return h.notReadDays > 0 && !h.notReadBefore ? `${s} ${t('review.panel.head.someGap')}` : s;
}

/** The row's sentence for the past year, from its bars (the accessible name of the bars button). */
export function sayRowHeadline(b: RowBars, ref: number, fam: boolean): string {
  switch (b.kind) {
    case 'notRead': return t(fam ? 'review.panel.head.notReadFam' : 'review.panel.head.notRead');
    case 'used': return tn('review.panel.head.used.y1', b.requestDays, { count: formatNumber(b.requestDays), date: longDate(ref, b.lastUse ?? 0) });
    case 'sweepOnly': return t('review.panel.head.sweepOnly.y1');
    default: return t('review.panel.head.none.y1');
  }
}

/** The short caption beside the row's bars. */
export function sayRowCaption(b: RowBars): string {
  switch (b.kind) {
    case 'notRead': return t('review.bars.cap.notRead');
    case 'used': return tn('review.bars.cap.used', b.requestDays, { count: formatNumber(b.requestDays) });
    case 'sweepOnly': return t('review.bars.cap.sweepOnly');
    default: return t('review.bars.cap.none');
  }
}

/** "1,234 requests on 12 days" (plus sweep touches and gaps) for a month: the card's and the panel's month readout. */
export function sayMonth(m: { requests: number; requestDays: number; swept: number; notRead: boolean; partNotRead: boolean }, current = false): string[] {
  if (m.notRead) return [t('review.panel.tip.monthNotRead')];
  // The scan's own month has only just begun: say so, so "No requests" isn't read as a quiet month.
  if (current) return [...sayMonth(m), t('review.panel.tip.soFar')];
  const out = m.requests === 0 ? [t('review.panel.tip.none')] : [tn('review.panel.tip.month', m.requests, { count: formatNumber(m.requests), days: tn('common.unit.days', m.requestDays, { count: formatNumber(m.requestDays) }) })];
  if (m.swept > 0) out.push(t('review.panel.tip.monthSweep', { count: formatNumber(m.swept) }));
  if (m.partNotRead) out.push(t('review.panel.tip.monthGap'));
  return out;
}

/** "March 2026" for a YYYY-MM month. */
export const monthName = (ym: string): string => formatDate(Date.parse(`${ym}-01T00:00:00Z`), { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "Mar" for a YYYY-MM month. */
export const monthShort = (ym: string): string => formatDate(Date.parse(`${ym}-01T00:00:00Z`), { month: 'short', timeZone: 'UTC' });
