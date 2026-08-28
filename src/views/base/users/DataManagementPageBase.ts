import { ref, computed } from 'vue';

import { useI18n } from '@/locales/helpers.ts';

import { useUserStore } from '@/stores/user.ts';

import type { DataStatisticsResponse, DisplayDataStatistics } from '@/models/data_management.ts';

import { parseBigDecimal } from '@/lib/numeral.ts';

export function useDataManagementPageBase() {
    const { tt, formatBigDecimalToLocalizedNumerals } = useI18n();

    const userStore = useUserStore();

    const dataStatistics = ref<DataStatisticsResponse | null>(null);

    const displayDataStatistics = computed<DisplayDataStatistics | null>(() => {
        if (!dataStatistics.value) {
            return null;
        }

        return {
            totalTransactionCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalTransactionCount)),
            totalAccountCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalAccountCount)),
            totalTransactionCategoryCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalTransactionCategoryCount)),
            totalTransactionTagCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalTransactionTagCount)),
            totalTransactionPictureCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalTransactionPictureCount)),
			totalPersonalFinanceImportFileCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalPersonalFinanceImportFileCount)),
			totalPersonalFinanceImportBatchCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalPersonalFinanceImportBatchCount)),
			totalPersonalFinanceRawRowCount: formatBigDecimalToLocalizedNumerals(parseBigDecimal(dataStatistics.value.totalPersonalFinanceRawRowCount))
        };
    });

    function getExportFileName(fileExtension: string): string {
        const nickname = userStore.currentUserNickname;

        if (nickname) {
            return tt('dataExport.exportFilename', {
                nickname: nickname
            }) + '.' + fileExtension;
        }

        return tt('dataExport.defaultExportFilename') + '.' + fileExtension;
    }

    return {
        // states
        dataStatistics,
        // computed states
        displayDataStatistics,
        // functions
        getExportFileName
    }
}
