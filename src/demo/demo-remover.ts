// The demo's stand-in for the remover (ADR 0016): it says yes after a short pause and touches nothing, so the demo can show
// the whole delete flow without any account, request or change anywhere. It only removes the layers from the demo's own list.
import type { ItemRemover, RemoveFamily, RemoveOutcome } from '../remove/remover';

export function createDemoRemover(pauseMs = 350): ItemRemover {
  return {
    async removeFamilies(families: readonly RemoveFamily[], o = {}) {
      const out: RemoveOutcome[] = [];
      for (const f of families) {
        if (o.signal?.aborted) out.push({ id: f.id, ok: false, reason: 'stopped', removed: [] });
        else {
          await new Promise((r) => setTimeout(r, pauseMs));
          out.push({ id: f.id, ok: true, removed: [...f.views.map((v) => v.id), f.source.id] });
        }
        o.onProgress?.(out.length, families.length);
      }
      return out;
    },
  };
}
