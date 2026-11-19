// ADR 0016: picking dots with a rectangle drawn on the Review chart. Pure, so the hit rule is tested without a canvas.

export interface DragRect { x0: number; y0: number; x1: number; y1: number }
export interface Placed {
  id: string; x: number; y: number;
  /** Drawn: its own dot (rad > 0) or part of the density shading. */ drawn: boolean;
  /** A view not yet joined to its source: never picked. */ view?: boolean;
  /** The drawn radius in px: a dot is picked when any of it is inside, as the user sees it (0: its centre must be inside). */ r?: number;
}

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

/**
 * The ids of drawn dots that touch the rectangle (edges included), each once, in the order given. Touching, not "centre
 * inside": a drag that starts on a dot takes that dot, and a dot half inside the box is in it, as it looks.
 */
export function idsInRect(dots: readonly Placed[], rect: DragRect): string[] {
  const r = normalise(rect);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dots) {
    if (!d.drawn || d.view || seen.has(d.id)) continue;
    // The nearest point of the box to the centre, then the distance to it: inside or touching when within the radius.
    const nx = Math.max(r.x0, Math.min(d.x, r.x1)), ny = Math.max(r.y0, Math.min(d.y, r.y1));
    const rad = Math.max(0, d.r ?? 0);
    if ((nx - d.x) ** 2 + (ny - d.y) ** 2 <= rad * rad) { seen.add(d.id); out.push(d.id); }
  }
  return out;
}
