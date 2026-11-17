import { describe, expect, it } from 'vitest';
import { deletingCopy } from './deleting-copy';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';

const PAIRS = [
  ['about.intro', 'about.intro.deleting'],
  ['about.what.lead', 'about.what.lead.deleting'],
  ['review.admin.note', 'review.admin.note.deleting'],
  ['review.nudge.body', 'review.nudge.body.deleting'],
  ['tour.tick.text', 'tour.tick.text.deleting'],
] as const;

describe('deleting copy', () => {
  it('picks the wording for the build', () => {
    expect(deletingCopy('about.intro', 'about.intro.deleting', 'off')).toBe('about.intro');
    expect(deletingCopy('about.intro', 'about.intro.deleting', 'on')).toBe('about.intro.deleting');
  });
  it('the deleting wording never promises that nothing is deleted, in any language', () => {
    for (const [, on] of PAIRS) {
      expect(String(en[on]), on).not.toMatch(/never delet|nothing is deleted|nothing ever deleted/i);
      expect(String(es[on]), on).not.toMatch(/nunca borr|no se eliminará nada|sin borrar nunca|nunca elimin/i);
    }
  });
  it('keeps the same placeholders as the wording it replaces', () => {
    const names = (s: unknown) => (String(s).match(/\{\w+\}/g) ?? []).sort().join();
    for (const [off, on] of PAIRS) { expect(names(en[on]), on).toBe(names(en[off])); expect(names(es[on]), on).toBe(names(es[off])); }
  });
});
