// DC-147c: the item panel's two usage charts as SVG strings (calendar of request days; monthly bars), and the readout
// lines for a day or a month. Strings, not templates: a 2-year calendar is 730 cells, built in one go.
import type { UsageDay, UsageMonth, UsageSeries } from '../../domain/usage-series';
import { DAY } from '../../domain/format';
import { formatDate, formatNumber, t, tn } from '../../i18n';
import { HATCH_ID } from './dc-usage-bars';
import { monthName, sayMonth } from './usage-words';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** 1–9, 10–99, 100–999, 1,000+: fixed decades, so a shade means the same on every layer (prototype README). */
export const bucket = (n: number): 1 | 2 | 3 | 4 => (n < 10 ? 1 : n < 100 ? 2 : n < 1000 ? 3 : 4);

/** The class of a calendar cell: not read, no requests, sweep touch, or a decade of requests. */
export function cellClass(d: UsageDay): string {
  if (d.notRead) return 'nr';
  if (!(d.requests > 0)) return 'c0';
  return d.sweepTouch ? 'sw' : `q${bucket(d.requests)}`;
}

const LBL_W = 30, MON_H = 16;

/**
 * The calendar: a column per week (Monday first), a row per weekday, one cell per UTC day. One SVG per year (two for the
 * 2-year span), or per half-year when a year's 54 weeks do not fit at 10 px. The last day of real use is ringed.
 */
