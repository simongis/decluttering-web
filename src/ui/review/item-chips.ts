// Item-type icons and content-status chips in ArcGIS Online's look, shared by the missing-layers table (DC-137) and the
// item panel (DC-147c).
import { html, nothing } from 'lit';
import '@esri/calcite-components/dist/components/calcite-chip';
import { t } from '../../i18n';

/** The Calcite icon ArcGIS Online uses for an item type, as near as Calcite has one. Anything else reads as an app. */
export function itemTypeIcon(type: string): string {
  switch (type) {
    case 'Feature Service':
    case 'Feature Layer': return 'feature-layer';
    case 'Web Map': return 'map';
    case 'Web Scene': return 'globe';
    case 'Dashboard': return 'dashboard';
    case 'StoryMap': return 'storymap-experience';
    case 'Form': return 'survey';
    case 'Map Area': return 'offline';
    case 'Survey123 Add In': return 'add-in';
    case 'Notebook': return 'notebook';
    default: return 'apps';
  }
}

/** Esri's content status as the item page shows it: Deprecated or Authoritative (org or public), else nothing. */
export function statusOf(s: string | undefined): 'deprecated' | 'authoritative' | null {
  if (s === 'deprecated') return 'deprecated';
  if (s === 'org_authoritative' || s === 'public_authoritative') return 'authoritative';
  return null;
}

/** A Calcite chip in ArcGIS Online's look: red with a warning triangle for Deprecated, green with a check for Authoritative. */
export function statusChip(s: string | undefined) {
  const st = statusOf(s);
  if (!st) return nothing;
  const label = t(st === 'deprecated' ? 'review.broken.deprecated' : 'review.broken.authoritative');
  return html`<calcite-chip class="st-chip st-${st}" scale="s" appearance="solid" kind="neutral" icon=${st === 'deprecated' ? 'exclamation-mark-triangle' : 'check-circle'} label=${label}>${label}</calcite-chip>`;
}
