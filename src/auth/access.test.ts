import { describe, expect, it } from 'vitest';
import { ADMIN_PRIVILEGES, CAPABILITY_SUMMARY, NO_ADMIN_EMAIL, SEND_PRIVILEGES, accessMode, canSeeUsage, capabilities, emailCapability, privilegesOfMode } from './access';
import { setLocale } from '../i18n';

describe('emailCapability (DC-121)', () => {
  it('is ticked and shows the address when one is on file', () => {
    expect(emailCapability(' me@example.org ')).toEqual({ id: 'email', state: 'yes', label: 'Your email address', line: 'me@example.org' });
  });
  it('is unticked with the how-to message when there is none', () => {
    for (const e of ['', '  ']) expect(emailCapability(e)).toEqual({ id: 'email', state: 'no', label: 'Your email address', line: NO_ADMIN_EMAIL });
  });
  it('is left out while the address is not known', () => {
    expect(emailCapability(undefined)).toBeNull();
  });
});

const VIEW = ['portal:admin:viewItems', 'portal:admin:viewUsers'];
const SEND = ['portal:user:createGroup', 'portal:admin:assignToGroups'];

describe('accessMode', () => {
  it('is admin with view, group create and assign privileges and readable usage', () => {
    expect(accessMode([...VIEW, ...SEND], true)).toBe('admin');
  });
  it('is admin-cant-send without group creation', () => {
    expect(accessMode([...VIEW, 'portal:admin:assignToGroups'], true)).toBe('admin-cant-send');
  });
  it('is admin-cant-send without group assignment', () => {
    expect(accessMode([...VIEW, 'portal:user:createGroup'], true)).toBe('admin-cant-send');
  });
  it('is admin-cant-send with view privileges only', () => {
    expect(accessMode(VIEW, true)).toBe('admin-cant-send');
  });
  it('is my-items for a plain member', () => {
    expect(accessMode(['portal:user:createItem', 'portal:user:createGroup'], true)).toBe('my-items');
  });
  it('is my-items when viewItems or viewUsers is missing', () => {
    expect(accessMode(['portal:admin:viewItems', ...SEND], true)).toBe('my-items');
    expect(accessMode(['portal:admin:viewUsers', ...SEND], true)).toBe('my-items');
  });
  it('keeps the admin flow when usage is not readable (ADR 0008, no-usage mode)', () => {
    expect(accessMode([...VIEW, ...SEND], false)).toBe('admin');
    expect(accessMode([...VIEW], false)).toBe('admin-cant-send');
  });
  it('is my-items with no privileges', () => {
    expect(accessMode([], true)).toBe('my-items');
  });
  it('treats a missing privileges list as my-items', () => {
    expect(accessMode(undefined as unknown as string[], true)).toBe('my-items');
  });
  it('ignores unrelated custom-role privileges', () => {
    expect(accessMode([...VIEW, ...SEND, 'portal:user:viewHostedFeatures', 'custom:thing'], true)).toBe('admin');
  });
  it('exposes the confirmed privilege sets', () => {
    expect(ADMIN_PRIVILEGES).toEqual(VIEW);
    expect(SEND_PRIVILEGES).toEqual(SEND);
  });
});

describe('canSeeUsage', () => {
  it('follows the probe result', () => {
    expect(canSeeUsage(true)).toBe(true);
    expect(canSeeUsage(false)).toBe(false);
  });
});

