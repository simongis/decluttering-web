// DC-074: a simulated large org. A deterministic (seeded) fake RequestFn that answers the endpoints the scan uses the way
// ArcGIS Online would (paging, error bodies, 429s, latency that grows with load), so the scan experience can be built and
// tested at scale without a real big org. DC-116: also the made-up org the production demo scans (src/demo/demo-org.ts),
// which is why it lives here and not in src/dev/ (that folder re-exports it for the dev simulator).
import type { RequestFn, RequestOptions } from '../scan/types';
import type { Data } from '../domain/types';
import { setFakeRelated } from '../ui/review/related-fake';

const DAY = 864e5;
const MB = 1024 * 1024;

export interface SimulatedOrgConfig {
  /** Hosted feature services (sources plus views). */
  services: number;
  /** Default: about 1 per 17.5 services (400 for 7,000). */
  owners?: number;
  /** DC-103: a one-member org. Every item is owned by the simulated admin and `owners` is ignored. */
  solo?: boolean;
  /** Share of services that are views. */
  viewShare: number;
  /** Maps, dashboards and apps that reference services. Default: 3,000 for 7,000 services, scaled. */
  maps?: number;
  /** Maps that answer HTTP 200 with error.code 500. Default: about 1 per 600 maps, at least 1. */
  unreadableMaps?: number;
  /**
   * DC-035a: this many extra maps that point at hosted layers deleted from the org (each also has a live layer), plus one
   * decoy that points only at another org's layer and a public Esri layer, which must never be reported. Default 0: a seed's
   * services, maps and usage stay put (the extras use their own random stream).
   */
  brokenMaps?: number;
  /**
   * DC-147: apps (dashboards, instant apps, experiences, stories) that show layers through a web map named by id, appended
   * after every other map and app. Default: 1 per 10 maps. Some also name one of the map's layers directly. Own random stream.
   */
  appsViaMaps?: number;
  seed: number;
  orgId: string;
  orgName: string;
  /** Multiplies every latency. 0.2 is five times faster; 0 answers on the next tick. */
  speed: number;
  /** Chance (0 to 1) that a call is answered with HTTP 429 and a retryAfter. */
  rate429: number;
  /** Seconds the 429 asks for. */
  retryAfter: number;
  /** Extra latency per call in flight beyond 4 (0.03 = 3% each). */
  contention: number;
  /** Per-call base latency in ms (before jitter, speed and contention). */
  latency: { search: number; item: number; data: number; related: number; users: number; usageMin: number; usageMax: number };
  /** DC-134: share of source layers with attachments (field capture, inspections). Default 0.15; 0 turns them off. */
  attachmentShare?: number;
  /** Test hook: the clock. Default Date.now. */
  now?: () => number;
  /**
   * DC-116: tidy, human-looking data for the demo. Titles never get a random hex tail (a counter-free place name instead),
   * owner emails have no index, and the first owner can be named. Off by default, so the dev simulator's seeds are unchanged.
   */
  tidy?: { admin: { username: string; fullName: string; email: string }; usernameSuffix: string; emailDomain: string; /** Lognormal size of a source layer (default median 0.6 MB, sigma 2.4). */ size?: { medianMB: number; sigma: number }; /** Cumulative shares of daily, regular, occasional and rare layers (the rest are dead). Default 0.1, 0.31, 0.58, 0.77. */ kinds?: [number, number, number, number] };
}

export const DEFAULT_SIM: SimulatedOrgConfig = {
  services: 7000, viewShare: 0.2, seed: 74, orgId: 'SIM0000000000074', orgName: 'Simulated Regional Council',
  speed: 1, rate429: 0, retryAfter: 2, contention: 0.03,
  latency: { search: 400, item: 120, data: 150, related: 120, users: 300, usageMin: 3000, usageMax: 8000 },
};

export interface SimItem {
  id: string; title: string; owner: string; type: string; typeKeywords: string[]; url?: string;
  created: number; modified: number; access: string; tags: string[]; snippet: string; description: string;
  /** Bytes. */
  size: number;
  /** DC-134: bytes of `size` that are attachments (the item's `subInfo`), billed as file storage. Sources only. */
  subInfo?: number;
  /** DC-083: services only. Epoch ms of the last item open or data access (hourly); null is blank ("not since Nov 2022"). */
  lastViewed?: number | null;
  /** DC-083: services only. Views all time. */
  numViews?: number;
  /** GH-2: Esri's content status badge, e.g. 'deprecated'. Services, and (DC-137) one map with missing layers. */
  contentStatus?: string;
}

export interface SimulatedOrg {
  request: RequestFn;
  /** DC-116: answers every call that is waiting now, and every later one on the next tick ("Skip to results" in the demo). */
  rush(): void;
  config: SimulatedOrgConfig;
  /** The world, for assertions and for the dev page. */
  world: { services: SimItem[]; maps: SimItem[]; /** Files, images and other non-service items that only show up in content listings. */ extras: SimItem[]; /** Owner -> folders, and item id -> folder id (absent: the owner's root). */ folders: Map<string, { id: string; title: string }[]>; folderOf: Map<string, string>; owners: { username: string; fullName: string; email?: string; role: string; disabled: boolean }[]; unreadable: Set<string> };
  /** Calls answered so far, by endpoint kind, and the most in flight at once. */
  stats: { calls: Record<string, number>; maxInFlight: number; rate429: number };
}

type Json = Record<string, unknown>;

