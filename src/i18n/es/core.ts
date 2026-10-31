import type { Message } from '../en/core';
import type { enCore } from '../en/core';

export const esCore: Record<keyof typeof enCore, Message> = {
  'lang.label': 'Idioma',
  'steps.nav': 'Pasos',
  'steps.scan': 'Análisis',
  'steps.review': 'Revisión',
  'steps.emails': 'Correos',
  'steps.scanHint': 'La demo rápida se salta el análisis.',
  'steps.reviewHint': 'La revisión se abre cuando el análisis haya encontrado tus capas.',
  'steps.emailsHint': 'Marca a un propietario en la revisión para escribir correos.',
  'steps.line': 'Paso {n} de {total}: {label}',
  'steps.count': 'paso {n} de {total}',
  'steps.linkLabel': '{label}, paso {n}',
  'steps.disabledLabel': '{label}, paso {n}, todavía no disponible. {hint}',
};
