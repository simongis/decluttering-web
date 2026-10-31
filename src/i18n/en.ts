import { enCore, type Message } from './en/core';
import { enShell } from './en/shell';
import { enScan } from './en/scan';
import { enReview } from './en/review';
import { enEmails } from './en/emails';
import { enAbout } from './en/about';

export type { Message, PluralForms } from './en/core';

/** English: the source of truth for every message key. Each area lives in its own file under en/ (and es/). */
export const en = { ...enCore, ...enShell, ...enScan, ...enReview, ...enEmails, ...enAbout } as const satisfies Record<string, Message>;
export type MessageKey = keyof typeof en;
