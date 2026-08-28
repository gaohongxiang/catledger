<template>
    <main-page-layout>
        <template #nav-items>
            <li class="nav-section-title">
                <div class="title-wrapper">
                    <span class="title-text">{{ tt('Application Settings') }}</span>
                </div>
            </li>
            <li class="nav-link">
                <router-link to="/app/settings/basic">
                    <v-icon class="nav-item-icon" :icon="mdiCogOutline"/>
                    <span class="nav-item-title">{{ tt('Basic Settings') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
                <router-link to="/app/settings/application_lock">
                    <v-icon class="nav-item-icon" :icon="mdiLockOpenOutline"/>
                    <span class="nav-item-title">{{ tt('Application Lock') }}</span>
                </router-link>
            </li>
            <li class="nav-link">
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
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { useI18n } from '@/locales/helpers.ts';

import {
    mdiCogOutline,
    mdiLockOpenOutline,
    mdiSwapHorizontal
} from '@mdi/js';

const route = useRoute();

const { tt } = useI18n();

const currentRoutePath = computed<string>(() => route.path);
</script>
