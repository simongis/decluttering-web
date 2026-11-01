// DC-147d: the made-up org's request function for the item panel's relatedItems calls (the demo and the dev simulator), so
// the panel asks the same in-memory org the scan read. Set by createSimulatedOrg; no imports, so the demo chunk stays small.
import type { RequestFn } from '../../scan/types';

let current: { orgId: string; request: RequestFn } | null = null;

export function setFakeRelated(orgId: string, request: RequestFn | null): void { current = request ? { orgId, request } : null; }

/** The made-up org's request when the scan on screen came from it (same org id), else null. */
export function fakeRelatedFor(orgId: string): RequestFn | null { return current && current.orgId === orgId ? current.request : null; }
