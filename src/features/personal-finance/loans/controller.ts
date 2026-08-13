import { ref } from 'vue';

import type {
    LoanActionResult,
    LoanCalculationInput,
    LoanCalculationResult,
    LoanCloseReason,
    LoanComponentType,
    LoanContractDetail,
    LoanContractIdentityInput,
    LoanContractStatus,
    LoanContractSummary,
    LoanLedgerDraft,
    LoanSettlementCandidate,
    LoanSettlementCandidatesResult,
    LoanSettlementComponent,
    LoanSettlementUndoImpact
} from './models.ts';
import type { LoanService } from './service.ts';
import {
    buildLoanSettlementApplyRequest,
    buildLoanSettlementUndoRequest,
    createDefaultLoanCalculationInput,
    validateLoanCalculationInput
} from './state.ts';

export type LoanControllerError = 'operation_failed' | 'validation_failed';

interface IntentState {
    readonly fingerprint: string;
    readonly key: string;
}

export interface LoanWorkbenchControllerOptions {
    readonly service: LoanService;
    readonly createIdempotencyKey?: () => string;
    readonly pageLimit?: number;
}

function defaultIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `loan-${crypto.randomUUID()}`;
    }
    return `loan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createLoanWorkbenchController(options: LoanWorkbenchControllerOptions) {
    const service = options.service;
    const createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
    const pageLimit = options.pageLimit ?? 50;

    const status = ref<LoanContractStatus>('active');
    const items = ref<LoanContractSummary[]>([]);
    const nextCursor = ref<{ updatedUnixTime: number; contractId: string }>();
    const selectedDetail = ref<LoanContractDetail | null>(null);
    const selectedInstallmentId = ref<string>();
    const calculationInput = ref<LoanCalculationInput>(createDefaultLoanCalculationInput());
    const calculationResult = ref<LoanCalculationResult>();
    const candidates = ref<LoanSettlementCandidatesResult | null>(null);
    const components = ref<LoanSettlementComponent[]>([]);
    const undoImpact = ref<LoanSettlementUndoImpact | null>(null);
    const lastSettlementActionId = ref<string>();
    const loadingList = ref(false);
    const loadingDetail = ref(false);
    const calculating = ref(false);
    const submitting = ref(false);
    const loadingComponent = ref<LoanComponentType>();
    const error = ref<LoanControllerError>();

    const intents = new Map<string, IntentState>();
    let alive = true;
    let listEpoch = 0;
    let detailEpoch = 0;

    function intentKey(slot: string, fingerprint: unknown): string {
        const serialized = JSON.stringify(fingerprint);
        const current = intents.get(slot);
        if (current?.fingerprint === serialized) {
            return current.key;
        }
        const state = { fingerprint: serialized, key: createIdempotencyKey() };
        intents.set(slot, state);
        return state.key;
    }

    function completeIntent(slot: string): void {
        intents.delete(slot);
    }

    function setFailure(value: unknown): void {
        error.value = value instanceof Error && value.constructor.name === 'LoanValidationError'
            ? 'validation_failed'
            : 'operation_failed';
    }

    async function loadContracts(append = false): Promise<void> {
        const epoch = ++listEpoch;
        loadingList.value = true;
        error.value = undefined;
        try {
            const page = await service.listContracts({
                status: status.value,
                limit: pageLimit,
                ...(append && nextCursor.value ? { cursor: nextCursor.value } : {})
            });
            if (!alive || epoch !== listEpoch) {
                return;
            }
            items.value = append ? [...items.value, ...page.items] : page.items;
            nextCursor.value = page.nextCursor
                ? { updatedUnixTime: page.nextCursor.updatedUnixTime, contractId: page.nextCursor.contractId }
                : undefined;
        } catch (cause) {
            if (alive && epoch === listEpoch) {
                setFailure(cause);
            }
            throw cause;
        } finally {
            if (alive && epoch === listEpoch) {
                loadingList.value = false;
            }
        }
    }

    async function openContract(contractId: string): Promise<void> {
        const epoch = ++detailEpoch;
        const previousContractId = selectedDetail.value?.contract.id;
        loadingDetail.value = true;
        error.value = undefined;
        try {
            const detail = await service.getContract(contractId);
            if (!alive || epoch !== detailEpoch) {
                return;
            }
            selectedDetail.value = detail;
            const selectionInvalid = typeof selectedInstallmentId.value !== 'undefined' &&
                !detail.installments.some(item => item.id === selectedInstallmentId.value);
            if (previousContractId !== detail.contract.id || selectionInvalid) {
                selectedInstallmentId.value = undefined;
                clearSettlementComposer();
            }
            lastSettlementActionId.value = detail.latestSettlementActionId;
            if (!detail.latestSettlementActionId) {
                undoImpact.value = null;
            }
        } catch (cause) {
            if (alive && epoch === detailEpoch) {
                setFailure(cause);
            }
            throw cause;
        } finally {
            if (alive && epoch === detailEpoch) {
                loadingDetail.value = false;
            }
        }
    }

    async function reload(openFirst = false): Promise<void> {
        await loadContracts(false);
        const selectedId = selectedDetail.value?.contract.id;
        if (selectedId) {
            await openContract(selectedId);
        } else if (openFirst && items.value[0]) {
            await openContract(items.value[0].contract.id);
        }
    }

    async function changeStatus(value: LoanContractStatus): Promise<void> {
        status.value = value;
        selectedDetail.value = null;
        selectedInstallmentId.value = undefined;
        clearSettlementComposer();
        await reload(true);
    }

    async function calculate(input: LoanCalculationInput = calculationInput.value): Promise<LoanCalculationResult> {
        calculating.value = true;
        error.value = undefined;
        try {
            const validated = validateLoanCalculationInput(input);
            const result = await service.calculate(validated);
            if (alive) {
                calculationInput.value = { ...validated };
                calculationResult.value = result;
            }
            return result;
        } catch (cause) {
            if (alive) {
                setFailure(cause);
            }
            throw cause;
        } finally {
            if (alive) {
                calculating.value = false;
            }
        }
    }

    async function refreshAfterAction(contractId?: string, selectFallback = false): Promise<void> {
        await loadContracts(false);
        const targetId = contractId ?? (selectFallback ? items.value[0]?.contract.id : undefined);
        if (targetId) {
            await openContract(targetId);
        }
    }

    async function runAction(
        slot: string,
        fingerprint: unknown,
        command: (key: string) => Promise<LoanActionResult>,
        contractId?: string,
        selectFallback = false
    ): Promise<LoanActionResult> {
        if (submitting.value) {
            throw new Error('loan_action_in_progress');
        }
        submitting.value = true;
        error.value = undefined;
        const key = intentKey(slot, fingerprint);
        try {
            const result = await command(key);
            completeIntent(slot);
            if (alive) {
                await refreshAfterAction(result.contract?.contract.id ?? contractId, selectFallback);
            }
            return result;
        } catch (cause) {
            if (alive) {
                setFailure(cause);
            }
            throw cause;
        } finally {
            if (alive) {
                submitting.value = false;
            }
        }
    }

    async function createContract(identity: LoanContractIdentityInput): Promise<LoanActionResult> {
        const input = validateLoanCalculationInput(calculationInput.value);
        const fingerprint = { identity, input };
        return runAction('create', fingerprint, key => service.createContract({
            contract: { ...identity },
            calculation: { ...input },
            idempotencyKey: key
        }), undefined, true);
    }

    async function reviseContract(input: LoanCalculationInput = calculationInput.value): Promise<LoanActionResult> {
        const detail = selectedDetail.value;
        if (!detail) {
            throw new Error('loan_contract_not_selected');
        }
        const validated = validateLoanCalculationInput(input);
        const fingerprint = { contractId: detail.contract.id, version: detail.contract.version, input: validated };
        return runAction(`revise:${detail.contract.id}`, fingerprint, key => service.reviseContract({
            contractId: detail.contract.id,
            expectedContractVersion: detail.contract.version,
            calculation: { ...validated },
            idempotencyKey: key
        }), detail.contract.id);
    }

    async function closeContract(closeReason: LoanCloseReason): Promise<LoanActionResult> {
        const detail = requireDetail();
        const fingerprint = { contractId: detail.contract.id, version: detail.contract.version, closeReason };
        return runAction(`close:${detail.contract.id}`, fingerprint, key => service.closeContract({
            contractId: detail.contract.id,
            expectedContractVersion: detail.contract.version,
            closeReason,
            idempotencyKey: key
        }), detail.contract.id);
    }

    async function reopenContract(): Promise<LoanActionResult> {
        const detail = requireDetail();
        const fingerprint = { contractId: detail.contract.id, version: detail.contract.version };
        return runAction(`reopen:${detail.contract.id}`, fingerprint, key => service.reopenContract({
            contractId: detail.contract.id,
            expectedContractVersion: detail.contract.version,
            idempotencyKey: key
        }), detail.contract.id);
    }

    async function cancelContract(): Promise<LoanActionResult> {
        const detail = requireDetail();
        const fingerprint = { contractId: detail.contract.id, version: detail.contract.version };
        return runAction(`cancel:${detail.contract.id}`, fingerprint, key => service.cancelContract({
            contractId: detail.contract.id,
            expectedContractVersion: detail.contract.version,
            idempotencyKey: key
        }), detail.contract.id);
    }

    function selectInstallment(installmentId?: string): void {
        if (selectedInstallmentId.value === installmentId) {
            return;
        }
        selectedInstallmentId.value = installmentId;
        clearSettlementComposer();
    }

    async function loadSettlementCandidates(componentType: LoanComponentType): Promise<LoanSettlementCandidatesResult> {
        const detail = requireDetail();
        const installmentId = selectedInstallmentId.value;
        if (!installmentId && componentType === 'disbursement' && detail.currentRevision.input.fundingType !== 'cash_disbursement') {
            throw new Error('loan_disbursement_not_allowed');
        }
        loadingComponent.value = componentType;
        error.value = undefined;
        try {
            const result = await service.listSettlementCandidates({
                contractId: detail.contract.id,
                componentType,
                ...(installmentId ? { installmentId } : {})
            });
            if (alive) {
                const sameContext = candidates.value?.contractId === result.contractId &&
                    candidates.value?.installmentId === result.installmentId;
                const otherGroups = sameContext
                    ? candidates.value!.groups.filter(group => !result.groups.some(next => next.componentType === group.componentType))
                    : [];
                candidates.value = { ...result, groups: [...otherGroups, ...result.groups] };
            }
            return result;
        } catch (cause) {
            if (alive) {
                setFailure(cause);
            }
            throw cause;
        } finally {
            if (alive) {
                loadingComponent.value = undefined;
            }
        }
    }

    function selectCandidate(componentType: LoanComponentType, candidate: LoanSettlementCandidate): void {
        if (!selectedInstallmentId.value && componentType === 'disbursement' &&
            requireDetail().currentRevision.input.fundingType !== 'cash_disbursement') {
            throw new Error('loan_disbursement_not_allowed');
        }
        if (!candidate.eligible) {
            throw new Error('loan_candidate_ineligible');
        }
        const outstanding = candidates.value?.groups.find(group => group.componentType === componentType)?.outstandingAmount;
        if (!Number.isSafeInteger(candidate.amount) || candidate.amount < 1 || typeof outstanding !== 'number' || candidate.amount > outstanding) {
            throw new Error('loan_allocation_amount_invalid');
        }
        replaceComponent({
            componentType,
            allocatedAmount: candidate.amount,
            existingTransactionId: candidate.transactionId,
            expectedUpdatedUnixTime: candidate.updatedUnixTime,
            ...(typeof candidate.counterpartUpdatedUnixTime === 'undefined'
                ? {}
                : { expectedCounterpartUpdatedUnixTime: candidate.counterpartUpdatedUnixTime })
        });
    }

    function setLedgerDraft(componentType: LoanComponentType, allocatedAmount: number, ledgerDraft: LoanLedgerDraft): void {
        if (!selectedInstallmentId.value && componentType === 'disbursement' &&
            requireDetail().currentRevision.input.fundingType !== 'cash_disbursement') {
            throw new Error('loan_disbursement_not_allowed');
        }
        replaceComponent({ componentType, allocatedAmount, ledgerDraft: { ...ledgerDraft } });
    }

    function replaceComponent(component: LoanSettlementComponent): void {
        components.value = [
            ...components.value.filter(item => item.componentType !== component.componentType),
            component
        ];
        undoImpact.value = null;
    }

    async function applySettlement(): Promise<LoanActionResult> {
        const detail = requireDetail();
        const requestWithoutKey = {
            contractId: detail.contract.id,
            contractVersion: detail.contract.version,
            installmentId: selectedInstallmentId.value,
            components: components.value
        };
        const slot = `apply:${detail.contract.id}:${selectedInstallmentId.value ?? 'disbursement'}`;
        return runAction(slot, requestWithoutKey, async key => {
            const request = buildLoanSettlementApplyRequest({
                ...requestWithoutKey,
                idempotencyKey: key
            });
            const result = await service.applySettlement(request);
            if (alive) {
                lastSettlementActionId.value = result.actionId;
                clearSettlementComposer(true);
            }
            return result;
        }, detail.contract.id);
    }

    async function inspectUndo(actionId = lastSettlementActionId.value): Promise<LoanSettlementUndoImpact> {
        const detail = requireDetail();
        if (!actionId) {
            throw new Error('loan_action_not_selected');
        }
        const result = await service.getSettlementUndoImpact({ contractId: detail.contract.id, actionId });
        if (alive) {
            undoImpact.value = result;
        }
        return result;
    }

    async function undoSettlement(actionId = undoImpact.value?.actionId): Promise<LoanActionResult> {
        const detail = requireDetail();
        if (!actionId) {
            throw new Error('loan_action_not_selected');
        }
        const fingerprint = { contractId: detail.contract.id, version: detail.contract.version, actionId };
        return runAction(`undo:${actionId}`, fingerprint, async key => {
            const request = buildLoanSettlementUndoRequest({
                contractId: detail.contract.id,
                contractVersion: detail.contract.version,
                actionId,
                idempotencyKey: key
            });
            const result = await service.undoSettlement(request);
            if (alive) {
                undoImpact.value = null;
                lastSettlementActionId.value = undefined;
            }
            return result;
        }, detail.contract.id);
    }

    function requireDetail(): LoanContractDetail {
        if (!selectedDetail.value) {
            throw new Error('loan_contract_not_selected');
        }
        return selectedDetail.value;
    }

    function clearSettlementComposer(keepLastAction = false): void {
        candidates.value = null;
        components.value = [];
        undoImpact.value = null;
        if (!keepLastAction) {
            lastSettlementActionId.value = undefined;
        }
    }

    function dispose(): void {
        alive = false;
        listEpoch++;
        detailEpoch++;
        intents.clear();
        items.value = [];
        selectedDetail.value = null;
        clearSettlementComposer();
    }

    return {
        status,
        items,
        nextCursor,
        selectedDetail,
        selectedInstallmentId,
        calculationInput,
        calculationResult,
        candidates,
        components,
        undoImpact,
        lastSettlementActionId,
        loadingList,
        loadingDetail,
        calculating,
        submitting,
        loadingComponent,
        error,
        loadContracts,
        openContract,
        reload,
        changeStatus,
        calculate,
        createContract,
        reviseContract,
        closeContract,
        reopenContract,
        cancelContract,
        selectInstallment,
        loadSettlementCandidates,
        selectCandidate,
        setLedgerDraft,
        applySettlement,
        inspectUndo,
        undoSettlement,
        clearSettlementComposer,
        dispose
    };
}
