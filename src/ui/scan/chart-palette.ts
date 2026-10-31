// DC-135 (ADR 0014): the dot map's colours. The standard palette is the chart as it always was; the console look draws
// it as a star chart: a near-black field, a faint dotted graticule, lilac corner brackets, condensed capitals, and
// stale dots that warm from peach through amber to rust with a soft glow. Positions, sizes and meaning never change.
import { RAMP } from './dot-layout';

export interface ChartPalette {
  /** Axis labels and titles. */
  text: string;
  grid: string; frame: string; sep: string;
  zoneFill: string; zoneLine: string;
  /** Behind label text, so it reads over dots. */
  halo: string;
  /** Not-stale dots, dots still being read, the ring on dots with links, the focus ring. */
  grey: string; pending: string; ring: string; focus: string;
  ramp: typeof RAMP;
  font: string;
  /** Star-chart extras: dotted grid, corner brackets, capitals, glow on stale dots. */
  starChart: boolean;
}

export const STANDARD_PALETTE: ChartPalette = {
  text: '#5b6b78', grid: '#eef2f5', frame: '#e3e9ee', sep: '#dbe3e9',
  zoneFill: 'rgba(9,35,64,0.04)', zoneLine: '#b01f59', halo: 'rgba(255,255,255,0.9)',
  grey: '#9fb2c0', pending: '#dfe6ec', ring: '#1b3a57', focus: '#0a2540',
  ramp: RAMP, font: 'system-ui, sans-serif', starChart: false,
};

// Contrast on #05060d: text #ffc58f 12.8, zone #ffa133 10.1, stars #aab4d6 9.6.
export const CONSOLE_PALETTE: ChartPalette = {
  text: '#ffc58f', grid: 'rgba(158,167,255,0.28)', frame: '#c79bdb', sep: 'rgba(199,155,219,0.45)',
  zoneFill: 'rgba(255,161,51,0.07)', zoneLine: '#ffa133', halo: 'rgba(5,6,13,0.9)',
  grey: '#aab4d6', pending: '#2a2a38', ring: '#f4ead8', focus: '#9ea7ff',
  ramp: { from: '#ffc58f', mid: '#ffa133', to: '#e0745a' },
  font: '"Antonio", "Arial Narrow", system-ui, sans-serif', starChart: true,
};

/** The palette for the look in force (read from <html>, so it follows the header toggle at once). */
export function chartPalette(root: { getAttribute(n: string): string | null } | null = typeof document === 'undefined' ? null : document.documentElement): ChartPalette {
  return root?.getAttribute('data-skin') === 'console' ? CONSOLE_PALETTE : STANDARD_PALETTE;
}
