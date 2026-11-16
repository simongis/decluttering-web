// The remover's own allow-list (ADR 0016). Like the notifier's, it is separate from the scan's read-only guard, which stays
// unchanged. It lists the one write that deleting needs and the one read that checks an item first; anything else throws
// before a request. A delete is allowed only for what the signed-in user may delete (their own, or anyone's with the admin
// privilege), is never permanent, and carries no other parameter.
import type { Method, RequestFn } from '../scan/types';
import { mayDelete, type DeleteScope } from '../auth/deleting';

/** Same name as the other guards' error, so callers that count blocked calls treat them alike. */
export class BlockedRequest extends Error {
  constructor(what: string, reason: string) {
    super(`BLOCKED (remove guard): ${what} - ${reason}`);
    this.name = 'BlockedRequest';
  }
}

const ID32 = '[0-9a-f]{32}';
const USER = '[A-Za-z0-9_.@-]+';

export type RemoveOp = 'deleteItem' | 'readItem';
interface Rule { op: RemoveOp; re: RegExp; methods: Method[] }

/** Paths are relative to <portal>/sharing/rest/ and anchored. The delete may name the folder the item sits in. */
export const REMOVE_ALLOW: Rule[] = [
  { op: 'deleteItem', re: new RegExp(`^content/users/(${USER})/(?:${ID32}/)?items/(${ID32})/delete$`), methods: ['POST'] },
  { op: 'readItem', re: new RegExp(`^content/items/(${ID32})$`), methods: ['GET'] },
];

export interface RemoveGuardContext {
  /** The signed-in username. */
  self?: string | null;
  /** What this user may delete. Anything but `all` or `own` blocks every delete. */
  scope?: DeleteScope | null;
}

/** Returns the matched operation, or throws BlockedRequest. Never makes a request. */
export function assertRemoveAllowed(path: string, method: string, ctx: RemoveGuardContext = {}, params: Record<string, unknown> = {}): RemoveOp {
  if (typeof path !== 'string' || !path) throw new BlockedRequest(String(path), 'empty path');
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new BlockedRequest(path, 'absolute urls are not allowed');
  if (/[?#%\\\s]|(^|\/)\.\.?(\/|$)|\/\/|^\/|\/$/.test(path)) throw new BlockedRequest(path, 'malformed path');
  const m = String(method).toUpperCase();
  const rule = REMOVE_ALLOW.find((r) => r.re.test(path));
  if (!rule) throw new BlockedRequest(path, 'endpoint is not on the remover allow-list');
  if (!(rule.methods as string[]).includes(m)) throw new BlockedRequest(`${m} ${path}`, 'method not allowed for this endpoint');
  if (rule.op === 'deleteItem') {
    const owner = rule.re.exec(path)?.[1] ?? '';
    const what = path.replace(/[0-9a-f]{32}/g, '<id>');
    if (!mayDelete(ctx.scope ?? undefined, ctx.self ?? undefined, owner)) throw new BlockedRequest(what, 'this user may not delete that owner\'s items');
    // Never permanent: ArcGIS Online then moves the item to the recycle bin where the org has one. `f` is the only parameter.
    if (Object.keys(params).some((k) => k !== 'f')) throw new BlockedRequest(what, 'a delete takes no parameters');
  }
  return rule.op;
}

/** Wraps a raw request function: every call is checked against REMOVE_ALLOW first, with the context read at call time. */
export function guardRemoveRequest(inner: RequestFn, ctx: () => RemoveGuardContext): RequestFn {
  return async (path, params = {}, options = {}) => {
    const rule = REMOVE_ALLOW.find((r) => r.re.test(path));
    const method = (options.method ?? rule?.methods[0] ?? 'GET').toUpperCase() as Method;
    assertRemoveAllowed(path, method, ctx(), params);
    return inner(path, params, { ...options, method });
  };
}