describe('capabilities (DC-111)', () => {
  it('localizes the checklist copy in Spanish', async () => {
    await setLocale('es', false);
    try {
      expect(capabilities([...ADMIN_PRIVILEGES, ...SEND_PRIVILEGES], true, true, true).summary).toBe('Todo listo: puedes revisar y enviar.');
      expect(emailCapability('')?.label).toBe('Tu dirección de correo');
      expect(emailCapability('')?.line).toBe('Tu perfil de ArcGIS Online no tiene una dirección de correo, así que no hay dónde enviarte una prueba. Agrega una en tu perfil y vuelve aquí.');
    } finally { await setLocale('en', false); }
  });
  const view = [...ADMIN_PRIVILEGES], send = [...SEND_PRIVILEGES];
  const ids = (c: ReturnType<typeof capabilities>) => Object.fromEntries(c.items.map((i) => [i.id, i.state]));
  const cases: Array<[string, string[], boolean, boolean, boolean]> = [];
  for (const [n, p] of [['none', []], ['view', view], ['send', send], ['both', [...view, ...send]]] as const)
    for (const u of [false, true]) for (const w of [false, true]) for (const o of [false, true]) cases.push([n, [...p], u, w, o]);

  it.each(cases)('privileges %s, usage %s, may opt in %s, opted in %s', (_n, p, u, w, o) => {
    const c = capabilities(p, u, w, o);
    const v = view.every((x) => p.includes(x)), s = send.every((x) => p.includes(x));
    // Opting in only counts where the org may opt in at all.
    expect(ids(c)).toEqual({ view: v ? 'yes' : 'no', usage: u ? 'yes' : 'no', send: s ? 'yes' : 'no', 'org-send': w && o ? 'yes' : 'neutral' });
    expect(c.level).toBe(!v ? 'mine' : s && w && o ? 'full' : s ? 'locked' : 'review');
    expect(c.summary).toBe(CAPABILITY_SUMMARY[c.level]);
    expect(c.items.every((i) => i.label && i.line)).toBe(true);
  });

  it('has a summary line for each mode', () => {
    expect(capabilities([...view, ...send], true, true, true).summary).toBe('You’re all set: full review and sending.');
    expect(capabilities(view, true, true, true).summary).toBe('Review only: you can look through the whole org, but not send nudges.');
    expect(capabilities([...view, ...send], true, false, false).summary).toBe('Review only for now: your account could send, but sending isn’t turned on for you yet.');
    expect(capabilities([...view, ...send], true, true, false).summary).toBe('Review only for now: your account could send, but sending isn’t turned on for you yet.');
    expect(capabilities(undefined, false, true, true).summary).toMatch(/^Your own layers/);
  });

  const row = (w: boolean, o?: boolean) => capabilities([...view, ...send], true, w, o).items.find((i) => i.id === 'org-send');
  it('where no org may opt in, the row is neutral, calm and has no button', () => {
    expect(row(false, false)).toMatchObject({ state: 'neutral', label: 'Sending in this org', line: 'Sending isn’t available on this site yet. You can still review everything and write the emails.' });
    expect(row(false, false)?.action).toBeUndefined();
    expect(row(false, true)?.state).toBe('neutral');
    expect(row(false, true)?.action).toBeUndefined();
  });
  it('the button only shows for an account that could send (it needs the group privileges)', () => {
    expect(capabilities(view, true, true, false).items.find((i) => i.id === 'org-send')?.action).toBeUndefined();
    expect(capabilities(send, true, true, false).items.find((i) => i.id === 'org-send')?.action).toBe('turn-on');
  });
  it('where the org may opt in: off for you offers Turn on; on for you offers Turn off instead', () => {
    expect(row(true, false)).toMatchObject({ state: 'neutral', line: 'Off for you. Turn it on when you’re ready; nothing is sent until you choose.', action: 'turn-on' });
    expect(row(true)?.action).toBe('turn-on');
    expect(row(true, true)).toMatchObject({ state: 'yes' });
    expect(row(true, true)?.line).toMatch(/^On for you\./);
    expect(row(true, true)?.action).toBe('turn-off');
    expect(row(true, false)?.line).not.toMatch(/Switched off here for now/);
  });

  it('privilegesOfMode agrees with accessMode', () => {
    for (const m of ['admin', 'admin-cant-send', 'my-items'] as const) expect(accessMode(privilegesOfMode(m), true)).toBe(m);
  });
});
