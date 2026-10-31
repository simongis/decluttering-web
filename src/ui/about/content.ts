// About copy stays data-shaped for tests; values are refreshed from the active catalogue on locale changes.
import { onLocaleChange, t } from '../../i18n';
import { PRESETS } from '../../domain/stale';

export type Block = { p: string } | { ul: string[] };
export type FlowId = 'email' | 'data';
export interface AboutSection { id: string; title: string; lead: string; detail: Block[]; flow?: FlowId }
export interface FlowStep { icon: string; label: string; note: string }
export interface Flow { label: string; steps: FlowStep[] }

/** FB-80: the author's LinkedIn profile (user's choice 2026-10-22); it replaced the Esri Australia contact page here. */
export const CONTACT_URL = 'https://www.linkedin.com/in/simongis/';
export let CONTACT_LINK_TEXT = '';
export let REPO_TEXT_LINKED = '';
/** FB-79: the public repository. Every build links to it; VITE_REPO_URL overrides it (a fork or self-host). */
export const REPO_URL = 'https://github.com/simongis/decluttering-web';

/** A gentle disclaimer at the foot of the open-source section (user, 2026-10-23); the README has the full one. */
export let OPEN_DISCLAIMER = { before: '', linkText: '', after: '' };

/** The GitHub line: always a link. VITE_REPO_URL wins when it is a web address, otherwise the public repository. */
export function repoLine(url: string | undefined): { text: string; href: string } {
  const u = (url ?? '').trim();
  return { text: t('about.repo'), href: /^https?:\/\//i.test(u) ? u : REPO_URL };
}

/** Esri's page on the "approved apps" security setting (desk research, ADR 0013). */
export const APPROVED_APPS_URL = 'https://doc.arcgis.com/en/arcgis-online/administer/configure-security.htm';
export let APPROVED_APPS_LINK_TEXT = '';

/** Small diagrams drawn with Calcite icons. Each renders as one role="img" whose aria-label is `label`. */
export let FLOWS: Record<FlowId, Flow> = { email: { label: '', steps: [] }, data: { label: '', steps: [] } };

/** FB-70: the Back link label for the route About was opened from. */
export function backLabel(route: string | undefined): string {
  switch (route) {
    case 'review': case 'emails': return t('about.back.review');
    case 'app': return t('about.back.scan');
    case 'demo': case 'demo-emails': return t('about.back.demo');
    default: return t('about.back.home');
  }
}

/** FB-71: the "not supported" line; links to {repo}/issues. */
export function issuesLine(url: string | undefined): { before: string; link: { text: string; href: string }; after: string } {
  const r = repoLine(url);
  return { before: t('about.issues.before'), link: { text: t('about.issues.link'), href: r.href.replace(/\/+$/, '') + '/issues' }, after: t('about.issues.after') };
}

export let ABOUT_INTRO = '';
export let ABOUT_SECTIONS: AboutSection[] = [];

function refreshAboutCopy(): void {
  CONTACT_LINK_TEXT = t('about.contact');
  REPO_TEXT_LINKED = t('about.repo');
  OPEN_DISCLAIMER = { before: t('about.disclaimer.before'), linkText: t('about.disclaimer.link'), after: t('about.disclaimer.after') };
  APPROVED_APPS_LINK_TEXT = t('about.approvedApps.link');
  FLOWS = {
    email: {
      label: t('about.flow.email.label'),
      steps: [
        { icon: 'user', label: t('about.flow.email.you'), note: t('about.flow.email.youNote') },
        { icon: 'group', label: t('about.flow.email.group'), note: t('about.flow.email.groupNote') },
        { icon: 'envelope', label: t('about.flow.email.oneEmail'), note: t('about.flow.email.oneEmailNote') },
        { icon: 'table', label: t('about.flow.email.log'), note: t('about.flow.email.logNote') },
      ],
    },
    data: {
      label: t('about.flow.data.label'),
      steps: [
        { icon: 'browser', label: t('about.flow.data.browser'), note: t('about.flow.data.browserNote') },
        { icon: 'organization', label: t('about.flow.data.org'), note: t('about.flow.data.orgNote') },
      ],
    },
  };
  ABOUT_INTRO = t('about.intro');
  const p = (key: Parameters<typeof t>[0], params?: Record<string, string | number>): Block => ({ p: t(key, params) });
  const ul = (...keys: Parameters<typeof t>[0][]): Block => ({ ul: keys.map((key) => t(key)) });
  const duration = (days: number) => t(days >= 365 ? 'about.duration.year' : days >= 180 ? 'about.duration.sixMonths' : 'about.duration.threeMonths');
  const durations = {
    gentle: t('about.preset.gentle', { duration: duration(PRESETS.gentle.minDaysSinceUse) }),
    balanced: t('about.preset.balanced', { duration: duration(PRESETS.balanced.minDaysSinceUse) }),
    strict: t('about.preset.strict', { duration: duration(PRESETS.strict.minDaysSinceUse) }),
  };
  ABOUT_SECTIONS = [
    {
      id: 'what', title: t('about.what.title'), lead: t('about.what.lead'),
      detail: [p('about.what.detail.1')],
    },
    {
      id: 'stale', title: t('about.stale.title'), lead: t('about.stale.lead'),
      detail: [
        p('about.stale.detail.1'), p('about.stale.detail.2'),
        p('about.stale.detail.3', durations), p('about.stale.detail.4'),
        ul('about.stale.detail.5a', 'about.stale.detail.5b', 'about.stale.detail.5c'),
        p('about.stale.detail.6'), p('about.stale.detail.7'),
      ],
    },
    {
      id: 'views', title: t('about.views.title'), lead: t('about.views.lead'),
      detail: [p('about.views.detail.1'), p('about.views.detail.2'), p('about.views.detail.3')],
    },
    {
      id: 'data', title: t('about.data.title'), lead: t('about.data.lead'), flow: 'data',
      detail: [
        p('about.data.detail.1'), p('about.data.detail.2'),
        ...(import.meta.env.VITE_CF_BEACON_TOKEN ? [p('about.data.detail.3')] : []),
      ],
    },
    {
      id: 'email', title: t('about.email.title'), lead: t('about.email.lead'), flow: 'email',
      detail: [p('about.email.detail.1'), p('about.email.detail.2'), p('about.email.detail.3')],
    },
    {
      id: 'touches', title: t('about.touches.title'), lead: t('about.touches.lead'),
      detail: [p('about.touches.detail.1')],
    },
    {
      id: 'approved', title: t('about.approved.title'), lead: t('about.approved.lead'),
      detail: [p('about.approved.detail.1'), p('about.approved.detail.2'), p('about.approved.detail.3')],
    },
    {
      id: 'open', title: t('about.open.title'), lead: t('about.open.lead'),
      detail: [p('about.open.detail.1'), p('about.open.detail.2')],
    },
  ];
}

refreshAboutCopy();
onLocaleChange(refreshAboutCopy);
