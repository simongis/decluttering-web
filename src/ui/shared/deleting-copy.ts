// ADR 0016: copy that promises "never deletes" is true only for a build with deleting off. A build with VITE_DELETING=on
// shows the other wording. One switch, so no screen can keep the old promise by mistake.
import { DELETING_MODE, type DeletingMode } from '../../auth/deleting';
import type { MessageKey } from '../../i18n';

export function deletingCopy(off: MessageKey, on: MessageKey, mode: DeletingMode = DELETING_MODE): MessageKey {
  return mode === 'on' ? on : off;
}
