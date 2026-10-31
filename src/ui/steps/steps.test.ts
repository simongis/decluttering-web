import { describe, expect, it } from 'vitest';
import { stepsFor, stepLine, type StepsInput } from './steps';
import { t } from '../../i18n';

const EMAILS_HINT = t('steps.emailsHint');

const base: StepsInput = { showing: 'review', hasData: true, hasScan: true, ticked: 0, noEmails: false };
const states = (i: Partial<StepsInput>) => stepsFor({ ...base, ...i }).map((s) => `${s.id}:${s.state}`);

describe('stepsFor', () => {
  it('signed in on Review, nothing ticked: Scan is a link, Emails is disabled with a hint', () => {
    expect(states({})).toEqual(['scan:link', 'review:current', 'emails:disabled']);
    expect(stepsFor(base)[2].hint).toBe(EMAILS_HINT);
  });
  it('Emails opens once something is ticked', () => {
    expect(states({ ticked: 3 })).toEqual(['scan:link', 'review:current', 'emails:link']);
  });
  it('on the scan screen with no data yet, Review and Emails are disabled', () => {
    expect(states({ showing: 'scan', hasData: false, ticked: 2 })).toEqual(['scan:current', 'review:disabled', 'emails:disabled']);
  });
  it('on the scan screen after a scan, Review is a link', () => {
    expect(states({ showing: 'scan', ticked: 1 })).toEqual(['scan:current', 'review:link', 'emails:link']);
  });
  it('on Emails, Emails is current and the others are links', () => {
    expect(states({ showing: 'emails', ticked: 1 })).toEqual(['scan:link', 'review:link', 'emails:current']);
  });
  it('solo or my-items: only two steps, no Emails', () => {
    expect(states({ noEmails: true })).toEqual(['scan:link', 'review:current']);
    expect(states({ noEmails: true, showing: 'scan' })).toEqual(['scan:current', 'review:link']);
  });
  it('the quick demo has no scan to return to', () => {
    expect(states({ hasScan: false, ticked: 1 })).toEqual(['scan:disabled', 'review:current', 'emails:link']);
  });
});

describe('stepLine', () => {
  it('names the current step and its place', () => {
    expect(stepLine(stepsFor(base))).toBe('Step 2 of 3: Review');
    expect(stepLine(stepsFor({ ...base, noEmails: true, showing: 'scan' }))).toBe('Step 1 of 2: Scan');
  });
});
