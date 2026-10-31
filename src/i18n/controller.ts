import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { onLocaleChange } from './index';

/**
 * Re-renders a Lit component when the language changes. Add one field to every component that shows translated text:
 * `private readonly _locale = new LocaleController(this);`
 */
export class LocaleController implements ReactiveController {
  private off: (() => void) | null = null;
  constructor(private readonly host: ReactiveControllerHost) { host.addController(this); }
  hostConnected(): void { this.off = onLocaleChange(() => this.host.requestUpdate()); }
  hostDisconnected(): void { this.off?.(); this.off = null; }
}
