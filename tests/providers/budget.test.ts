import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/config';

describe('BudgetGuard', () => {
  it('blocks a paid call above the remaining project budget', () => {
    const guard = new BudgetGuard({ limitCny: 5, spentCny: 4.2, dryRun: false });

    expect(() => guard.assertAllowed({ providerId: 'openai-tts', currency: 'CNY', amount: 1, basis: 'chars' }))
      .toThrow('Paid call requires approval: estimated 1 CNY, remaining 0.8 CNY');
  });

  it('allows only zero-cost operations when no project budget is configured', () => {
    const guard = new BudgetGuard({ spentCny: 0, dryRun: false });

    expect(() => guard.assertAllowed({ providerId: 'jianying-manual', currency: 'CNY', amount: 0, basis: 'manual' }))
      .not.toThrow();
    expect(() => guard.assertAllowed({ providerId: 'openai-tts', currency: 'CNY', amount: 0.01, basis: 'chars' }))
      .toThrow('Paid call requires approval: estimated 0.01 CNY, remaining 0 CNY');
  });

  it('allows a paid estimate during a dry run without a project budget', () => {
    const guard = new BudgetGuard({ spentCny: 0, dryRun: true });

    expect(() => guard.assertAllowed({ providerId: 'openai-tts', currency: 'CNY', amount: 1, basis: 'chars' }))
      .not.toThrow();
  });
});
