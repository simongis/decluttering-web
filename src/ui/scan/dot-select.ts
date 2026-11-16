// ADR 0016: picking dots with a rectangle drawn on the Review chart. Pure, so the hit rule is tested without a canvas.

export interface DragRect { x0: number; y0: number; x1: number; y1: number }
export interface Placed { id: string; x: number; y: number; /** Drawn: its own dot (rad > 0) or part of the density shading. */ drawn: boolean; /** A view not yet joined to its source: never picked. */ view?: boolean }

/** Movement in px before a press becomes a drag (a click that wobbles stays a click). */
export const DRAG_MIN = 4;

/** The rectangle with x0 <= x1 and y0 <= y1. */
export function normalise(r: DragRect): DragRect {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

/** True once the pointer has moved far enough from where it went down to count as a drag. */
export function isDrag(r: DragRect, min = DRAG_MIN): boolean {
  return Math.abs(r.x1 - r.x0) >= min || Math.abs(r.y1 - r.y0) >= min;
}

/** The ids of drawn dots whose centre is inside the rectangle (edges included), each once, in the order given. */
export function idsInRect(dots: readonly Placed[], rect: DragRect): string[] {
  const r = normalise(rect);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dots) {
    if (!d.drawn || d.view || seen.has(d.id)) continue;
    if (d.x >= r.x0 && d.x <= r.x1 && d.y >= r.y0 && d.y <= r.y1) { seen.add(d.id); out.push(d.id); }
  }
  return out;
}
