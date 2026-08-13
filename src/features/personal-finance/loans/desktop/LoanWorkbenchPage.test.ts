import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('loan desktop workbench wiring', () => {
    it('passes cursor availability through the list hasMore prop', () => {
        const source = readFileSync(new URL('./LoanWorkbenchPage.vue', import.meta.url), 'utf8');
        expect(source).toContain(':has-more="!!nextCursor"');
        expect(source).not.toContain(':next-cursor="nextCursor"');
    });

    it('renders all required cost facts and every calculated installment', () => {
        const source = readFileSync(new URL('./components/LoanCalculationResultPanel.vue', import.meta.url), 'utf8');
        for (const key of [
            'actualDisbursement', 'principal', 'totalPayment', 'totalInterest', 'totalFees', 'effectiveApr', 'costRatio',
            'dueDate', 'principalPayment', 'interest', 'fee', 'payment', 'remainingPrincipal'
        ]) {
            expect(source).toContain(`personalFinance.loans.result.${key}`);
        }
        expect(source).toContain('v-for="installment in result.installments"');
    });
});
