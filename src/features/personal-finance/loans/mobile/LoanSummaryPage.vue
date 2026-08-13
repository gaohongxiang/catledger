<template>
    <loan-summary-page-shell
        :items="controller.items.value"
        :detail="controller.detail.value"
        :loading="controller.loading.value"
        :has-more="!!controller.nextCursor.value"
        @refresh="refresh"
        @load-more="loadMore"
        @select="open"
        @close-detail="controller.close"
    />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { f7 } from 'framework7-vue';

import { useI18n } from '@/locales/helpers.ts';

import { createMobileLoanController } from './controller.ts';
import LoanSummaryPageShell from './LoanSummaryPageShell.vue';
import { loanApi } from '../service.ts';

const { tt } = useI18n();
const controller = createMobileLoanController(loanApi);

async function load(): Promise<void> {
    try {
        await controller.load();
    } catch {
        f7.toast.create({ text: tt('personalFinance.loans.error.operationFailed'), closeTimeout: 3000 }).open();
    }
}

async function refresh(done?: () => void): Promise<void> {
    try {
        await load();
    } finally {
        done?.();
    }
}

async function loadMore(): Promise<void> {
    try {
        await controller.load(true);
    } catch {
        f7.toast.create({ text: tt('personalFinance.loans.error.operationFailed'), closeTimeout: 3000 }).open();
    }
}

async function open(contractId: string): Promise<void> {
    try {
        await controller.open(contractId);
    } catch {
        f7.toast.create({ text: tt('personalFinance.loans.error.operationFailed'), closeTimeout: 3000 }).open();
    }
}

onMounted(load);
onBeforeUnmount(controller.dispose);
</script>
