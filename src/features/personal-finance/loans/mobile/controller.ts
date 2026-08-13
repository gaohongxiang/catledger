import { ref } from 'vue';

import type { LoanContractDetail, LoanContractSummary } from '../models.ts';
import type { LoanService } from '../service.ts';

export function createMobileLoanController(service: Pick<LoanService, 'listContracts' | 'getContract'>) {
    const items = ref<LoanContractSummary[]>([]);
    const detail = ref<LoanContractDetail | null>(null);
    const nextCursor = ref<{ updatedUnixTime: number; contractId: string }>();
    const loading = ref(false);
    const error = ref(false);
    let alive = true;
    let epoch = 0;

    async function load(append = false): Promise<void> {
        const currentEpoch = ++epoch;
        loading.value = true;
        error.value = false;
        try {
            const result = await service.listContracts({
                status: 'active',
                limit: 100,
                ...(append && nextCursor.value ? { cursor: nextCursor.value } : {})
            });
            if (alive && currentEpoch === epoch) {
                items.value = append ? [...items.value, ...result.items] : result.items;
                nextCursor.value = result.nextCursor
                    ? { updatedUnixTime: result.nextCursor.updatedUnixTime, contractId: result.nextCursor.contractId }
                    : undefined;
            }
        } catch (cause) {
            if (alive && currentEpoch === epoch) {
                error.value = true;
            }
            throw cause;
        } finally {
            if (alive && currentEpoch === epoch) {
                loading.value = false;
            }
        }
    }

    async function open(contractId: string): Promise<void> {
        const currentEpoch = ++epoch;
        loading.value = true;
        error.value = false;
        try {
            const result = await service.getContract(contractId);
            if (alive && currentEpoch === epoch) {
                detail.value = result;
            }
        } catch (cause) {
            if (alive && currentEpoch === epoch) {
                error.value = true;
            }
            throw cause;
        } finally {
            if (alive && currentEpoch === epoch) {
                loading.value = false;
            }
        }
    }

    function close(): void {
        detail.value = null;
    }

    function dispose(): void {
        alive = false;
        epoch++;
        items.value = [];
        nextCursor.value = undefined;
        detail.value = null;
    }

    return { items, detail, nextCursor, loading, error, load, open, close, dispose };
}
