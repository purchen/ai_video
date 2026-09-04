import { randomUUID } from 'node:crypto';
import type { CostEstimate } from './providers/contracts';

export interface ProviderConfig {
  OPENAI_API_KEY?: string;
  PROJECT_BUDGET_CNY?: string;
}

export function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export interface BudgetGuardOptions {
  limitCny?: number;
  spentCny: number;
  dryRun: boolean;
}

export interface BudgetAuthorization {
  reservationId: string;
  providerId: string;
  currency: 'CNY';
  maximumAmountCny: number;
  remainingAtAuthorizationCny: number;
}

export interface BudgetSettlement {
  reservationId: string;
  actual: CostEstimate;
  withinAuthorization: boolean;
}

export class BudgetGuard {
  private actualSpentCny: number;
  private readonly reservations = new Map<string, {
    authorization: BudgetAuthorization;
    estimate: CostEstimate;
    settlement?: BudgetSettlement;
  }>();

  constructor(private readonly options: BudgetGuardOptions) {
    this.actualSpentCny = options.spentCny;
  }

  assertAllowed(estimate: CostEstimate): void {
    if (!Number.isFinite(estimate.amount) || estimate.amount < 0) {
      throw new Error('Cost estimate amount must be a finite, non-negative CNY value');
    }

    if (this.options.dryRun || estimate.amount === 0) return;

    const remaining = (this.options.limitCny ?? 0) - this.actualSpentCny;
    if (remaining >= estimate.amount) return;

    throw new Error(
      `Paid call requires approval: estimated ${formatCny(estimate.amount)} CNY, remaining ${formatCny(Math.max(0, remaining))} CNY`,
    );
  }

  authorize(estimate: CostEstimate): BudgetAuthorization {
    return this.reserve(randomUUID(), estimate);
  }

  reserve(reservationId: string, estimate: CostEstimate): BudgetAuthorization {
    if (!reservationId.trim()) throw new Error('budget reservation id is required');
    const existing = this.reservations.get(reservationId);
    if (existing) {
      if (!sameCost(existing.estimate, estimate)) {
        throw new Error('budget reservation id is already bound to a different estimate');
      }
      return existing.authorization;
    }
    this.assertValidEstimate(estimate);
    const reserved = this.reservedCny();
    const remaining = this.options.dryRun
      ? estimate.amount
      : (this.options.limitCny ?? 0) - this.actualSpentCny - reserved;
    if (!this.options.dryRun && estimate.amount > 0 && remaining < estimate.amount) {
      throw new Error(
        `Paid call requires approval: estimated ${formatCny(estimate.amount)} CNY, remaining ${formatCny(Math.max(0, remaining))} CNY`,
      );
    }
    const authorization: BudgetAuthorization = {
      reservationId,
      providerId: estimate.providerId,
      currency: 'CNY',
      maximumAmountCny: estimate.amount,
      remainingAtAuthorizationCny: remaining,
    };
    this.reservations.set(reservationId, { authorization, estimate: { ...estimate } });
    return authorization;
  }

  settleAuthorized(authorization: BudgetAuthorization, actual: CostEstimate): boolean {
    return this.settleReservation(authorization.reservationId, actual).withinAuthorization;
  }

  settleReservation(reservationId: string, actual: CostEstimate): BudgetSettlement {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error('budget reservation was not found');
    if (reservation.settlement) {
      if (!sameCost(reservation.settlement.actual, actual)) {
        throw new Error('reservation was already settled with a different actual cost');
      }
      return reservation.settlement;
    }
    if (!Number.isFinite(actual.amount) || actual.amount < 0 || actual.currency !== 'CNY') {
      throw new Error('Actual cost amount must be a finite, non-negative CNY value');
    }
    if (!actual.providerId.trim() || !actual.basis.trim()) {
      throw new Error('Actual cost provider and audit basis are required');
    }
    if (actual.providerId !== reservation.authorization.providerId
      || actual.currency !== reservation.authorization.currency) {
      throw new Error('actual cost must match the reserved provider and currency');
    }
    this.actualSpentCny += actual.amount;
    const authorization = reservation.authorization;
    const settlement = {
      reservationId,
      actual: { ...actual },
      withinAuthorization: actual.providerId === authorization.providerId
        && actual.currency === authorization.currency
        && actual.amount <= authorization.maximumAmountCny
        && actual.amount <= authorization.remainingAtAuthorizationCny,
    };
    reservation.settlement = settlement;
    return settlement;
  }

  recordActual(cost: CostEstimate): void {
    if (!Number.isFinite(cost.amount) || cost.amount < 0 || cost.currency !== 'CNY') {
      throw new Error('Actual cost amount must be a finite, non-negative CNY value');
    }
    this.actualSpentCny += cost.amount;
  }

  spentCny(): number {
    return this.actualSpentCny;
  }

  /** Replay already validated durable audit; never grant a new authorization. */
  restoreReservation(authorization: BudgetAuthorization, estimate: CostEstimate): void {
    this.assertValidEstimate(estimate);
    if (!authorization.reservationId.trim() || authorization.providerId !== estimate.providerId
      || authorization.currency !== estimate.currency || authorization.maximumAmountCny !== estimate.amount
      || !Number.isFinite(authorization.remainingAtAuthorizationCny) || authorization.remainingAtAuthorizationCny < 0) {
      throw new Error('invalid durable budget authorization');
    }
    if (this.reservations.has(authorization.reservationId)) throw new Error('duplicate durable budget reservation');
    this.reservations.set(authorization.reservationId, { authorization: { ...authorization }, estimate: { ...estimate } });
  }

  reservedCny(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (!reservation.settlement) total += reservation.authorization.maximumAmountCny;
    }
    return total;
  }

  private assertValidEstimate(estimate: CostEstimate): void {
    if (!Number.isFinite(estimate.amount) || estimate.amount < 0) {
      throw new Error('Cost estimate amount must be a finite, non-negative CNY value');
    }
    if (estimate.currency !== 'CNY' || !estimate.providerId.trim() || !estimate.basis.trim()) {
      throw new Error('Cost estimate provider, CNY currency, and audit basis are required');
    }
  }
}

function formatCny(amount: number): string {
  return amount.toFixed(10).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, '');
}

function sameCost(left: CostEstimate, right: CostEstimate): boolean {
  return left.providerId === right.providerId
    && left.currency === right.currency
    && left.amount === right.amount
    && left.basis === right.basis;
}
