import { describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/config';

describe('BudgetGuard', () => {
  it('atomically reserves remaining budget across concurrent attempts', async () => {
    const guard = new BudgetGuard({ limitCny: 1, spentCny: 0, dryRun: false });
    const estimate = { providerId: 'openai-tts', currency: 'CNY' as const, amount: 0.75, basis: 'fixture estimate' };

    const results = await Promise.allSettled([
      Promise.resolve().then(() => guard.reserve('00000000-0000-4000-8000-000000000011', estimate)),
      Promise.resolve().then(() => guard.reserve('00000000-0000-4000-8000-000000000012', estimate)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(guard.reservedCny()).toBe(0.75);
  });

  it('settles the same reservation idempotently and rejects conflicting actual costs', () => {
    const guard = new BudgetGuard({ limitCny: 1, spentCny: 0, dryRun: false });
    const reservationId = '00000000-0000-4000-8000-000000000013';
    guard.reserve(reservationId, {
      providerId: 'openai-tts', currency: 'CNY', amount: 0.75, basis: 'fixture estimate',
    });
    const actual = { providerId: 'openai-tts', currency: 'CNY' as const, amount: 0.5, basis: 'provider charge' };

    const first = guard.settleReservation(reservationId, actual);
    const duplicate = guard.settleReservation(reservationId, actual);

    expect(duplicate).toEqual(first);
    expect(guard.spentCny()).toBe(0.5);
    expect(guard.reservedCny()).toBe(0);
    expect(() => guard.settleReservation(reservationId, { ...actual, amount: 0.6 })).toThrow(
      'reservation was already settled with a different actual cost',
    );
    expect(guard.spentCny()).toBe(0.5);
  });

  it('rejects an invalid or mismatched actual before mutating spent cost', () => {
    const guard = new BudgetGuard({ limitCny: 1, spentCny: 0, dryRun: false });
    const reservationId = '00000000-0000-4000-8000-000000000014';
    guard.reserve(reservationId, {
      providerId: 'openai-tts', currency: 'CNY', amount: 0.75, basis: 'fixture estimate',
    });

    expect(() => guard.settleReservation(reservationId, {
      providerId: 'other-provider', currency: 'CNY', amount: 0.5, basis: 'provider charge',
    })).toThrow('actual cost must match the reserved provider and currency');
    expect(() => guard.settleReservation(reservationId, {
      providerId: 'openai-tts', currency: 'CNY', amount: Number.NaN, basis: 'provider charge',
    })).toThrow('Actual cost amount must be a finite, non-negative CNY value');
    expect(guard.spentCny()).toBe(0);
  });

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

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an invalid amount of %s before applying budget policy',
    (amount) => {
      const guard = new BudgetGuard({ spentCny: 0, dryRun: true });

      expect(() => guard.assertAllowed({ providerId: 'openai-tts', currency: 'CNY', amount, basis: 'chars' }))
        .toThrow('Cost estimate amount must be a finite, non-negative CNY value');
    },
  );
});
