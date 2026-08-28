<template>
    <v-row>
        <v-col cols="12">
            <v-card :title="tt('Basic Settings')">
                <v-card-text>
                    <v-row>
                        <v-col cols="12" md="6">
                            <v-select item-title="name" item-value="value" persistent-placeholder
                                      :label="tt('Theme')" :items="allThemes" v-model="currentTheme" />
                        </v-col>
                        <v-col cols="12" md="6">
                            <v-select item-title="displayName" item-value="value" persistent-placeholder
                                      :label="tt('Show Account Balance')" :items="enableDisableOptions"
                                      v-model="showAccountBalance" />
                        </v-col>
                    </v-row>
                </v-card-text>
            </v-card>
        </v-col>

        <v-col cols="12">
            <v-card :title="tt('AI Clipboard Text Recognition')">
                <v-card-text>
                    <v-select item-title="displayName" item-value="value" persistent-placeholder
                              :label="tt('Always Require Confirmation of Clipboard Content Before Submission')"
                              :items="enableDisableOptions"
                              v-model="isAlwaysRequireConfirmationOfClipboardContentBeforeSubmission" />
                </v-card-text>
            </v-card>
        </v-col>

        <v-col cols="12">
            <v-card :title="tt('AI Image Recognition')">
                <v-card-text>
                    <v-select item-title="displayName" item-value="value" persistent-placeholder
                              :label="tt('Auto Upload AI Recognition Image as Transaction Picture')"
                              :items="enableDisableOptions"
                              v-model="isAutoUploadTransactionPictureForAIRecognition" />
                </v-card-text>
            </v-card>
        </v-col>
    </v-row>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from 'vuetify';

import { useI18n } from '@/locales/helpers.ts';
import { useAppSettingPageBase } from '@/views/base/settings/AppSettingsPageBase.ts';
import { useSettingsStore } from '@/stores/setting.ts';

import type { LocalizedSwitchOption } from '@/core/base.ts';
import { ThemeType } from '@/core/theme.ts';
import { getSystemTheme } from '@/lib/ui/common.ts';

const theme = useTheme();
const { tt, getAllEnableDisableOptions } = useI18n();
const {
    allThemes,
    showAccountBalance,
    isAlwaysRequireConfirmationOfClipboardContentBeforeSubmission,
    isAutoUploadTransactionPictureForAIRecognition
} = useAppSettingPageBase();
const settingsStore = useSettingsStore();

const enableDisableOptions = computed<LocalizedSwitchOption[]>(() => getAllEnableDisableOptions());

const currentTheme = computed<string>({
    get: () => settingsStore.appSettings.theme,
    set: (value: string) => {
        if (value === settingsStore.appSettings.theme) {
            return;
        }

        settingsStore.setTheme(value);
        theme.change(value === ThemeType.Light || value === ThemeType.Dark ? value : getSystemTheme());
    }
});
</script>
