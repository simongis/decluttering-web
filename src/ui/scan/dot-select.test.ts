import { describe, expect, it } from 'vitest';
import { idsInRect, isDrag, normalise } from './dot-select';

const dots = [
  { id: 'a', x: 10, y: 10, drawn: true },
  { id: 'b', x: 50, y: 50, drawn: true },
  { id: 'c', x: 90, y: 90, drawn: true },
  { id: 'hidden', x: 50, y: 50, drawn: false },
  { id: 'view', x: 50, y: 50, drawn: true, view: true },
  { id: 'b', x: 51, y: 51, drawn: true },
];

describe('dot rectangle selection', () => {
  it('picks drawn dots inside, edges included, each once', () => {
    expect(idsInRect(dots, { x0: 10, y0: 10, x1: 50, y1: 50 })).toEqual(['a', 'b']);
  });
  it('works whichever way the rectangle was drawn', () => {
    expect(idsInRect(dots, { x0: 95, y0: 95, x1: 40, y1: 40 })).toEqual(['b', 'c']);
    expect(normalise({ x0: 5, y0: 9, x1: 1, y1: 2 })).toEqual({ x0: 1, y0: 2, x1: 5, y1: 9 });
  });
  it('leaves out undrawn dots and unjoined views', () => {
    expect(idsInRect(dots, { x0: 45, y0: 45, x1: 55, y1: 55 })).toEqual(['b']);
  });
  it('an empty area picks nothing', () => {
    expect(idsInRect(dots, { x0: 60, y0: 0, x1: 80, y1: 20 })).toEqual([]);
  });
  it('a press only becomes a drag past the threshold', () => {
    expect(isDrag({ x0: 0, y0: 0, x1: 3, y1: 3 })).toBe(false);
    expect(isDrag({ x0: 0, y0: 0, x1: 4, y1: 0 })).toBe(true);
    expect(isDrag({ x0: 0, y0: 0, x1: 0, y1: -6 })).toBe(true);
  });
});
