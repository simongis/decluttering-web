import type { Message, MessageKey } from './en';
import { esCore } from './es/core';
import { esShell } from './es/shell';
import { esScan } from './es/scan';
import { esReview } from './es/review';
import { esEmails } from './es/emails';
import { esAbout } from './es/about';

export const es: Record<MessageKey, Message> = { ...esCore, ...esShell, ...esScan, ...esReview, ...esEmails, ...esAbout };
