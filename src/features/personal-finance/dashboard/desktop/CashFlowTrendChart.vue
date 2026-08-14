<template>
    <div class="cash-flow-trend">
        <div class="cash-flow-trend__placeholder" v-if="hidden">
            {{ tt('personalFinance.dashboard.cashFlow.amountsHidden') }}
        </div>
        <div class="cash-flow-trend__placeholder" v-else-if="!points.length">
            {{ tt('No data') }}
        </div>
        <v-chart v-else autoresize class="cash-flow-trend__chart" :option="chartOptions" :update-options="{ notMerge: true }" />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from 'vuetify';
import type { CallbackDataParams } from 'echarts/types/dist/shared';

import { ThemeType } from '@/core/theme.ts';
import { useI18n } from '@/locales/helpers.ts';

interface CashFlowTrendPoint {
    month: string;
    income: number;
    consumption: number;
    debtService: number;
    incomeLabel: string;
    consumptionLabel: string;
    debtServiceLabel: string;
}

const props = defineProps<{
    points: CashFlowTrendPoint[];
    hidden: boolean;
}>();

const { tt } = useI18n();
const theme = useTheme();
const isDark = computed(() => theme.global.name.value === ThemeType.Dark);

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character] as string));
}

const chartOptions = computed<object>(() => {
    const textColor = isDark.value ? '#e7e4df' : '#4b4744';
    const splitColor = isDark.value ? 'rgba(255,255,255,.08)' : 'rgba(23,53,47,.09)';
    return {
        animationDuration: 320,
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            backgroundColor: isDark.value ? '#252525' : '#fffdf9',
            borderColor: splitColor,
            textStyle: { color: textColor },
            formatter: (params: CallbackDataParams[]) => {
                const index = params[0]?.dataIndex;
                const point = typeof index === 'number' ? props.points[index] : undefined;
                if (!point) return '';
                const rows = [
                    ['#2f8f72', tt('personalFinance.dashboard.cashFlow.income'), point.incomeLabel],
                    ['#d17a42', tt('personalFinance.dashboard.cashFlow.consumption'), point.consumptionLabel],
                    ['#5d526b', tt('personalFinance.dashboard.cashFlow.debtService'), point.debtServiceLabel]
                ];
                return `<strong>${escapeHtml(point.month)}</strong><div style="margin-top:8px">${rows.map(row =>
                    `<div style="display:flex;justify-content:space-between;gap:22px;margin:4px 0">` +
                    `<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${row[0]};margin-right:7px"></i>${escapeHtml(row[1] as string)}</span>` +
                    `<strong>${escapeHtml(row[2] as string)}</strong></div>`
                ).join('')}</div>`;
            }
        },
        legend: {
            bottom: 6,
            icon: 'circle',
            itemWidth: 9,
            itemHeight: 9,
            textStyle: { color: textColor },
            data: [
                tt('personalFinance.dashboard.cashFlow.income'),
                tt('personalFinance.dashboard.cashFlow.consumption'),
                tt('personalFinance.dashboard.cashFlow.debtService')
            ]
        },
        grid: { left: 20, right: 20, top: 18, bottom: 72, containLabel: true },
        xAxis: {
            type: 'category',
            data: props.points.map(point => point.month),
            axisLine: { lineStyle: { color: splitColor } },
            axisTick: { show: false },
            axisLabel: { color: textColor, margin: 14 }
        },
        yAxis: {
            type: 'value',
            axisLabel: { show: false },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: splitColor } }
        },
        series: [
            {
                id: 'income',
                name: tt('personalFinance.dashboard.cashFlow.income'),
                type: 'bar',
                barMaxWidth: 18,
                itemStyle: { color: '#2f8f72', borderRadius: [5, 5, 0, 0] },
                data: props.points.map(point => point.income)
            },
            {
                id: 'consumption',
                name: tt('personalFinance.dashboard.cashFlow.consumption'),
                type: 'bar',
                stack: 'outflow',
                barMaxWidth: 18,
                itemStyle: { color: '#d17a42' },
                data: props.points.map(point => -Math.abs(point.consumption))
            },
            {
                id: 'debtService',
                name: tt('personalFinance.dashboard.cashFlow.debtService'),
                type: 'bar',
                stack: 'outflow',
                barMaxWidth: 18,
                itemStyle: { color: '#5d526b', borderRadius: [0, 0, 5, 5] },
                data: props.points.map(point => -Math.abs(point.debtService))
            }
        ]
    };
});
</script>

<style scoped>
.cash-flow-trend {
    position: relative;
    min-height: 330px;
    margin-top: 22px;
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), .1);
}
.cash-flow-trend__chart { height: 330px; }
.cash-flow-trend__placeholder {
    min-height: 330px;
    display: grid;
    place-items: center;
    color: rgba(var(--v-theme-on-surface), .56);
    background: repeating-linear-gradient(135deg, transparent 0, transparent 14px, rgba(var(--v-theme-on-surface), .025) 15px);
}
</style>
