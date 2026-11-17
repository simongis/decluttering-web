// DC-074: the dev route `#/simulate?n=7000&speed=1`. Parses the URL into a simulated org and a fake signed-in access.
// Only ever loaded through `if (import.meta.env.DEV) await import('./dev/simulate')` in app-root.ts, so production builds drop it.
import type { AccessInfo } from '../auth/session';
import { deleteScope } from '../auth/deleting';
import { DEFAULT_SIM, createSimulatedOrg, type SimulatedOrg, type SimulatedOrgConfig } from './simulated-org';

/**
 * Who signs in to the simulated org. `admin` (default): full admin, may delete anyone's layers. `member`: My items, may
 * delete their own layers (ADR 0016). `viewer`: an admin without the delete privileges, to see the delete bar say so.
 */
export type SimRole = 'admin' | 'member' | 'viewer';
export interface SimulateParams { config: Partial<SimulatedOrgConfig>; role?: SimRole }

const num = (q: URLSearchParams, key: string): number | undefined => {
  const raw = q.get(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** `#/simulate?n=7000&speed=1&owners=400&maps=3000&unreadable=5&r429=0.02&retry=2&seed=74&solo=1&role=member` (solo: one member, every service the admin's; role: see SimRole), or null when the hash is another route. */
export function parseSimulate(hash: string): SimulateParams | null {
  const m = /^#\/simulate\/?(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1] ?? '');
  const config: Partial<SimulatedOrgConfig> = {};
  const set = <K extends keyof SimulatedOrgConfig>(k: K, v: SimulatedOrgConfig[K] | undefined) => { if (v !== undefined) config[k] = v; };
  const n = num(q, 'n');
  set('services', n === undefined ? undefined : Math.min(10000, Math.round(n)));
  set('speed', num(q, 'speed'));
  set('owners', num(q, 'owners'));
  set('maps', num(q, 'maps'));
  set('unreadableMaps', num(q, 'unreadable'));
  set('rate429', num(q, 'r429'));
  set('retryAfter', num(q, 'retry'));
  set('seed', num(q, 'seed'));
  set('viewShare', num(q, 'views'));
  if (['1', 'true'].includes(q.get('solo') ?? '')) config.solo = true;
  const role = q.get('role');
  return role === 'member' || role === 'viewer' ? { config, role } : { config };
}

export interface Simulation { org: SimulatedOrg; access: AccessInfo }

/** The fake signed-in admin for a simulated org. Writable is on so the Emails step is reachable; it runs on the demo notifier. */
export function startSimulation(p: SimulateParams): Simulation {
  const org = createSimulatedOrg(p.config);
  const access: AccessInfo = {
    mode: p.role === 'member' ? 'my-items' : 'admin', username: 'sim_admin', fullName: 'Sim Admin', orgName: org.config.orgName, orgId: org.config.orgId,
    role: p.role === 'member' ? 'org_user' : 'org_admin', usageReadable: true, writable: p.role !== 'member',
    // 'none' whenever this build has deleting off
    deleteScope: deleteScope(p.role === 'member' ? ['portal:user:createItem'] : p.role === 'viewer' ? [] : ['portal:admin:deleteItems']),
  };
  (window as unknown as { __sim?: unknown }).__sim = { config: org.config, stats: org.stats, services: org.world.services.length, maps: org.world.maps.length, owners: org.world.owners.length };
  return { org, access };
}

export { DEFAULT_SIM };
