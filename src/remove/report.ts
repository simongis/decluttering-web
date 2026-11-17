// ADR 0016: a record of a delete run, as CSV the user downloads from the result. ArcGIS Online does not tell owners when
// an admin deletes their items, and the app keeps no record of its own (no backend, ADR 0001), so this is the trace.
// Built in the browser from what the run already knows; nothing is sent anywhere.
import type { RemovalCandidate } from './plan';
import type { RemoveOutcome } from './remover';

export interface ReportMeta {
  /** When the run finished. */
  at: Date;
  /** Who deleted (the signed-in username). */
  by: string;
  org?: string;
}

export const REPORT_COLUMNS = [
  'deleted_at', 'org', 'deleted_by', 'item_id', 'title', 'owner', 'size_mb', 'views', 'used_by_maps_apps', 'result', 'reason', 'removed_ids', 'message',
] as const;

/**
 * One field. Quoted when it holds a comma, quote, line break or edge space. Text that a spreadsheet would run as a formula
 * (starting with = + - @, a tab or a carriage return) gets a leading apostrophe, so a layer title can't become a formula.
 */
export function csvField(v: string | number | null | undefined, text = true): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function result(o: RemoveOutcome | undefined): { result: string; reason: string } {
  if (!o) return { result: 'not run', reason: '' };
  if (o.ok) return { result: 'deleted', reason: '' };
  return { result: o.removed.length ? 'partly deleted' : 'not deleted', reason: o.reason };
}

/** The CSV: a header row, then one row per layer in the run, in the order they were listed. Lines end with CRLF. */
export function deleteReportCsv(items: readonly RemovalCandidate[], outcomes: readonly RemoveOutcome[], meta: ReportMeta): string {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const at = meta.at.toISOString();
  const lines = [REPORT_COLUMNS.join(',')];
  for (const c of items) {
    const o = byId.get(c.id);
    const r = result(o);
    lines.push([
      csvField(at, false), csvField(meta.org ?? ''), csvField(meta.by), csvField(c.id, false), csvField(c.title), csvField(c.owner),
      csvField(c.sizeMB === null ? '' : Math.round(c.sizeMB * 100) / 100, false), csvField(c.views.map((v) => v.id).join(' '), false),
      csvField(c.usedBy, false), csvField(r.result, false), csvField(r.reason, false), csvField(o?.removed.join(' ') ?? '', false),
      csvField(o && !o.ok ? o.message ?? '' : ''),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** A file name that sorts by date: decluttering-deletes-2026-11-17-1530.csv (local time). */
export function reportFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `decluttering-deletes-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.csv`;
}
