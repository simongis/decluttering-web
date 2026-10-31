import { onLocaleChange, t } from '../i18n';

// Default-deny writes by org (DC-058). A session may build a real notifier only when its org id (portals/self.id)
// is listed in VITE_WRITABLE_ORG_IDS. Everything else is read-only: no groups, no notifications, no items.

/** Splits a comma list of org ids. Blanks are dropped; ids are kept exactly (org ids are case-sensitive). */
export function parseOrgIds(list: string | readonly string[] | null | undefined): string[] {
  const parts = typeof list === 'string' ? list.split(',') : Array.isArray(list) ? list : [];
  return parts.map((s) => String(s).trim()).filter(Boolean);
}

/** True only when `orgId` is non-empty and named in `list`. An empty or missing list allows writes nowhere. */
export function writeAllowed(orgId: string | null | undefined, list: string | readonly string[] | null | undefined): boolean {
  if (typeof orgId !== 'string' || !orgId.trim()) return false;
  return parseOrgIds(list).includes(orgId.trim());
}

/** The copy shown wherever sending would be: calm, and not a fault of the admin. */
export let READ_ONLY_NOTE = t('auth.readOnlyNote');
onLocaleChange(() => { READ_ONLY_NOTE = t('auth.readOnlyNote'); });
