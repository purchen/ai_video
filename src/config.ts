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
  providerId: string;
  currency: 'CNY';
  maximumAmountCny: number;
  remainingAtAuthorizationCny: number;
}

export class BudgetGuard {
  private actualSpentCny: number;

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
    this.assertAllowed(estimate);
    return {
      providerId: estimate.providerId,
      currency: 'CNY',
      maximumAmountCny: estimate.amount,
      remainingAtAuthorizationCny: Math.max(0, (this.options.limitCny ?? 0) - this.actualSpentCny),
    };
  }

  settleAuthorized(authorization: BudgetAuthorization, actual: CostEstimate): boolean {
    this.actualSpentCny += actual.amount;
    return actual.providerId === authorization.providerId
      && actual.currency === authorization.currency
      && actual.amount <= authorization.maximumAmountCny
      && actual.amount <= authorization.remainingAtAuthorizationCny;
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
}

function formatCny(amount: number): string {
  return amount.toFixed(10).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, '');
}