/** mulberry32: small, fast and the same everywhere. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Alex', 'Priya', 'Marcus', 'Chen', 'Sofia', 'Luca', 'Hana', 'Tomas', 'Imani', 'Declan', 'Mei', 'Rafael', 'Ingrid', 'Kofi', 'Yara', 'Owen', 'Nadia', 'Felix', 'Aisha', 'Jonas', 'Leila', 'Mateo', 'Freya', 'Dmitri', 'Zainab', 'Callum', 'Elena', 'Idris', 'Maren', 'Pavel'];
const LAST = ['Ivanov', 'Reid', 'Hughes', 'Lindqvist', 'Campbell', 'Moreau', 'Okafor', 'Novak', 'Brandt', 'Tanaka', 'Silva', 'Haddad', 'Larsen', 'Mbeki', 'Kovacs', 'Quinn', 'Rossi', 'Walker', 'Petrov', 'Nguyen', 'Fischer', 'Duarte', 'Aldridge', 'Sandoval', 'Whitcombe', 'Osei', 'Varga', 'Mahlangu', 'Eriksen', 'Bellamy'];
const TOPIC = ['Parcels', 'Road Closures', 'Flood Zones', 'Street Trees', 'Bus Stops', 'Cycle Routes', 'Water Mains', 'Planning Applications', 'Car Parks', 'Playgrounds', 'Heritage Sites', 'Bin Collection', 'Noise Complaints', 'Library Branches', 'Bridges', 'Drainage Assets', 'Survey Points', 'Park Boundaries', 'Wards', 'Schools', 'Fire Hydrants', 'Street Lights', 'Footpaths', 'Zoning', 'Contours', 'Allotments', 'Public Toilets', 'Sports Pitches', 'Graffiti Reports', 'Pothole Reports'];
const SUFFIX = ['', '', '', ' 2019', ' 2021', ' 2023', ' (old)', ' v2', ' draft', ' Copy', ' Public', ' Internal', ' Survey', ' Edit'];
const PLACE = ['Northside', 'Southside', 'Eastgate', 'Westfield', 'Riverside', 'Hillcrest', 'Old Town', 'Harbourview', 'Lakeside', 'Central'];
const MAP_TYPES = ['Web Map', 'Web Map', 'Web Map', 'Dashboard', 'Web Experience', 'Web Mapping Application', 'StoryMap', 'Form', 'Hub Site Application'];

const SERVICE_Q = /Hosted Service/;
const MAP_TYPE_Q = /type:"(Web Map|Dashboard|Web Mapping Application|Web Experience|StoryMap|Form|Hub Site Application)"/;

function abortError(): Error {
  const e = new Error('The request was aborted.');
  e.name = 'AbortError';
  return e;
}

export function createSimulatedOrg(partial: Partial<SimulatedOrgConfig> = {}): SimulatedOrg {
  const config: SimulatedOrgConfig = { ...DEFAULT_SIM, ...partial, latency: { ...DEFAULT_SIM.latency, ...partial.latency } };
  const clock = config.now ?? Date.now;
  const anchor = Math.floor(clock() / DAY) * DAY;
  const rand = seeded(config.seed);
  const calls = seeded(config.seed + 7919); // its own stream: latency and 429 draws never shift the data
  const att = seeded(config.seed + 104729); // DC-134: attachments get their own stream too, so the rest of the org is unchanged
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)] as T;
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const norm = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const lognorm = (median: number, sigma: number) => median * Math.exp(sigma * norm());

  // Owners: heavily skewed, a few disabled, one signed-in admin first.
  const ownerCount = config.solo ? 1 : Math.max(3, config.owners ?? Math.round(config.services / 17.5));
  const owners: SimulatedOrg['world']['owners'] = [];
  const names = new Set<string>();
  for (let i = 0; i < ownerCount; i++) {
    let fn: string, ln: string, key: string, n = 0;
    if (i === 0 && config.tidy) names.add(config.tidy.admin.fullName.replace(/\s+/g, '').toLowerCase()); // nobody else is called the admin's name
    do { fn = pick(FIRST); ln = pick(LAST); key = `${fn}${ln}`.toLowerCase() + (n++ > 30 ? String(i) : ''); } while (names.has(key));
    names.add(key);
    const t = config.tidy;
    owners.push({
      username: i === 0 ? (t ? t.admin.username : 'sim_admin') : `${key}${t ? t.usernameSuffix : '_sim'}`, fullName: i === 0 ? (t ? t.admin.fullName : 'Sim Admin') : `${fn} ${ln}`,
      email: i === 0 && t ? t.admin.email : t ? `${fn}.${ln}`.toLowerCase() + `@${t.emailDomain}` : `${fn}.${ln}`.toLowerCase() + `${i}@sim.example.org`,
      role: i === 0 ? 'org_admin' : i % 3 === 0 ? 'org_user' : 'org_publisher',
      disabled: i > 0 && i % 31 === 0,
    });
  }
  const weights = owners.map((_, i) => 1 / Math.pow(i + 1, 1.05));
  const cum: number[] = [];
  weights.reduce((a, w, i) => (cum[i] = a + w), 0);
  const pickOwner = () => {
    const r = rand() * (cum[cum.length - 1] as number);
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((cum[mid] as number) < r) lo = mid + 1; else hi = mid; }
    return owners[lo]!.username;
  };

  // Services: sources first, then views hanging off random sources, then shuffled.
  const total = Math.max(0, Math.round(config.services));
  const viewCount = Math.round(total * config.viewShare);
  const sourceCount = total - viewCount;
  const services: SimItem[] = [];
  const usage = new Map<string, [number, number][]>(); // service id -> [daysAgo, count]
  const kindOf = new Map<string, string>(); // service id -> how busy it is (for lastViewed and numViews, DC-083)
  const serviceName = new Map<string, string>(); // id -> lowercase url name
  const sourceOf = new Map<string, string>(); // view id -> source id
  const usedTitles = new Set<string>();
  const sweeps = new Set<number>();
  while (sweeps.size < 8) sweeps.add(2 + Math.floor(rand() * 360));

  const make = (source: SimItem | null): SimItem => {
    const isView = !!source;
    const r = rand();
    const cut = config.tidy?.kinds ?? [0.1, 0.31, 0.58, 0.77]; // cumulative shares of daily, regular, occasional, rare; the rest are dead
    const kind = r < cut[0]! ? 'daily' : r < cut[1]! ? 'regular' : r < cut[2]! ? 'occasional' : r < cut[3]! ? 'rare' : 'dead';
    const modDays = Math.max(2, Math.min(2300, Math.round(lognorm(kind === 'daily' || kind === 'regular' ? 450 : 950, 0.9))));
    const createdDays = modDays + Math.round(lognorm(150, 1));
    let title: string;
    if (source) {
      title = `${source.title} - ${pick(['Public', 'Editors', 'Field view', 'Read only', 'Partner'])}`;
      if (config.tidy && usedTitles.has(title)) title = `${source.title} - ${pick(['Contractors', 'Reporting', 'Mobile', 'Archive'])}`;
      if (config.tidy) usedTitles.add(title);
    } else {
      title = pick(TOPIC) + pick(SUFFIX);
      if (usedTitles.has(title) && config.tidy) {
        // Place names, not hex: "Street Trees 2021 - Northside". When those run out, a number.
        for (let k = 0; usedTitles.has(title) && k < PLACE.length * 3; k++) title = `${title.replace(/ - .*$/, '')} - ${PLACE[k % PLACE.length]}${k >= PLACE.length ? ` ${1 + Math.floor(k / PLACE.length)}` : ''}`;
      } else if (usedTitles.has(title)) title = `${title} ${hex(4)}`;
      usedTitles.add(title);
    }
    const id = hex(32);
    const name = `${title.replace(/[^A-Za-z0-9]+/g, '_')}_${id.slice(0, 6)}`;
    const idle = kind === 'dead' || kind === 'rare';
    const topic = pick(TOPIC).toLowerCase();
    // Sizes: lognormal with a median of 0.6 MB and a long tail to a few GB. Views hold no storage of their own.
    const sizeBytes = isView ? 0 : Math.round(Math.min(6000, lognorm(config.tidy?.size?.medianMB ?? 0.6, config.tidy?.size?.sigma ?? 2.4)) * MB);
    const s: SimItem = {
      id, title, owner: source ? source.owner : pickOwner(), type: 'Feature Service',
      typeKeywords: isView ? ['ArcGIS Server', 'Data', 'Feature Access', 'Feature Service', 'Service', 'Hosted Service', 'View Service'] : ['ArcGIS Server', 'Data', 'Feature Access', 'Feature Service', 'Service', 'Hosted Service'],
      url: `https://services.arcgis.com/${config.orgId}/arcgis/rest/services/${name}/FeatureServer`,
      created: anchor - createdDays * DAY, modified: anchor - modDays * DAY,
      access: pick(['private', 'private', 'private', 'org', 'org', 'public']),
      tags: rand() < (idle ? 0.35 : 0.08) ? [] : [topic, pick(['council', 'operations', 'survey', 'planning'])],
      snippet: rand() < (idle ? 0.4 : 0.12) ? '' : `${topic} for internal use`,
      description: rand() < (idle ? 0.5 : 0.15) ? '' : `Maintained by the GIS team. Holds ${topic} data.`,
      size: sizeBytes,
    };
    // DC-134: some layers are mostly photos: 40% to 99% of their storage is attachments.
    if (!isView && att() < (config.attachmentShare ?? 0.15)) s.subInfo = Math.round(sizeBytes * (0.4 + 0.59 * att()));
    if (source) sourceOf.set(id, source.id);
    if (source && s.created < source.created) s.created = source.created;
    if (source && s.modified < source.created) s.modified = source.created;
    // Usage: sparse [daysAgo, requests].
    const max = Math.min(365, createdDays);
    const want = { daily: 250 + Math.floor(rand() * 100), regular: 30 + Math.floor(rand() * 110), occasional: 3 + Math.floor(rand() * 20), rare: 1 + Math.floor(rand() * 2), dead: 0 }[kind];
    const days = new Set<number>();
    for (let guard = 0; days.size < Math.min(want, max) && guard < 3000; guard++) {
      days.add(kind === 'daily' || kind === 'regular' ? 1 + Math.floor(Math.pow(rand(), 1.4) * (max - 1)) : 1 + Math.floor(rand() * max));
    }
    for (const d of sweeps) if (rand() < 0.4 && d <= max) days.add(d);
    usage.set(id, [...days].sort((a, b) => a - b).map((d): [number, number] => [d, sweeps.has(d) ? 1 + Math.floor(rand() * 4) : 1 + Math.floor(Math.pow(rand(), 2.5) * 400)]));
    serviceName.set(id, name.toLowerCase());
    kindOf.set(id, kind);
    return s;
  };
  for (let i = 0; i < sourceCount; i++) services.push(make(null));
  for (let i = 0; i < viewCount; i++) services.push(make(services[Math.floor(Math.pow(rand(), 1.5) * sourceCount)] ?? null));
  for (let i = services.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [services[i], services[j]] = [services[j] as SimItem, services[i] as SimItem]; }

  // Maps and apps: each references 0 to 5 services, popular ones more often; some by item id, some by service url.
  const mapCount = Math.max(0, Math.round(config.maps ?? config.services * 3000 / 7000));
  const maps: SimItem[] = [];
  const refs = new Map<string, string[]>(); // map id -> data text
  for (let i = 0; i < mapCount; i++) {
    const type = pick(MAP_TYPES);
    const modDays = Math.max(1, Math.min(2300, Math.round(lognorm(500, 1))));
    const id = hex(32);
    const n = rand() < 0.25 ? 0 : 1 + Math.floor(rand() * rand() * 5);
    const layers: Json[] = [];
    for (let k = 0; k < n && services.length; k++) {
      const s = services[Math.floor(Math.pow(rand(), 2) * services.length)] as SimItem;
      layers.push(rand() < 0.5 ? { itemId: s.id, title: s.title, url: `${s.url}/0` } : { title: s.title, url: `${s.url}/${k}` });
    }
    refs.set(id, [JSON.stringify({ operationalLayers: layers, baseMap: { title: 'Topographic' }, version: '2.28' })]);
    maps.push({
      id, title: `${pick(TOPIC)} ${pick(['Map', 'Dashboard', 'Viewer', 'Story', 'Explorer'])} ${i}`, owner: pickOwner(), type, typeKeywords: [], created: anchor - (modDays + 100) * DAY,
      modified: anchor - modDays * DAY, access: pick(['private', 'org', 'public']), tags: [], snippet: '', description: '', size: 0,
    });
  }
  // DC-035a: maps with references to deleted layers, and a decoy. Its own random stream and no shared state with the above.
  const brokenCount = Math.max(0, config.brokenMaps ?? 0);
  if (brokenCount && services.length && owners.length > 1) {
    const br = seeded(config.seed + 6007);
    const bhex = (n: number) => Array.from({ length: n }, () => Math.floor(br() * 16).toString(16)).join('');
    const GONE = [['Flood Watch Viewer', 'Web Map', 'Old Flood Zones 2019'], ['Road Works Dashboard', 'Dashboard', 'Road Closures Archive'], ['Community Facilities Explorer', 'Web Mapping Application', 'Library Branches Old'], ['Ward Boundaries Story', 'StoryMap', 'Wards 2016 Draft']] as const;
    const live = (k: number) => services[(k * 37) % services.length] as SimItem;
    for (let k = 0; k < brokenCount + 1; k++) {
      const decoy = k === brokenCount;
      const [title, type, gone] = decoy ? ['Regional Overview Map', 'Web Map', ''] : GONE[k % GONE.length] as readonly [string, string, string];
      const lv = live(k + 1);
      const layers: Json[] = decoy
        ? [{ itemId: bhex(32), title: 'Neighbouring council roads', url: `https://services.arcgis.com/${bhex(16)}/arcgis/rest/services/Roads/FeatureServer/0` },
           { itemId: bhex(32), title: 'World Hillshade', url: 'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer' },
           { itemId: lv.id, title: lv.title, url: `${lv.url}/0` }]
        : [{ itemId: lv.id, title: lv.title, url: `${lv.url}/0` },
           // DC-137: 1, 3, 2, ... layers gone, so the table's default sort (most missing first) has something to do.
           ...Array.from({ length: [1, 3, 2][k % 3] as number }, (_, j) => ({ itemId: bhex(32), title: `${gone}${j ? ` ${j + 1}` : ''}`, url: `https://services.arcgis.com/${config.orgId}/arcgis/rest/services/${gone.replace(/\s+/g, '_')}${j ? `_${j + 1}` : ''}/FeatureServer/0` }))];
      const id = bhex(32);
      const modDays = 30 + k * 41;
      refs.set(id, [JSON.stringify({ operationalLayers: layers, baseMap: { title: 'Topographic' }, version: '2.28' })]);
      maps.push({
        id, title: decoy ? title : `${title}${k >= GONE.length ? ` ${k + 1}` : ''}`, owner: (owners[1 + (k * 3) % (owners.length - 1)] as { username: string }).username, type, typeKeywords: [], created: anchor - (modDays + 200) * DAY,
        modified: anchor - modDays * DAY, access: 'org', tags: [], snippet: '', description: '', size: 0,
        ...(k === 1 ? { contentStatus: 'deprecated' } : k === 2 ? { contentStatus: 'org_authoritative' } : {}),
      });
    }
  }
  // DC-083: lastViewed and numViews, from their own random stream so the services, maps and usage a seed produced stay put.
  // lastViewed is never older than the last data request (Esri: accessing the layer moves it). Busy layers were opened
  // in the last few days; some idle ones are blank ("not since Nov 2022"), others were opened long ago or recently by
  // an admin checking them.
  const vr = seeded(config.seed + 31337);
  const HOUR = 3600_000;
  const blankBefore = Math.floor((anchor - Date.UTC(2022, 10, 1)) / DAY); // days back to November 2022
  const VIEWS: Record<string, number> = { daily: 20000, regular: 2500, occasional: 300, rare: 60, dead: 20 };
  for (const s of services) {
    const kind = kindOf.get(s.id) ?? 'dead';
    if (kind === 'dead' && vr() < 0.5) usage.set(s.id, []); // half the dead layers were missed by every sweep: no requests at all
    const days = (usage.get(s.id) ?? []).map(([d]) => d);
    const lastReq = days.length ? Math.min(...days) : null;
    const r = vr();
    let ago: number | null;
    if (kind === 'daily' || kind === 'regular') ago = Math.min(lastReq ?? 2, Math.floor(vr() * 3));
    else if (lastReq !== null) ago = r < 0.3 ? Math.floor(vr() * lastReq) : lastReq; // sometimes opened since
    else if (r < 0.45) ago = null;                                                     // blank
    else if (r < 0.55) ago = 20 + Math.floor(vr() * 180);                               // an admin had a look
    else ago = Math.min(blankBefore - 1, 366 + Math.floor(vr() * (blankBefore - 366)));
    const createdAgo = Math.floor((anchor - s.created) / DAY);
    if (ago !== null && ago > createdAgo) ago = Math.max(0, Math.min(createdAgo, lastReq ?? createdAgo));
    s.lastViewed = ago === null ? null : Math.min(clock(), anchor - ago * DAY + Math.floor(vr() * 24) * HOUR);
    s.numViews = Math.max(0, Math.round((VIEWS[kind] ?? 20) * Math.exp(1.3 * (vr() + vr() + vr() - 1.5)) * (s.typeKeywords.includes('View Service') ? 0.3 : 1)));
  }
  // GH-2: a few idle layers the org has already marked deprecated, and a few authoritative ones (reference data that is
  // rarely touched). Own stream, so nothing else a seed made moves.
  const cr = seeded(config.seed + 4242);
  for (const s of services) {
    const kind = kindOf.get(s.id) ?? 'dead';
    if ((kind !== 'dead' && kind !== 'rare') || s.typeKeywords.includes('View Service')) continue;
    const r = cr();
    if (r < 0.15) s.contentStatus = 'deprecated';
    else if (r < 0.2) s.contentStatus = 'org_authoritative';
  }

  // DC-086: a recent sweep, the way a script or crawler does it: on day 4 at 03:00 UTC it asked most layers that had been
  // opened before for their data, a request or two each, which also moved their lastViewed to that hour (live check L1).
  // Its own random stream, so the services, usage and views a seed produced before stay put.
  const sw = seeded(config.seed + 4241);
  const SWEEP_AGO = 4, sweepAt = anchor - SWEEP_AGO * DAY + 3 * HOUR;
  for (const s of services) {
    if (s.lastViewed === null || s.lastViewed === undefined || s.created > sweepAt || sw() >= 0.7) continue;
    const u = usage.get(s.id) ?? [];
    const hit = u.find(([d]) => d === SWEEP_AGO);
    const add = 1 + Math.floor(sw() * 2);
    if (hit) hit[1] += add; else u.push([SWEEP_AGO, add]);
    usage.set(s.id, u.sort((a, b) => a[0] - b[0]));
    if (sweepAt <= clock()) s.lastViewed = Math.max(s.lastViewed, sweepAt);
  }

  // DC-147: the second year of usage (days 365 to 729), its own random stream, so the first year and everything else a seed
  // made stay put. Never newer than lastViewed (a request moves it), never before the layer existed, none for a blank
  // lastViewed (no use since Nov 2022). Busy layers were busy then too; some idle layers were last used in the second year.
  // Two second-year sweep days touch most layers that were opened by then.
  const y2 = seeded(config.seed + 147);
  const Y1 = 365, Y2 = 730;
  const sweeps2 = [400 + Math.floor(y2() * 100), 600 + Math.floor(y2() * 100)];
  for (const s of services) {
    if (typeof s.lastViewed !== 'number') continue;
    const kind = kindOf.get(s.id) ?? 'dead';
    const lvAgo = Math.max(0, Math.floor((anchor - s.lastViewed) / DAY));
    const lo = Math.max(Y1, lvAgo), hi = Math.min(Y2 - 1, Math.floor((anchor - s.created) / DAY));
    if (lo > hi) continue;
    const r = y2();
    const want = kind === 'daily' ? 150 + Math.floor(r * 150) : kind === 'regular' ? 20 + Math.floor(r * 100)
      : kind === 'occasional' ? 3 + Math.floor(r * 17) : kind === 'rare' ? 1 + Math.floor(r * 3)
      : lvAgo >= Y1 && r < 0.6 ? 5 + Math.floor(y2() * 55) : 0; // went quiet: used in the second year, not since
    const days = new Map<number, number>();
    for (let guard = 0; days.size < Math.min(want, hi - lo + 1) && guard < 3000; guard++) days.set(lo + Math.floor(y2() * (hi - lo + 1)), 1 + Math.floor(Math.pow(y2(), 2.5) * 400));
    for (const d of sweeps2) if (d >= lo && d <= hi && !days.has(d) && y2() < 0.8) days.set(d, 1 + Math.floor(y2() * 3));
    if (!days.size) continue;
    usage.set(s.id, [...(usage.get(s.id) ?? []), ...days].sort((a, b) => a[0] - b[0]));
  }

  const unreadable = new Set<string>();
  const unreadableCount = Math.min(maps.length, config.unreadableMaps ?? Math.max(1, Math.round(maps.length / 600)));
  for (let i = 0; i < unreadableCount; i++) unreadable.add(maps[Math.floor((i + 0.5) * maps.length / unreadableCount)]!.id);

  // Folders and non-service content, for the content/users listings (DC-071a). Its own random stream, so adding it never shifts
  // the services, maps or usage a seed already produced.
  const fr = seeded(config.seed + 104729);
  const fhex = (n: number) => Array.from({ length: n }, () => Math.floor(fr() * 16).toString(16)).join('');
  const FOLDER = ['Archive', 'Field Data', 'Projects', 'Imagery', 'Reports', 'Open Data', 'Planning', 'Assets', 'Surveys', 'Drafts', 'Training', 'Dashboards', 'Old', 'Shared', 'Engineering', 'Environment'];
  const folders = new Map<string, { id: string; title: string }[]>();
  const folderOf = new Map<string, string>();
  const ownService = new Map<string, number>();
  for (const s of services) ownService.set(s.owner, (ownService.get(s.owner) ?? 0) + 1);
  for (const o of owners) {
    const r = fr();
    // Most owners have 0 to 3 folders; about 1 in 10 keep many (more if they own more).
    const n = r < 0.3 ? 0 : r < 0.9 ? 1 + Math.floor(fr() * 3) : 6 + Math.floor(fr() * Math.min(20, 6 + (ownService.get(o.username) ?? 0) / 4));
    folders.set(o.username, Array.from({ length: n }, (_, i) => ({ id: fhex(32), title: `${FOLDER[Math.floor(fr() * FOLDER.length)]}${i ? ` ${i + 1}` : ''}` })));
  }
  const place = (it: SimItem) => {
    const fs = folders.get(it.owner) ?? [];
    if (fs.length && fr() > 0.3) folderOf.set(it.id, fs[Math.floor(Math.pow(fr(), 1.6) * fs.length)]!.id);
  };
  const EXTRA = ['PDF', 'CSV', 'Image', 'Microsoft Excel', 'File Geodatabase', 'Code Attachment', 'Vector Tile Service'];
  const extras: SimItem[] = [];
  for (const o of owners) {
    const n = Math.floor((ownService.get(o.username) ?? 0) * 0.4 * fr() * 2) + (fr() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const modDays = Math.max(1, Math.min(2300, Math.round(500 * Math.exp(fr() * 2))));
      const type = EXTRA[Math.floor(fr() * EXTRA.length)] as string;
      extras.push({
        id: fhex(32), title: `${TOPIC[Math.floor(fr() * TOPIC.length)]} ${type === 'Image' ? 'photo' : 'export'} ${i + 1}`, owner: o.username, type, typeKeywords: [type], created: anchor - (modDays + 60) * DAY,
        modified: anchor - modDays * DAY, access: 'private', tags: [], snippet: '', description: '', size: Math.round(Math.min(900, 0.2 * Math.exp(2 * (fr() + fr() + fr() - 1.5))) * MB),
      });
    }
  }
  for (const it of [...services, ...maps, ...extras]) place(it);

  // DC-147: apps that show layers through a web map named by id (the item panel's "Through a map"), appended last with their
  // own random stream, so every map, folder and unreadable pick a seed made stays put. They live in their owner's root folder.
  const ar = seeded(config.seed + 1470);
  const ahex = (n: number) => Array.from({ length: n }, () => Math.floor(ar() * 16).toString(16)).join('');
  const webMaps = maps.filter((m) => m.type === 'Web Map' && !unreadable.has(m.id));
  const layerIds = (mapId: string): string[] => {
    try { return ((JSON.parse((refs.get(mapId) ?? ['{}'])[0] as string) as { operationalLayers?: { itemId?: string }[] }).operationalLayers ?? []).map((l) => l.itemId).filter((x): x is string => !!x); }
    catch { return []; }
  };
  const appsOf = new Map<string, SimItem[]>();
  const viaCount = webMaps.length ? Math.max(0, Math.round(config.appsViaMaps ?? mapCount / 10)) : 0;
  const APP_KINDS: [string, string][] = [['Dashboard', 'Dashboard'], ['Web Mapping Application', 'Viewer'], ['Web Experience', 'Explorer'], ['StoryMap', 'Story'], ['Dashboard', 'Board']];
  for (let i = 0; i < viaCount; i++) {
    const [type, word] = APP_KINDS[Math.floor(ar() * APP_KINDS.length)] as [string, string];
    const through = [webMaps[Math.floor(Math.pow(ar(), 1.5) * webMaps.length)] as SimItem];
    if (ar() < 0.25) { const m2 = webMaps[Math.floor(ar() * webMaps.length)] as SimItem; if (m2 !== through[0]) through.push(m2); }
    const own = layerIds((through[0] as SimItem).id);
    const direct = own.length && ar() < 0.3 ? own[Math.floor(ar() * own.length)] : undefined; // also names a layer directly
    const ids = through.map((m) => m.id);
    const body = type === 'Dashboard' ? { widgets: [...ids.map((itemId) => ({ type: 'mapWidget', itemId })), ...(direct ? [{ type: 'listWidget', datasets: [{ dataSource: { itemId: direct } }] }] : [])] }
      : type === 'Web Mapping Application' ? { values: { webmap: ids[0], ...(direct ? { layers: [direct] } : {}) } }
      : type === 'Web Experience' ? { dataSources: Object.fromEntries([...ids.map((itemId, k) => [`map${k}`, { itemId, type: 'WEB_MAP' }]), ...(direct ? [['layer', { itemId: direct, type: 'FEATURE_LAYER' }]] : [])]) }
      : { resources: Object.fromEntries([...ids.map((itemId, k) => [`r-map${k}`, { type: 'webmap', data: { itemId } }]), ...(direct ? [['r-layer', { type: 'layer', data: { itemId: direct } }]] : [])]) };
    const id = ahex(32);
    refs.set(id, [JSON.stringify(body)]);
    const r = ar() * (cum[cum.length - 1] as number);
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((cum[mid] as number) < r) lo = mid + 1; else hi = mid; }
    const modDays = Math.max(1, Math.min(2300, Math.round(300 * Math.exp(ar() * 2))));
    const base = (through[0] as SimItem).title.replace(/ (Map|Dashboard|Viewer|Story|Explorer) \d+$/, '');
    const app: SimItem = {
      id, title: `${base} ${word}${config.tidy ? '' : ` ${i}`}`, owner: (owners[lo] as { username: string }).username, type, typeKeywords: [],
      created: anchor - (modDays + 60) * DAY, modified: anchor - modDays * DAY, access: 'org', tags: [], snippet: '', description: '', size: 0,
    };
    maps.push(app);
    for (const m of through) appsOf.set(m.id, [...(appsOf.get(m.id) ?? []), app]); // DC-147d: relatedItems forward lists it (Map2App)
  }

  const byId = new Map<string, SimItem>([...services, ...maps, ...extras].map((s) => [s.id, s]));
  // Each owner's content, by folder ('' is the root), in a stable order.
  const content = new Map<string, Map<string, SimItem[]>>();
  for (const it of [...services, ...maps, ...extras]) {
    const m = content.get(it.owner) ?? new Map<string, SimItem[]>();
    content.set(it.owner, m);
    const k = folderOf.get(it.id) ?? '';
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  const mapsByModified = [...maps].sort((a, b) => b.modified - a.modified);
  const stats: SimulatedOrg['stats'] = { calls: {}, maxInFlight: 0, rate429: 0 };
  let inFlight = 0;

  const searchRow = (s: SimItem): Json => ({
    id: s.id, title: s.title, owner: s.owner, type: s.type, typeKeywords: s.typeKeywords, url: s.url, created: s.created, modified: s.modified,
    access: s.access, tags: s.tags, snippet: s.snippet, description: s.description, orgId: config.orgId,
    ownerFolder: folderOf.get(s.id) ?? null,
    ...(s.numViews !== undefined ? { numViews: s.numViews } : {}),
    ...(s.lastViewed !== undefined ? { lastViewed: s.lastViewed } : {}),
    ...(s.contentStatus ? { contentStatus: s.contentStatus } : {}),
  });
  const page = <T>(rows: T[], params: Record<string, string | number>, key: string, map: (x: T) => unknown): Json => {
    const num = Math.max(1, Math.min(100, Number(params.num) || 10));
    const start = Math.max(1, Number(params.start) || 1);
    const slice = rows.slice(start - 1, start - 1 + num);
    const next = start - 1 + num < rows.length ? start + num : -1;
    return { total: rows.length, start, num: slice.length, nextStart: next, [key]: slice.map(map) };
  };

  /** How long this call takes, before speed, jitter and contention. */
  function baseLatency(path: string): { kind: string; ms: number } {
    const L = config.latency;
    if (path === 'search') return { kind: 'search', ms: L.search };
    if (/\/data$/.test(path)) return { kind: 'data', ms: L.data };
    if (/\/relatedItems$/.test(path)) return { kind: 'related', ms: L.related };
    if (/^content\/items\//.test(path)) return { kind: 'item', ms: L.item };
    if (/^content\/users\//.test(path)) return { kind: 'listing', ms: L.item };
    if (/\/usage$/.test(path)) {
      // Big payloads take seconds: scale with how many services there are, up to the configured range.
      const share = Math.min(1, services.length / 5000);
      return { kind: 'usage', ms: L.usageMin * Math.max(0.05, share) + (L.usageMax - L.usageMin) * share * calls() };
    }
    if (/\/users$/.test(path)) return { kind: 'users', ms: L.users };
    return { kind: 'other', ms: 100 };
  }

  function answer(path: string, params: Record<string, string | number>, options: RequestOptions): unknown {
    if (path === 'search') {
      const q = String(params.q ?? '');
      let rows: SimItem[];
      if (SERVICE_Q.test(q)) rows = services;
      else if (MAP_TYPE_Q.test(q)) rows = params.sortField === 'modified' ? (params.sortOrder === 'asc' ? [...mapsByModified].reverse() : mapsByModified) : maps;
      else rows = [];
      const only = /\bowner:(\S+)/.exec(q)?.[1];
      if (only) rows = rows.filter((r) => r.owner === only);
      return page(rows, params, 'results', searchRow);
    }
    if (/^portals\/[^/]+\/users$/.test(path)) return page(owners, params, 'users', (u) => ({ ...u, thumbnail: null }));
    if (/^portals\/[^/]+\/usage$/.test(path)) {
      const a = Number(params.startTime), b = Number(params.endTime);
      const data: Json[] = [];
      for (const s of services) {
        const num: [number, string][] = [];
        for (const [ago, count] of usage.get(s.id) ?? []) {
          const ms = anchor - ago * DAY;
          if (ms >= a && ms <= b) num.push([ms, String(count)]);
        }
        if (num.length) data.push({ name: serviceName.get(s.id), num });
      }
      return { data, startTime: a, endTime: b, period: '1d' };
    }
    const listing = /^content\/users\/([^/]+)(?:\/([0-9a-f]{32}))?$/.exec(path);
    if (listing) {
      const owner = decodeURIComponent(listing[1] as string), folder = listing[2] ?? '';
      const mine = folders.get(owner);
      if (!mine) return { error: { code: 400, message: 'User does not exist or is inaccessible.', details: [] } };
      if (folder && !mine.some((f) => f.id === folder)) return { error: { code: 400, message: 'Folder does not exist or is inaccessible.', details: [] } };
      const rows = content.get(owner)?.get(folder) ?? [];
      const res = page(rows, params, 'items', (x) => ({ ...searchRow(x), size: x.size, subInfo: x.subInfo ?? 0, numViews: x.numViews ?? 0 })) as Json;
      return { username: owner, ...res, ...(folder ? { currentFolder: mine.find((f) => f.id === folder) } : { folders: mine.map((f) => ({ ...f, username: owner, created: anchor })) }) };
    }
    const item = /^content\/items\/([0-9a-f]{32})(\/(data|relatedItems))?$/.exec(path);
    if (item) {
      const it = byId.get(item[1] as string);
      if (!it) return { error: { code: 400, message: 'Item does not exist or is inaccessible.', details: [] } };
      if (item[3] === 'data') {
        if (unreadable.has(it.id)) {
          // The real dev org answers HTTP 200 with a body-level 500 for a few maps; as text it surfaces as a thrown error.
          const body = { error: { code: 500, message: 'Unable to complete operation.', details: [] } };
          if (options.text) throw Object.assign(new Error('500: Unable to complete operation.'), { code: 500, response: body });
          return body;
        }
        const text = (refs.get(it.id) ?? ['{}'])[0] as string;
        return options.text ? text : JSON.parse(text);
      }
      if (item[3] === 'relatedItems') {
        // DC-147d: forward from a web map: the apps that name it, plus Map Areas and Survey123 forms (the item panel's extras).
        if (params.direction === 'forward' && (it.type === 'Web Map' || it.type === 'Web Scene')) return simulatedRelatedForward(it, appsOf.get(it.id) ?? [], anchor);
        const src = sourceOf.get(it.id);
        return { total: src ? 1 : 0, relatedItems: src ? [{ id: src }] : [] };
      }
      return { ...searchRow(it), size: it.size, subInfo: it.subInfo ?? 0, numViews: it.numViews ?? 0 };
    }
    return { error: { code: 404, message: `Unknown endpoint ${path}`, details: [] } };
  }

  const pending = new Set<() => void>();
  const request: RequestFn = (path, params = {}, options = {}) => new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) { reject(abortError()); return; }
    const { kind, ms } = baseLatency(path);
    stats.calls[kind] = (stats.calls[kind] ?? 0) + 1;
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    // 0.7x to 1.3x jitter, a slow tail now and then, and a slowdown that grows with how many calls are in flight.
    const jitter = (0.7 + calls() * 0.6) * (calls() < 0.02 ? 4 : 1);
    const wait = ms * jitter * (1 + config.contention * Math.max(0, inFlight - 4)) * config.speed;
    const limited = config.rate429 > 0 && calls() < config.rate429;

    const onAbort = () => { clearTimeout(timer); pending.delete(done); inFlight--; reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      pending.delete(done);
      signal?.removeEventListener('abort', onAbort);
      inFlight--;
      if (limited) {
        stats.rate429++;
        reject(Object.assign(new Error('Too many requests'), { status: 429, code: 'HTTP 429', retryAfter: config.retryAfter * config.speed }));
        return;
      }
      try { resolve(answer(path, params, options)); } catch (e) { reject(e); }
    };
    pending.add(done);
    const timer = setTimeout(done, Math.max(0, wait));
  });

  const rush = () => { config.speed = 0; for (const fire of [...pending]) fire(); };
  setFakeRelated(config.orgId, request); // DC-147d: the item panel asks this org too

  return { request, rush, config, world: { services, maps, extras, folders, folderOf, owners, unreadable }, stats };
}

