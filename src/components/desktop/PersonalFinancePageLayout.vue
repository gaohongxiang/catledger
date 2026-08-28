<template>
    <main-page-layout :no-navbar="isFullWidthPage">
        <template #nav-items>
            <li class="nav-section-title" v-if="isLoanPage">
                <div class="title-wrapper">
                    <span class="title-text">{{ tt('Accounts') }}</span>
                </div>
            </li>
            <li class="nav-link" v-if="isLoanPage">
                <router-link to="/account/list">
                    <v-icon class="nav-item-icon" :icon="mdiCreditCardOutline" />
                    <span class="nav-item-title">{{ tt('Account List') }}</span>
                </router-link>
            </li>
            <li class="nav-link" v-if="isLoanPage">
                <router-link to="/personal-finance/loans">
                    <v-icon class="nav-item-icon" :icon="mdiBankOutline" />
                    <span class="nav-item-title">{{ tt('personalFinance.loans.nav') }}</span>
                </router-link>
            </li>

        </template>

        <template #content>
            <router-view :key="currentRoutePath" />
        </template>
    </main-page-layout>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { useI18n } from '@/locales/helpers.ts';

import {
    mdiBankOutline,
    mdiCreditCardOutline
} from '@mdi/js';

const route = useRoute();
const { tt } = useI18n();

const currentRoutePath = computed<string>(() => route.path);
const isLoanPage = computed<boolean>(() => route.path === '/personal-finance/loans');
const isFullWidthPage = computed<boolean>(() => !isLoanPage.value);
</script>
