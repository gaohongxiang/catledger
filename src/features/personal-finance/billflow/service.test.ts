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
                    items: [{
                        id: 'a'.repeat(64),
                        status: 'independent',
                        relationType: 'independent',
                        primaryCaseId: '7001',
                        caseIds: ['7001'],
                        candidateRuleVersion: 'reconciliation-candidate-v2',
                        reasonCodes: ['amount_currency_exact'],
                        rows: [
                            { rowId: '801', sourceType: 'alipay', account: 'card', label: 'merchant', amount: '123', currency: 'CNY', direction: 'expense', inTask: true },
                            { rowId: '802', sourceType: 'bank', account: 'card', label: 'merchant', amount: '123', currency: 'CNY', direction: 'expense', inTask: false }
                        ]
                    }]
                }
            }
        });

        const groups = await billflowApi.listMergeGroups('9001');
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            status: 'independent',
            relationType: 'independent',
            primaryCaseId: '7001',
            candidateRuleVersion: 'reconciliation-candidate-v2'
        });
        expect(groups[0]?.rows.map(row => [row.rowId, row.inTask])).toEqual([['801', true], ['802', false]]);
    });
});
