<template>
    <f7-page>
        <f7-navbar :title="tt('AI Image Recognition')" :back-link="tt('Back')"></f7-navbar>

        <f7-block-title class="margin-top">{{ tt('AI Clipboard Text Recognition') }}</f7-block-title>
        <f7-list strong inset dividers class="settings-list">
            <f7-list-item>
                <template #after-title>
                    {{ tt('Always Require Confirmation of Clipboard Content Before Submission') }}
                </template>
                <template #after>
                    <f7-toggle :checked="isAlwaysRequireConfirmationOfClipboardContentBeforeSubmission"
                               @toggle:change="isAlwaysRequireConfirmationOfClipboardContentBeforeSubmission = $event" />
                </template>
            </f7-list-item>
        </f7-list>

        <f7-block-title>{{ tt('AI Image Recognition') }}</f7-block-title>
        <f7-list strong inset dividers class="settings-list">
            <f7-list-item>
                <template #after-title>
                    {{ tt('Auto Upload AI Recognition Image as Transaction Picture') }}
                </template>
                <template #after>
                    <f7-toggle :checked="isAutoUploadTransactionPictureForAIRecognition"
                               @toggle:change="isAutoUploadTransactionPictureForAIRecognition = $event" />
                </template>
            </f7-list-item>
        </f7-list>
    </f7-page>
</template>

<script setup lang="ts">
import { useI18n } from '@/locales/helpers.ts';
import { useAppSettingPageBase } from '@/views/base/settings/AppSettingsPageBase.ts';

const { tt } = useI18n();
const {
    isAlwaysRequireConfirmationOfClipboardContentBeforeSubmission,
    isAutoUploadTransactionPictureForAIRecognition
} = useAppSettingPageBase();
</script>
