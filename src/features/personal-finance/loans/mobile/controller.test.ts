import { describe, expect, it, vi } from 'vitest';

import type { LoanService } from '../service.ts';
import { createMobileLoanController } from './controller.ts';

describe('mobile loan controller', () => {
    it('uses only list and get and exposes no write operations', async () => {
        const service: Pick<LoanService, 'listContracts' | 'getContract'> = {
            listContracts: vi.fn().mockResolvedValue({ items: [] }),
            getContract: vi.fn().mockRejectedValue(new Error('not-found'))
        };
        const controller = createMobileLoanController(service);

        await controller.load();

        expect(service.listContracts).toHaveBeenCalledWith({ status: 'active', limit: 100 });
        expect('calculate' in controller).toBe(false);
        expect('createContract' in controller).toBe(false);
        expect('applySettlement' in controller).toBe(false);
        expect('undoSettlement' in controller).toBe(false);
    });
});
