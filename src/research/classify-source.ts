import type { SourceRecord } from '../domain/schemas';

export type SourceUse = 'fact' | 'mechanism' | 'public-question';

export interface SourceClassification {
  allowedUses: SourceUse[];
}

/**
 * Classifies what a source may support. This is intentionally based only on
 * the recorded source type: no source weight or language model may upgrade it.
 */
export function classifySource(source: SourceRecord): SourceClassification {
  switch (source.sourceType) {
    case 'primary':
    case 'official-data':
    case 'professional-media':
      return { allowedUses: ['fact'] };
    case 'expert-analysis':
      return { allowedUses: ['mechanism'] };
    case 'comment-sample':
      return { allowedUses: ['public-question'] };
  }
}
