// DC-147d: the one relatedItems loader the item panel and the idle pre-fetch share, and where its requests come from.
// Signed in: the session's guarded request (src/scan/request.ts: the read-only allow-list, which has relatedItems GET), built
// from the stored session as the owner pictures do. The demo and the simulator: the made-up org the scan read (no network);
// the quick demo, which has none in memory, gets a stand-in that answers from the map's id (src/demo/simulated-org.ts).
import type { RequestFn } from '../../scan/types';
import type { Data } from '../../domain/types';
import { createRequest } from '../../scan/request';
import { loadSession } from '../../auth/session';
import { PORTAL_URL } from '../../auth/config';
import { RelatedLoader } from './related-loader';
import { fakeRelatedFor } from './related-fake';

let data: Data | null = null;
let quickFake: { data: Data; request: RequestFn } | null = null;

/** The quick demo (no made-up org in memory) stays on #/demo. */
const fakeRoute = () => typeof location !== 'undefined' && /^#\/demo/.test(location.hash);

async function resolve(): Promise<RequestFn | null> {
  const d = data;
  if (!d) return null;
  // The made-up org the scan on screen came from (the demo, or the simulator, which moves on to #/review): same org id.
  const own = fakeRelatedFor(d.org.id);
  if (own) return own;
  if (fakeRoute()) {
    if (quickFake?.data !== d) {
      const { createRelatedFake } = await import('../../demo/simulated-org');
      const maps = new Map<string, { id: string; title: string; owner: string }>();
      for (const s of d.services) for (const x of s.dependencies) maps.set(x.id, x);
      quickFake = { data: d, request: createRelatedFake((id) => maps.get(id)) };
    }
    return quickFake.request;
  }
  const m = loadSession();
  return m ? createRequest(m, { portal: PORTAL_URL }) : null;
}

export const relatedLoader = new RelatedLoader(resolve);

/** The scan on screen: its org and scan time are the cache's run (a rescan or another org clears it). */
export function useRelatedData(d: Data): void {
  data = d;
  relatedLoader.setRun(`${d.org.id}|${d.org.scannedAt}`);
}