export function calendarSvg(s: UsageSeries, width: number): string {
  const span = s.days.length;
  const perYear = (width - LBL_W) / 54 >= 10;
  const segLen = perYear ? 365 : 183;
  const segs: [number, number][] = [];
  for (let a = span - 1; a >= 0; a -= segLen) segs.push([a, Math.max(0, a - segLen + 1)]);
  // A 2-year span cut at 365 leaves one day over (730 = 2 * 365): fine, cut by days, not calendar years.
  const weeksMax = Math.ceil(segLen / 7) + 1;
  const step = Math.max(5, Math.min(14, Math.floor((width - LBL_W) / weeksMax)));
  const cell = step - 2;
  const last = s.headline.lastUse?.daysAgo ?? -1;
  const wd = (tm: number) => (new Date(tm).getUTCDay() + 6) % 7;
  const mShort = (tm: number) => formatDate(tm, { month: 'short', timeZone: 'UTC' });
  const mYear = (tm: number) => formatDate(tm, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dayNames = [0, 2, 4].map((k) => formatDate(Date.UTC(2024, 0, 1 + k), { weekday: 'short', timeZone: 'UTC' }));
  return segs.map(([a, b]) => {
    const t0 = ms((s.days[a] as UsageDay).date);
    const mon0 = t0 - wd(t0) * DAY;
    const tEnd = ms((s.days[b] as UsageDay).date);
    const cols = Math.floor((tEnd - mon0) / DAY / 7) + 1;
    const w = LBL_W + cols * step, h = MON_H + 7 * step;
    let cells = '', months = '', today = '';
    const labels: { x: number; tm: number; first: boolean }[] = [];
    const gapCols = new Set<number>();
    for (let d = a; d >= b; d--) {
      const day = s.days[d] as UsageDay;
      const tm = ms(day.date);
      const col = Math.floor((tm - mon0) / DAY / 7), row = wd(tm);
      const x = LBL_W + col * step, y = MON_H + row * step;
      let cls = cellClass(day);
      if (cls === 'nr') gapCols.add(col);
      const inset = cls === 'sw' ? 0.5 : 0;
      if (d === last) cls += ' last';
      cells += `<rect class="${cls}" data-d="${d}" x="${x + inset}" y="${y + inset}" width="${cell - 2 * inset}" height="${cell - 2 * inset}" rx="2"/>`;
      // Today (the scan day, day 0): a ring just outside the cell, so it sits with the last-used ring and the cursor, and a
      // small pointer above its week column, under the month labels' baseline.
      if (d === 0) {
        const cx = x + cell / 2;
        today = `<rect class="today" x="${x - 2}" y="${y - 2}" width="${cell + 4}" height="${cell + 4}" rx="3"/><path class="today-pt" d="M${cx - 3.5} ${MON_H - 4}h7l-3.5 4z"/>`;
      }
      if (new Date(tm).getUTCDate() === 1 || d === a) labels.push({ x, tm, first: d === a });
    }
    // Month labels: the segment's first one is dropped when the next month starts too close to it (it would overlap), and
    // the first label shown carries the year, as January does.
    let lastX = -1e9, shown = 0;
    labels.forEach((l, k) => {
      const next = labels[k + 1];
      if (l.first && next && next.x - l.x < 44) return;
      if (l.x - lastX < 30) return;
      const lbl = shown === 0 || new Date(l.tm).getUTCMonth() === 0 ? mYear(l.tm) : mShort(l.tm);
      months += `<text x="${l.x}" y="${MON_H - 5}">${esc(lbl)}</text>`;
      lastX = l.x + (shown === 0 || new Date(l.tm).getUTCMonth() === 0 ? 22 : 0); shown++;
    });
    let band = '';
    if (gapCols.size >= 3) {
      const c0 = Math.min(...gapCols), c1 = Math.max(...gapCols);
      const cx = LBL_W + ((c0 + c1 + 1) / 2) * step;
      const tw = 64;
      band = `<rect class="nr-lbl" x="${cx - tw / 2}" y="${MON_H + 2.5 * step - 2}" width="${tw}" height="${2 * step + 4}" rx="3"/><text class="nr-txt" x="${cx}" y="${MON_H + 3.5 * step + 4}" text-anchor="middle">${esc(t('review.panel.legNotRead'))}</text>`;
    }
    const days = dayNames.map((l, k) => `<text x="0" y="${MON_H + k * 2 * step + cell - 1}">${esc(l)}</text>`).join('');
    return `<svg class="cal" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><g class="axis">${months}${days}</g>${cells}${band}${today}</svg>`;
  }).join('');
}

const nice = (v: number) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const compact = (v: number) => formatNumber(v, { notation: 'compact', maximumFractionDigits: 1 });

/** Monthly bars (linear, the panel's own scale): real requests, the sweep share lighter on top, not-read months hatched. */
export function monthBarsSvg(s: UsageSeries, width: number): string {
  const H = 150, AX = 40, XH = 30, TOPP = 8;
  const mo = s.months;
  const read = (m: UsageMonth) => m.notReadDays < m.days;
  const max = nice(Math.max(1, ...mo.filter(read).map((m) => m.requests + m.sweptRequests)));
  const plotW = width - AX, plotH = H - XH - TOPP;
  const slot = plotW / mo.length, bw = Math.max(4, Math.min(22, slot - 3));
  const y = (v: number) => TOPP + plotH - (v / max) * plotH;
  let g = '';
  for (const v of [0, max / 2, max]) g += `<line class="grid" x1="${AX}" x2="${width}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${AX - 6}" y="${y(v) + 4}" text-anchor="end">${esc(compact(v))}</text>`;
  let bars = '';
  const every = mo.length > 14 ? 3 : 1;
  mo.forEach((m, k) => {
    const x = AX + k * slot + (slot - bw) / 2;
    const full = !read(m);
    // DC-149: each month is a group (its bars, hit area and labels), so the console look can light the hovered or current
    // month's label; the top segment is marked for its rounded cap there. The labels sit below the hit areas, so the
    // order inside the SVG changes nothing in the standard look.
    bars += '<g class="mcol">';
    if (m.notReadDays) bars += `<rect x="${x}" y="${TOPP}" width="${bw}" height="${plotH}" rx="2" fill="url(#${HATCH_ID})" opacity="${full ? 1 : 0.45}"/>`;
    if (!full) {
      const hr = y(0) - y(m.requests), hs = y(0) - y(m.sweptRequests);
      if (hr > 0) bars += `<rect class="b-real${hs > 0 ? '' : ' b-top'}" x="${x}" y="${y(m.requests)}" width="${bw}" height="${Math.max(1, hr)}" rx="1"/>`;
      if (hs > 0) bars += `<rect class="b-sweep b-top" x="${x}" y="${y(m.requests + m.sweptRequests)}" width="${bw}" height="${Math.max(1, hs - (hr > 0 ? 1 : 0))}" rx="1"/>`;
    }
    bars += `<rect class="hit" data-m="${k}" x="${AX + k * slot}" y="0" width="${slot}" height="${H - XH + 4}"/>`;
    // The console look's label block: hidden here (a presentation attribute, so the console CSS can show it).
    bars += `<rect class="mblk" display="none" x="${AX + k * slot + 1}" y="${H - XH + 5}" width="${Math.max(1, slot - 2)}" height="14" rx="7"/>`;
    const tm = ms(`${m.month}-01`);
    const short = esc(formatDate(tm, { month: 'short', timeZone: 'UTC' }).slice(0, every === 1 && slot < 26 ? 1 : 3));
    if ((mo.length - 1 - k) % every === 0) bars += `<text class="ax" x="${x + bw / 2}" y="${H - XH + 16}" text-anchor="middle">${short}</text>`;
    // An unlabelled month (2 years: every third is labelled) still names itself inside the console block when lit.
    else bars += `<text class="ax mblk-t" display="none" x="${x + bw / 2}" y="${H - XH + 16}" text-anchor="middle">${short}</text>`;
    if (m.month.endsWith('-01') || k === 0) bars += `<text class="ax yr" x="${x}" y="${H - 2}">${m.month.slice(0, 4)}</text>`;
    bars += '</g>';
  });
  return `<svg class="mbars" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" aria-hidden="true">${g}<line class="base" x1="${AX}" x2="${width}" y1="${y(0)}" y2="${y(0)}"/>${bars}</svg>`;
}

/** The readout for a day: the UTC date, then the requests (and per member for "all together"). */
export function dayReadout(s: UsageSeries, d: number, names: string[]): { head: string; lines: string[] } {
  const day = s.days[d] as UsageDay;
  const head = t('review.panel.tip.date', { date: formatDate(ms(day.date), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) });
  // The scan day had only just begun: say so, so a quiet "no requests" isn't read as a quiet day.
  if (d === 0) {
    const r = dayLines(s, day, names, head);
    return { head: `${head} · ${t(isToday(s) ? 'review.panel.legToday' : 'review.panel.legScanDay')}`, lines: [...r.lines, t('review.panel.tip.daySoFar')] };
  }
  return dayLines(s, day, names, head);
}

/** Whether the series' newest day (the scan day) is today in UTC. */
export const isToday = (s: UsageSeries, now = Date.now()): boolean => (s.days[0]?.date ?? '') === new Date(now).toISOString().slice(0, 10);

function dayLines(s: UsageSeries, day: UsageDay, names: string[], head: string): { head: string; lines: string[] } {
  if (day.notRead) return { head, lines: [t('review.panel.tip.notRead')] };
  if (!(day.requests > 0)) return { head, lines: [t('review.panel.tip.none')] };
  const req = tn('review.panel.tip.req', day.requests, { count: formatNumber(day.requests) });
  const lines = [day.sweepTouch ? t('review.panel.tip.sweep', { requests: req }) : req];
  if (day.byMember) day.byMember.forEach((n, k) => { if (n > 0) lines.push(t('review.panel.tip.member', { name: names[k] ?? '', count: formatNumber(n) })); });
  return { head, lines };
}

/** The readout for a month of the series. */
export function monthReadout(m: UsageMonth, current = false): { head: string; lines: string[] } {
  return {
    head: monthName(m.month),
    lines: sayMonth({ requests: m.requests, requestDays: m.requestDays, swept: m.sweptRequests, notRead: m.notReadDays >= m.days, partNotRead: m.notReadDays > 0 && m.notReadDays < m.days }, current),
  };
}
