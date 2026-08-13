<template>
    <v-text-field
        type="number"
        min="1"
        max="1024"
        :label="label"
        :hint="required ? tt('personalFinance.genericBank.requiredColumn') : tt('personalFinance.genericBank.optionalColumn')"
        persistent-hint
        :clearable="!required"
        :model-value="modelValue"
        @update:model-value="updateValue"
    />
</template>

<script setup lang="ts">
import { useI18n } from '@/locales/helpers.ts';

defineProps<{
    label: string;
    modelValue: number | null;
    required?: boolean;
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: number | null): void;
}>();

const { tt } = useI18n();

function updateValue(value: string | number | null): void {
    if (value === null || value === '') {
        emit('update:modelValue', null);
        return;
    }

    emit('update:modelValue', Number(value));
}
</script>
