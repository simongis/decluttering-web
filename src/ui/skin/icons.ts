// DC-135 (ADR 0014): the header switch's two icons, 24 px viewBox, currentColor.
// The console side is a minimalist badge glyph. It lives here alone, so changing it is a one-line change.
import { svg } from 'lit';

/** A solid arrowhead with a curved base over a soft oval, simplified to read at 14 px. */
export const DELTA_ICON = svg`<ellipse cx="12" cy="14" rx="10.5" ry="5.5" fill="currentColor" opacity="0.35"></ellipse>
  <path fill="currentColor" d="M12 2c1.7 5.4 3.6 11.4 5.8 19-2.2-1.7-4-2.4-5.8-2.4s-3.6.7-5.8 2.4C8.4 13.4 10.3 7.4 12 2z"></path>`;

/** A sun: the usual "light look" mark. */
export const SUN_ICON = svg`<circle cx="12" cy="12" r="4.4" fill="currentColor"></circle>
  <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"></path>
  </g>`;
