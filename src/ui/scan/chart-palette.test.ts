// DC-135: the dot map keeps its standard colours unless the console look is on.
import { describe, expect, it } from 'vitest';
import { CONSOLE_PALETTE, STANDARD_PALETTE, chartPalette } from './chart-palette';
import { RAMP, rampColour } from './dot-layout';

const root = (skin: string | null) => ({ getAttribute: (n: string) => (n === 'data-skin' ? skin : null) });

describe('chartPalette', () => {
  it('is the standard chart unless <html> says console', () => {
    expect(chartPalette(root(null))).toBe(STANDARD_PALETTE);
    expect(chartPalette(root('other'))).toBe(STANDARD_PALETTE);
    expect(chartPalette(root('console'))).toBe(CONSOLE_PALETTE);
    expect(chartPalette(null)).toBe(STANDARD_PALETTE);
  });

  it('the standard palette is the chart as it was (colours and ramp unchanged)', () => {
    expect(STANDARD_PALETTE).toMatchObject({ text: '#5b6b78', grid: '#eef2f5', zoneLine: '#b01f59', grey: '#9fb2c0', pending: '#dfe6ec', ring: '#1b3a57', starChart: false });
    expect(STANDARD_PALETTE.ramp).toBe(RAMP);
    expect(rampColour(0)).toBe('rgb(250,166,26)');
    expect(rampColour(1)).toBe('rgb(176,31,89)');
  });

  it('the console ramp warms from peach to rust', () => {
    expect(rampColour(0, CONSOLE_PALETTE.ramp)).toBe('rgb(255,197,143)');
    expect(rampColour(1, CONSOLE_PALETTE.ramp)).toBe('rgb(224,116,90)');
  });
});
