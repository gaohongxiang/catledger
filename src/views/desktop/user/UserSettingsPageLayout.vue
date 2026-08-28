<template>
    <main-page-layout>
        <template #nav-items>
            <li class="nav-section-title">
                <div class="title-wrapper">
                    <span class="title-text">{{ tt('Settings') }}</span>
                </div>
            </li>
            <li class="nav-link">
                <router-link to="/user/settings/basic">
                    <v-icon class="nav-item-icon" :icon="mdiAccountOutline"/>
                    <span class="nav-item-title">{{ tt('User Profile') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/app/settings/basic">
                    <v-icon class="nav-item-icon" :icon="mdiTuneVariant"/>
                    <span class="nav-item-title">{{ tt('Preferences') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/user/settings/security">
                    <v-icon class="nav-item-icon" :icon="mdiLockOpenOutline"/>
                    <span class="nav-item-title">{{ tt('Security') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/user/settings/two_factor">
                    <v-icon class="nav-item-icon" :icon="mdiOnepassword"/>
                    <span class="nav-item-title">{{ tt('Two-Factor Authentication') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/user/settings/data_management">
                    <v-icon class="nav-item-icon" :icon="mdiDatabaseCogOutline"/>
                    <span class="nav-item-title">{{ tt('Data & Privacy') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/app/settings/application_lock">
                    <v-icon class="nav-item-icon" :icon="mdiCellphoneLock"/>
                    <span class="nav-item-title">{{ tt('Application Lock') }}</span>
                </router-link>
            </li>
            <li class="nav-link" v-if="showExchangeRates">
                <router-link to="/exchange_rate">
                    <v-icon class="nav-item-icon" :icon="mdiSwapHorizontal"/>
                    <span class="nav-item-title">{{ tt('Exchange Rates Data') }}</span>
                </router-link>
            </li>
        </template>

        <template #content>
            <router-view :key="currentRoutePath" />
        </template>
    </main-page-layout>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';

import { useI18n } from '@/locales/helpers.ts';
import { useAccountsStore } from '@/stores/account.ts';
import { useUserStore } from '@/stores/user.ts';

import {
    mdiAccountOutline,
    mdiLockOpenOutline,
    mdiOnepassword,
    mdiDatabaseCogOutline,
    mdiCellphoneLock,
    mdiSwapHorizontal,
    mdiTuneVariant
} from '@mdi/js';

const route = useRoute();

const { tt } = useI18n();
const accountsStore = useAccountsStore();
const userStore = useUserStore();

const currentRoutePath = computed<string>(() => route.path);
const showExchangeRates = computed<boolean>(() => accountsStore.allPlainAccounts.some(account =>
    account.currency !== userStore.currentUserDefaultCurrency
));

onMounted(() => {
    accountsStore.loadAllAccounts({ force: false }).catch(() => undefined);
});
</script>