/** DC-147d: a map as relatedItems needs it. */
export interface RelatedMap { id: string; title: string; owner: string; type?: string }

const AREA_NAMES = ['North depot', 'Town centre', 'Flood zone', 'East ward', 'Rural roads', 'Harbour', 'West ward', 'Industrial estate'];
const FORM_WORDS = ['inspection', 'survey', 'condition check', 'site visit'];

/** FNV-1a over the id: the extras' random stream is the map's own, so they never move another map's (or the scan's) numbers. */
function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * DC-147d: what `relatedItems?direction=forward` answers for a web map: the apps that use it (Map2App), then offline Map Areas
 * (Map2Area) and Survey123 forms (Data2Survey), from the map id's own random stream. About 1 map in 14 answers 403 (another
 * owner's map seen by a non-admin), so "not available" can be seen in the demo too.
 */
export function simulatedRelatedForward(map: RelatedMap, apps: Pick<SimItem, 'id' | 'title' | 'owner' | 'type' | 'modified'>[] = [], anchor = Date.now()): Json {
  const r = seeded(hashId(map.id) ^ 0x147d);
  if (r() < 0.07) return { error: { code: 403, messageCode: 'GWM_0003', message: 'You do not have permissions to access this resource or perform this operation.', details: [] } };
  const hex = () => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  const base = map.title.replace(/ (Map|Scene|Viewer|Dashboard|Board|Story|Explorer)( \d+)?$/, '');
  const rows: Json[] = apps.map((a) => ({ id: a.id, title: a.title, owner: a.owner, type: a.type, modified: a.modified }));
  const areas = r() < 0.45 ? 1 + Math.floor(r() * r() * 4) : 0;
  const start = Math.floor(r() * AREA_NAMES.length);
  for (let k = 0; k < areas; k++) {
    rows.push({ id: hex(), title: `${base}: ${AREA_NAMES[(start + k) % AREA_NAMES.length]}`, owner: map.owner, type: 'Map Area', typeKeywords: ['Map', 'Map Area', 'Offline'], modified: anchor - Math.round(30 + r() * 900) * DAY });
  }
  if (r() < 0.3) {
    const word = FORM_WORDS[Math.floor(r() * FORM_WORDS.length)] as string;
    rows.push({ id: hex(), title: `${base} ${word}`, owner: map.owner, type: 'Form', typeKeywords: ['Form', 'Survey123'], modified: anchor - Math.round(30 + r() * 900) * DAY });
  }
  return { total: rows.length, start: 1, num: rows.length, nextStart: -1, relatedItems: rows };
}

