<template>
    <f7-page ptr @ptr:refresh="pullRefresh">
        <f7-navbar :title="tt('personalFinance.billflow.mobile.title')" :back-link="tt('Back')" />
        <f7-block strong inset class="margin-vertical-half">
            <p>{{ tt('personalFinance.billflow.mobile.readOnly') }}</p>
        </f7-block>
        <f7-block class="text-align-center" v-if="loading && !task"><f7-preloader /></f7-block>
        <f7-block strong inset v-else-if="error">{{ tt('personalFinance.billflow.error') }}</f7-block>
        <template v-else-if="task">
            <f7-list strong inset dividers>
                <f7-list-item :title="tt('personalFinance.billflow.summary.created')" :after="String(task.createdAccountCount)" />
                <f7-list-item :title="tt('personalFinance.billflow.summary.reused')" :after="String(task.reusedMappingCount)" />
                <f7-list-item :title="tt('personalFinance.billflow.summary.posted')" :after="String(task.autoPostedCount)" />
                <f7-list-item :title="tt('personalFinance.billflow.summary.todos')" :after="String(task.todoOpenCount)" />
            </f7-list>
            <f7-block-title>{{ tt('personalFinance.billflow.todos.title') }}</f7-block-title>
            <f7-list strong inset dividers v-if="openTodos.length">
                <f7-list-item :key="todo.id" :title="tt(todoKindKey(todo.todoKind))" v-for="todo in openTodos" />
            </f7-list>
            <f7-block strong inset v-else>{{ tt('personalFinance.billflow.todos.empty') }}</f7-block>
        </template>
        <f7-block strong inset v-else>{{ tt('personalFinance.billflow.mobile.empty') }}</f7-block>
        <f7-block>
            <f7-button outline :href="'/personal-finance/imports'">{{ tt('personalFinance.billflow.mobile.legacy') }}</f7-button>
        </f7-block>
    </f7-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useI18n } from '@/locales/helpers.ts';

import type { BillflowTask, BillflowTodo } from '../models.ts';
import { todoKindKey } from '../presentation.ts';
import { billflowApi } from '../service.ts';

const { tt } = useI18n();
const loading = ref(false);
const error = ref(false);
const task = ref<BillflowTask>();
const openTodos = ref<readonly BillflowTodo[]>([]);

async function load(): Promise<void> {
    loading.value = true;
    error.value = false;
    try {
        const [pending, awaiting, ready] = await Promise.all([
            billflowApi.listTasks('accounts_pending'),
            billflowApi.listTasks('awaiting_confirm'),
            billflowApi.listTasks('ready')
        ]);
        const current = pending.items[0] ?? awaiting.items[0] ?? ready.items[0];
        task.value = current;
        openTodos.value = current ? (await billflowApi.listTodos(current.id, 'open')).items : [];
    } catch {
        error.value = true;
    } finally {
        loading.value = false;
    }
}

async function pullRefresh(done: () => void): Promise<void> {
    try {
        await load();
    } finally {
        done();
    }
}

onMounted(load);
</script>
