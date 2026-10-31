import { t } from '../../i18n';

// DC-063: port of prototypes/d-converged/quips.js; a test keeps the two lists identical. Original lines, written for this app.
// Edit the list in getQuipSource; returning [] switches the feature off.
// Item shape: { kind: 'joke' | 'tip', topic?: 'hosted-layers' | 'other' (tips), text, url?, linkText? }. Hosted-layer tips come first in the rotation (FB-20). A url is only used if it passes safeUrl (https, esri.com or arcgis.com).
export type QuipTopic = 'hosted-layers' | 'other';
export interface Quip { kind: 'joke' | 'tip'; topic?: QuipTopic; text: string; url?: string; linkText?: string }
export interface TipState { readonly userPaused: boolean; readonly running: boolean; togglePause(): boolean; setHold(v: boolean): void; stop(): void }

const getQuipSource = (): Quip[] => [
  { kind: "tip", topic: "hosted-layers", text: "Hosted feature layers cost 2.4 credits per 10 MB a month, so a few big, quiet layers add up quickly.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "other", text: "Files and attachments cost 1.2 credits per GB a month: far less per MB than feature storage.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "hosted-layers", text: "Hosted views add no storage of their own, so they are a cheap way to share one layer several ways.", url: "https://doc.arcgis.com/en/arcgis-online/manage-data/create-hosted-views.htm", linkText: "About hosted views" },
  { kind: "tip", topic: "hosted-layers", text: "Organisation > Status shows which hosted layers use the most storage, and you can export it as a CSV.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "other", text: "The new Status dashboard breaks credits down by storage, transactions and sessions, with date ranges.", url: "https://doc.arcgis.com/en/arcgis-online/reference/whats-new.htm", linkText: "What's new" },
  { kind: "tip", topic: "hosted-layers", text: "Removing content nobody needs any more is the most direct way to stop its monthly storage charge.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "hosted-layers", text: "Sync and change tracking can grow a layer over time. Switch them off where nobody needs them.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "hosted-layers", text: "Optimised layers draw faster but use extra storage. Keep that option for layers that need the speed.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "hosted-layers", text: "Publishing from Pro uploads every row, even with a definition query. Export just the subset you need first.", url: "https://doc.arcgis.com/en/arcgis-online/manage-data/publish-features.htm", linkText: "Publishing tips" },
  { kind: "tip", topic: "other", text: "Geocoding costs 40 credits per 1,000 addresses, so geocode once and keep the result.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "other", text: "Credit budgeting can cap analysis and similar credits per member. It does not cover storage.", url: "https://doc.arcgis.com/en/arcgis-online/administer/configure-credits.htm", linkText: "Credit budgeting" },
  { kind: "tip", topic: "other", text: "Notebooks bill by the minute: Advanced is 3 credits an hour, GPU 30. Close them when you finish.", url: "https://doc.arcgis.com/en/arcgis-online/administer/credits.htm", linkText: "How credits work" },
  { kind: "tip", topic: "hosted-layers", text: "Parquet feature layers (beta) bill as file storage, 1.2 credits per GB a month: handy for big read-only data.", url: "https://doc.arcgis.com/en/data-pipelines/latest/process/output-parquet-layer.htm", linkText: "About Parquet layers" },
  { kind: "joke", text: "A hosted layer walks into a bar. Nobody's queried it since 2019." },
  { kind: "joke", text: "Somewhere, a layer called Final_v2_REAL_final is getting nervous." },
  { kind: "joke", text: "Our cartographer quit. Too many projections." },
  { kind: "joke", text: "We'd tell a WGS 84 joke, but it's a bit dated." },
  { kind: "joke", text: "Measuring storage. Unlike a coastline, this one has an end." },
  { kind: "joke", text: "Why is the hosted view so calm? It never needed its own storage plan." },
];

const localizedQuips = (): Quip[] => {
  let tip = 0, joke = 0;
  return getQuipSource().map((q) => {
    const n = q.kind === 'joke' ? ++joke : ++tip;
    return { ...q, text: t(`scan.quip.${q.kind}${n}` as import('../../i18n/en').MessageKey), ...(q.linkText ? { linkText: t(`scan.quip.link${n}` as import('../../i18n/en').MessageKey) } : {}) };
  });
};

export function QUIPS(): Quip[] { return getQuips(); }
export function getQuips(): Quip[] { return localizedQuips(); }
export { getQuipSource };
export function localizedQuip(q: Quip): Quip {
  const i = getQuipSource().findIndex((item) => item.text === q.text);
  return i < 0 ? q : getQuips()[i] as Quip;
}

// DC-063 (docs/research/waiting-ux.md): the first line appears after 10 s so fast scans never show one; every line stays 12 s
// (long enough to read it and decide on the link). QUIP_EVERY_LINK_MS is kept as the same value for callers that still read it.
export const QUIP_SHOW_AFTER_MS = 10000, QUIP_EVERY_MS = 12000, QUIP_EVERY_LINK_MS = 12000, QUIP_FADE_MS = 300;

/**
 * Pause state for the tips line (WCAG 2.2.2). The Pause / Play toggle is the control: it holds until Play is pressed.
 * Hover and focus hold the line only while they last. `running` says whether the timer should be armed.
 */
export function createTipState(): TipState {
  let userPaused = false, hold = false, stopped = false;
  return {
    get userPaused() { return userPaused; },
    get running() { return !userPaused && !hold && !stopped; },
    togglePause() { userPaused = !userPaused; return userPaused; },
    setHold(v: boolean) { hold = !!v; },
    stop() { stopped = true; },
  };
}

/** Returns the URL string when it is https on esri.com or arcgis.com (or a subdomain), else null. */
export function safeUrl(url: unknown): string | null {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    return ['esri.com', 'arcgis.com'].some((d) => h === d || h.endsWith('.' + d)) ? u.href : null;
  } catch { return null; }
}

/**
 * Shuffled deck: every item once, then reshuffle; never the same item twice in a row across reshuffles.
 * With `groups`, each cycle plays the first group (shuffled), then the next, and so on (FB-20: hosted-layer tips first).
 */
function createDeck<T>(groups: T[][], random: () => number): () => T | null {
  const gs = groups.filter((g) => g.length);
  let queue: T[] = [], last: T | null = null;
  const shuffle = (a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  return () => {
    if (!gs.length) return null;
    if (!queue.length) {
      queue = gs.flatMap((g) => shuffle([...g]));
      if (queue.length > 1 && queue[0] === last) queue.push(queue.shift() as T);
    }
    return (last = queue.shift() as T);
  };
}

/**
 * Rotation: tips (hosted-layer tips first, then the rest, each group shuffled) and jokes each come from their own deck (no repeats until the deck is used up). A joke appears
 * after every 3 or 4 tips, never two in a row (unless the list has no tips). `random` is injectable for tests.
 * Returns { next() }; next() gives an item, or null for an empty list.
 */
export function createRotation(list: Quip[] | undefined, random: () => number = Math.random): { next(): Quip | null } {
  const tipList = (list || []).filter((q) => q.kind !== 'joke');
  const tips = createDeck([tipList.filter((q) => q.topic === 'hosted-layers'), tipList.filter((q) => q.topic !== 'hosted-layers')], random);
  const jokes = createDeck([(list || []).filter((q) => q.kind === 'joke')], random);
  let sinceJoke = 1 + Math.floor(random() * 3), gap = 3 + Math.floor(random() * 2); // start part-way, so a joke is not first
  return {
    next() {
      let q: Quip | null = null;
      if (sinceJoke >= gap) { q = jokes(); sinceJoke = 0; gap = 3 + Math.floor(random() * 2); }
      if (!q) { q = tips(); sinceJoke++; }
      return q ?? jokes();
    },
  };
}