/**
 * DC-147d: a request function that answers only relatedItems forward, for the quick demo (it has no made-up org in memory).
 * `lookup` gives the map (its title and owner) from the scan on screen; `latencyMs` is how long each answer takes.
 */
export function createRelatedFake(lookup: (id: string) => RelatedMap | undefined, latencyMs = 450): RequestFn {
  return (path, params = {}, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    const m = /^content\/items\/([0-9a-f]{32})\/relatedItems$/.exec(path);
    const map = m ? lookup(m[1] as string) : undefined;
    const body = !m || params.direction !== 'forward' ? { error: { code: 400, message: 'Unknown endpoint', details: [] } }
      : !map ? { error: { code: 400, message: 'Item does not exist or is inaccessible.', details: [] } }
      : simulatedRelatedForward(map);
    setTimeout(() => resolve(body), latencyMs);
  });
}

/**
 * DC-096: a few past sends for the simulated org's nudge log, as the app's table would hold them, so Review shows
 * "Since your nudges". Built from the scan's own data (deterministic per seed): each send lists some of an owner's
 * layers, sometimes one that someone else owns now (handed over) and sometimes ids no longer in the org (gone).
 * Sends are 7 to 11 months old, past the six-month rest, so the simulated review's ticks are unchanged.
 */
export function simulatedNudgeRows(data: Data, seed = DEFAULT_SIM.seed, admin = 'sim_admin'): Record<string, unknown>[] {
  const rand = seeded(seed + 96);
  const hex = () => Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  const ref = Date.parse(data.org.scannedAt);
  const sources = data.services.filter((s) => !s.isView);
  const byOwner = new Map<string, typeof sources>();
  for (const s of sources) byOwner.set(s.owner, [...(byOwner.get(s.owner) ?? []), s]);
  const owners = [...byOwner.keys()].filter((o) => o !== admin && (byOwner.get(o)?.length ?? 0) >= 2).sort().slice(0, 40).filter(() => rand() < 0.5).slice(0, 14);
  const credits = (mb: number | null) => ((mb ?? 0) / 10) * 2.4;
  const rows: Record<string, unknown>[] = owners.map((owner, i) => {
    const mine = (byOwner.get(owner) ?? []).slice(0, 4);
    const ids = mine.map((s) => s.id);
    let total = mine.reduce((n, s) => n + credits(s.sizeMB), 0);
    const gone = rand() < 0.7 ? 1 + Math.floor(rand() * 3) : 0;
    for (let g = 0; g < gone; g++) { ids.push(hex()); total += 0.5 + rand() * 20; }
    const other = sources[Math.floor(rand() * sources.length)];
    if (i % 4 === 1 && other && other.owner !== owner) { ids.push(other.id); total += credits(other.sizeMB); }
    return {
      owner, sent_at: ref - Math.round((215 + rand() * 120) * DAY), item_ids: ids.join(','), item_count: ids.length,
      credits: Math.round(total * 100) / 100, sender: admin, app_version: 'decluttering-web 0.1', is_test: 0,
    };
  });
  // A test send to the admin: kept in the table, left out of "Since your nudges".
  rows.push({ owner: admin, sent_at: ref - 230 * DAY, item_ids: sources[0]?.id ?? '', item_count: 1, credits: 1, sender: admin, app_version: 'decluttering-web 0.1', is_test: 1 });
  return rows;
}
