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

export class BudgetGuard {
  constructor(private readonly options: BudgetGuardOptions) {}

  assertAllowed(estimate: CostEstimate): void {
    if (this.options.dryRun || estimate.amount === 0) return;

    const remaining = (this.options.limitCny ?? 0) - this.options.spentCny;
    if (remaining >= estimate.amount) return;

    throw new Error(
      `Paid call requires approval: estimated ${formatCny(estimate.amount)} CNY, remaining ${formatCny(Math.max(0, remaining))} CNY`,
    );
  }
}

function formatCny(amount: number): string {
  return amount.toFixed(10).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, '');
}
