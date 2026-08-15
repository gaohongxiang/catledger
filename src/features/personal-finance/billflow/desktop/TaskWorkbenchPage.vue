<template>
    <v-card class="task-workbench overflow-hidden">
        <div class="task-toolbar px-5 py-4">
            <div>
                <div class="text-subtitle-1 font-weight-bold">{{ tt('personalFinance.billflow.title') }}</div>
                <div class="text-body-small text-medium-emphasis">{{ tt('personalFinance.billflow.subtitle') }}</div>
            </div>
            <v-spacer />
            <v-btn color="primary" :prepend-icon="mdiTrayArrowUp" :loading="busy" @click="fileInput?.click()">
                {{ tt('personalFinance.upload') }}
            </v-btn>
            <v-btn variant="tonal" :icon="mdiRefresh" :loading="loading" @click="reload" />
            <input ref="fileInput" type="file" class="d-none" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="upload" />
        </div>

        <v-divider />

        <v-alert class="ma-4" type="error" variant="tonal" v-if="error">{{ tt('personalFinance.billflow.error') }}</v-alert>

        <section class="px-5 py-4" v-if="eligibleFiles.length">
            <div class="text-subtitle-2 mb-2">{{ tt('personalFinance.billflow.files.title') }}</div>
            <v-chip-group column multiple v-model="selectedFileIds">
                <v-chip :value="file.fileId" filter :key="file.fileId" v-for="file in eligibleFiles">
                    {{ file.name }}
                </v-chip>
            </v-chip-group>
            <v-btn class="mt-3" color="primary" variant="flat" :disabled="selectedFileIds.length < 1" :loading="busy" @click="createTask">
                {{ tt('personalFinance.billflow.files.create') }}
            </v-btn>
        </section>

        <div class="empty-state pa-8 text-center" v-else-if="!loading">
            <div class="font-weight-medium">{{ tt('personalFinance.billflow.files.empty') }}</div>
            <div class="text-body-small text-medium-emphasis mt-1">{{ tt('personalFinance.billflow.files.emptyHint') }}</div>
        </div>

        <template v-if="task">
            <v-divider />
            <section class="summary-grid pa-5">
                <div>
                    <span>{{ tt('personalFinance.billflow.summary.created') }}</span>
                    <strong>{{ task.createdAccountCount }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.billflow.summary.reused') }}</span>
                    <strong>{{ task.reusedMappingCount }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.billflow.summary.posted') }}</span>
                    <strong>{{ task.autoPostedCount }}</strong>
                </div>
                <div>
                    <span>{{ tt('personalFinance.billflow.summary.todos') }}</span>
                    <strong>{{ task.todoOpenCount }}</strong>
                </div>
            </section>

            <v-alert class="mx-5 mb-4" type="warning" variant="tonal" v-if="task.status === 'failed'">
                {{ tt('personalFinance.billflow.failed') }}
            </v-alert>

            <section class="px-5 pb-4" v-if="taskNeedsAccounts(task.status, accounts?.needsCreate.length ?? 0)">
                <div class="text-subtitle-2 mb-2">{{ tt('personalFinance.billflow.accounts.title') }}</div>
                <p class="text-body-small text-medium-emphasis">{{ tt('personalFinance.billflow.accounts.reusedHint', { count: accounts?.reused.length ?? 0 }) }}</p>
                <v-list v-if="accounts?.needsCreate.length">
                    <v-list-item :key="group.sampleRowId" v-for="group in accounts.needsCreate">
                        <v-list-item-title>{{ group.displayName }} · {{ group.currency }}</v-list-item-title>
                        <v-list-item-subtitle>{{ tt('personalFinance.billflow.accounts.rows', { count: group.rowCount }) }}</v-list-item-subtitle>
                        <template #append>
                            <v-btn size="small" color="primary" :loading="busy" @click="createAccount(group)">
                                {{ tt('personalFinance.billflow.accounts.create') }}
                            </v-btn>
                        </template>
                    </v-list-item>
                </v-list>
            </section>

            <div class="px-5 pb-4" v-if="task.status === 'accounts_pending' && (accounts?.needsCreate.length ?? 0) < 1">
                <v-btn color="primary" :loading="busy" @click="runTask">{{ tt('personalFinance.billflow.run') }}</v-btn>
            </div>
            <div class="px-5 pb-4" v-else-if="taskAwaitsConfirm(task.status)">
                <v-btn color="primary" :loading="busy" @click="confirmPost">{{ tt('personalFinance.billflow.confirmPost') }}</v-btn>
            </div>

            <section class="px-5 pb-5" v-if="taskShowsTodos(task.status)">
                <div class="text-subtitle-2 mb-2">{{ tt('personalFinance.billflow.todos.title') }}</div>
                <v-list v-if="openTodos.length">
                    <v-list-item :key="todo.id" v-for="todo in openTodos">
                        <v-list-item-title>{{ tt(todoKindKey(todo.todoKind)) }}</v-list-item-title>
                        <v-list-item-subtitle>{{ todo.reasonCodes.join(' · ') }}</v-list-item-subtitle>
                        <template #append>
                            <v-btn size="small" variant="text" :loading="busy" v-if="todo.todoKind === 'installment_candidate'" @click="confirmInstallment(todo)">
                                {{ tt('personalFinance.billflow.todos.installment') }}
                            </v-btn>
                            <v-btn size="small" variant="text" :loading="busy" @click="resolveTodo(todo, 'resolved')">
                                {{ tt('personalFinance.billflow.todos.resolve') }}
                            </v-btn>
                            <v-btn size="small" variant="text" :loading="busy" @click="resolveTodo(todo, 'dismissed')">
                                {{ tt('personalFinance.billflow.todos.dismiss') }}
                            </v-btn>
                        </template>
                    </v-list-item>
                </v-list>
                <p class="text-body-small text-medium-emphasis" v-else>{{ tt('personalFinance.billflow.todos.empty') }}</p>
            </section>

            <section class="px-5 pb-5" v-if="unverifiedCards.length">
                <div class="text-subtitle-2 mb-2">{{ tt('personalFinance.billflow.balance.title') }}</div>
                <p class="text-body-small text-medium-emphasis">{{ tt('personalFinance.billflow.balance.hint') }}</p>
                <v-list>
                    <v-list-item :key="card.ledgerAccountId" v-for="card in unverifiedCards">
                        <v-list-item-title>{{ card.displayName }}</v-list-item-title>
                        <template #append>
                            <v-btn size="small" variant="text" :loading="busy" @click="skipBalance(card)">{{ tt('personalFinance.billflow.balance.skip') }}</v-btn>
                            <v-btn size="small" color="primary" :loading="busy" @click="verifyBalance(card)">{{ tt('personalFinance.billflow.balance.verify') }}</v-btn>
                        </template>
                    </v-list-item>
                </v-list>
            </section>
        </template>
    </v-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { mdiRefresh, mdiTrayArrowUp } from '@mdi/js';

import { useI18n } from '@/locales/helpers.ts';
import { generateRandomUUID } from '@/lib/misc.ts';

import type { BillflowAccountGroup, BillflowAccounts, BillflowTask, BillflowTodo, CardCycleAccount } from '../models.ts';
import { todoKindKey } from '../presentation.ts';
import { billflowApi } from '../service.ts';
import { eligibleOrganizeFileIds, suggestedAccountCategory, taskAwaitsConfirm, taskNeedsAccounts, taskShowsTodos } from '../state.ts';
import { usePersonalFinanceStore } from '../../store.ts';
import { todayCivilDate } from '../../dashboard/state.ts';

const { tt } = useI18n();
const personalFinanceStore = usePersonalFinanceStore();
const fileInput = ref<HTMLInputElement>();
const loading = ref(false);
const busy = ref(false);
const error = ref(false);
const selectedFileIds = ref<string[]>([]);
const task = ref<BillflowTask>();
const accounts = ref<BillflowAccounts>();
const openTodos = ref<readonly BillflowTodo[]>([]);
const cardAccounts = ref<CardCycleAccount[]>([]);

const eligibleFiles = computed(() => {
    const ids = new Set(eligibleOrganizeFileIds(personalFinanceStore.batches));
    return personalFinanceStore.batches
        .filter(batch => ids.has(batch.fileId))
        .filter((batch, index, list) => list.findIndex(item => item.fileId === batch.fileId) === index)
        .map(batch => ({ fileId: batch.fileId, name: batch.file?.originalFileName || batch.fileId }));
});

const unverifiedCards = computed(() => cardAccounts.value.filter(card => !card.balanceReview || card.balanceReview.status === 'unverified'));

async function reload(): Promise<void> {
    loading.value = true;
    error.value = false;
    try {
        await personalFinanceStore.loadBatches(0, 50);
        const [pending, awaiting, ready] = await Promise.all([
            billflowApi.listTasks('accounts_pending'),
            billflowApi.listTasks('awaiting_confirm'),
            billflowApi.listTasks('ready')
        ]);
        const current = pending.items[0] ?? awaiting.items[0] ?? ready.items[0] ?? task.value;
        if (current) {
            await openTask(current.id);
        }
        cardAccounts.value = await billflowApi.listCardAccounts(todayCivilDate());
    } catch {
        error.value = true;
    } finally {
        loading.value = false;
    }
}

async function openTask(taskId: string): Promise<void> {
    task.value = await billflowApi.getTask(taskId);
    accounts.value = await billflowApi.getAccounts(taskId);
    if (taskShowsTodos(task.value.status)) {
        openTodos.value = (await billflowApi.listTodos(taskId, 'open')).items;
    } else {
        openTodos.value = [];
    }
}

async function upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy.value = true;
    try {
        await personalFinanceStore.uploadFile(file);
        await personalFinanceStore.loadBatches(0, 50);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function createTask(): Promise<void> {
    busy.value = true;
    try {
        const created = await billflowApi.createTask(selectedFileIds.value, generateRandomUUID());
        await openTask(created.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function createAccount(group: BillflowAccountGroup): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        accounts.value = await billflowApi.createAccount({
            taskId: task.value.id,
            expectedVersion: task.value.version,
            sampleRowId: group.sampleRowId,
            name: group.displayName,
            category: suggestedAccountCategory(group.suggestedType),
            currency: group.currency,
            idempotencyKey: generateRandomUUID()
        });
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function runTask(): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        await billflowApi.runTask(task.value.id, task.value.version, generateRandomUUID());
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function confirmPost(): Promise<void> {
    if (!task.value) return;
    busy.value = true;
    try {
        await billflowApi.confirmPost(task.value.id, task.value.version, generateRandomUUID());
        await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function resolveTodo(todo: BillflowTodo, status: 'resolved' | 'dismissed'): Promise<void> {
    busy.value = true;
    try {
        await billflowApi.resolveTodo(todo.id, todo.version, status, generateRandomUUID());
        if (task.value) await openTask(task.value.id);
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

async function confirmInstallment(todo: BillflowTodo): Promise<void> {
    busy.value = true;
    try {
        const candidate = await billflowApi.getInstallmentCandidate(todo.subjectId);
        await billflowApi.confirmInstallment({
            candidateId: candidate.id,
            expectedVersion: candidate.version,
            treatAsInstallment: true,
            liabilityAccountId: candidate.liabilityAccountId,
            termCount: candidate.termCount,
            purchaseRelation: candidate.purchaseRelation === 'unresolved' ? 'missing_candidate' : candidate.purchaseRelation,
            linkedPurchaseTransactionId: candidate.linkedPurchaseTransactionId
        });
        await resolveTodo(todo, 'resolved');
    } catch {
        error.value = true;
        busy.value = false;
    }
}

async function skipBalance(card: CardCycleAccount): Promise<void> {
    await saveBalance(card, 'unverified', '');
}

async function verifyBalance(card: CardCycleAccount): Promise<void> {
    await saveBalance(card, 'verified', todayCivilDate());
}

async function saveBalance(card: CardCycleAccount, status: 'unverified' | 'verified', asOfDate: string): Promise<void> {
    busy.value = true;
    try {
        await billflowApi.saveBalanceReview({
            ledgerAccountId: card.ledgerAccountId,
            status,
            asOfDate,
            expectedVersion: card.balanceReview?.version ?? 0,
            idempotencyKey: generateRandomUUID()
        });
        cardAccounts.value = await billflowApi.listCardAccounts(todayCivilDate());
    } catch {
        error.value = true;
    } finally {
        busy.value = false;
    }
}

onMounted(reload);
</script>

<style scoped>
.task-workbench {
    border: 1px solid rgba(var(--v-theme-on-surface), 0.11);
    border-radius: 18px;
    box-shadow: none;
}

.task-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
}

.summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
}

.summary-grid div {
    padding: 16px;
    border: 1px solid rgba(var(--v-theme-on-surface), 0.11);
    border-radius: 12px;
}

.summary-grid span {
    display: block;
    color: rgba(var(--v-theme-on-surface), 0.6);
    font-size: 0.8rem;
}

.summary-grid strong {
    display: block;
    margin-top: 6px;
    font-size: 1.6rem;
}

@media (max-width: 900px) {
    .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
</style>
