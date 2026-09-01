import { describe, expect, it } from 'vitest';
import { transition } from '../../src/domain/state-machine';

describe('workflow transition', () => {
  it('requires topic approval before drafting a script', () => {
    expect(() => transition('RESEARCHED', 'DRAFT_SCRIPT')).toThrow(
      'TOPIC_APPROVED is required before DRAFT_SCRIPT',
    );
  });

  it('moves from topic review to approved only on human approval', () => {
    expect(transition('TOPIC_REVIEW_REQUIRED', 'APPROVE_TOPIC')).toBe('TOPIC_APPROVED');
  });
});
