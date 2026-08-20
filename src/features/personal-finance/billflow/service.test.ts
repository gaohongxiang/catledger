import { describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    listPersonalFinanceBillflowMergeGroups: vi.fn()
}));

vi.mock('@/lib/services.ts', () => ({ default: serviceMocks }));

import { billflowApi } from './service.ts';

describe('billflow merge-group response protocol', () => {
    it('keeps task groups, exact case ids and relation status separate', async () => {
        serviceMocks.listPersonalFinanceBillflowMergeGroups.mockResolvedValue({
            data: {
                success: true,
                result: {
                    evidenceRowCount: 198,
                    consolidatedRowCount: 49,
                    plannedTransactionCount: 149,
                    mergeReviewCount: 0,
                    categoryReviewCount: 12,
                    otherReviewCount: 3,
                    items: [{
                        id: 'a'.repeat(64),
                        status: 'independent',
                        relationType: 'independent',
                        primaryCaseId: '7001',
                        caseIds: ['7001'],
                        candidateRuleVersion: 'reconciliation-candidate-v3',
                        reasonCodes: ['amount_currency_exact'],
                        rows: [
                            { rowId: '801', sourceType: 'alipay', account: 'card', label: 'merchant', amount: '123', currency: 'CNY', direction: 'expense', inTask: true },
                            { rowId: '802', sourceType: 'bank', account: 'card', label: 'merchant', amount: '123', currency: 'CNY', direction: 'expense', inTask: false }
                        ]
                    }]
                }
            }
        });

        const plan = await billflowApi.listMergeGroups('9001');
        expect(plan).toMatchObject({ evidenceRowCount: 198, consolidatedRowCount: 49, plannedTransactionCount: 149 });
        expect(plan.items).toHaveLength(1);
        expect(plan.items[0]).toMatchObject({
            status: 'independent',
            relationType: 'independent',
            primaryCaseId: '7001',
            candidateRuleVersion: 'reconciliation-candidate-v3'
        });
        expect(plan.items[0]?.rows.map(row => [row.rowId, row.inTask])).toEqual([['801', true], ['802', false]]);
    });
});
