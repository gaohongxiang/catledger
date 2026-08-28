import axios, { type AxiosRequestConfig, type AxiosRequestHeaders, type AxiosResponse } from 'axios';

import type { ApiResponse } from '@/core/api.ts';

import type {
    ApplicationCloudSetting
} from '@/core/setting.ts';
import type {
    VersionInfo
} from '@/core/version.ts';
import type {
    ImportFileTypeSupportedAdditionalOptions
} from '@/core/file.ts';
import {
    TransactionType
} from '@/core/transaction.ts';

import {
    BASE_API_URL_PATH,
    BASE_QRCODE_PATH,
    BASE_PROXY_URL_PATH,
    BASE_AMAP_API_PROXY_URL_PATH,
    DEFAULT_API_TIMEOUT,
    DEFAULT_UPLOAD_API_TIMEOUT,
    DEFAULT_EXPORT_API_TIMEOUT,
    DEFAULT_IMPORT_API_TIMEOUT,
    DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT,
    DEFAULT_CLEAR_ALL_TRANSACTIONS_API_TIMEOUT,
    DEFAULT_LLM_API_TIMEOUT,
    GOOGLE_MAP_JAVASCRIPT_URL,
    BAIDU_MAP_JAVASCRIPT_URL,
    AMAP_JAVASCRIPT_URL
} from '@/consts/api.ts';

import type {
    AccountCreateRequest,
    AccountModifyRequest,
    AccountUpdateLastReconciledTimeRequest,
    AccountInfoResponse,
    AccountHideRequest,
    AccountMoveRequest,
    AccountDeleteRequest
} from '@/models/account.ts';
import type {
    AuthResponse,
    RegisterResponse
} from '@/models/auth_response.ts';
import type {
    ExportTransactionDataRequest,
    ClearDataRequest,
    ClearAccountTransactionsRequest,
    DataStatisticsResponse
} from '@/models/data_management.ts';
import type {
    UserCustomExchangeRateUpdateRequest,
    UserCustomExchangeRateDeleteRequest,
    UserCustomExchangeRateUpdateResponse,
    LatestExchangeRateResponse
} from '@/models/exchange_rate.ts';
import type {
    ForgetPasswordRequest
} from '@/models/forget_password.ts';
import type {
    ImportTransactionResponsePageWrapper
} from '@/models/imported_transaction.ts';
import type {
    TransactionCreateRequest,
    TransactionModifyRequest,
    TransactionBatchUpdateCategoryRequest,
    TransactionBatchUpdateAccountRequest,
    TransactionBatchAddTagsRequest,
    TransactionBatchRemoveTagsRequest,
    TransactionBatchClearTagsRequest,
    TransactionMoveBetweenAccountsRequest,
    TransactionDeleteRequest,
    TransactionBatchDeleteRequest,
    TransactionImportRequest,
    TransactionListByMaxTimeRequest,
    TransactionListInMonthByPageRequest,
    TransactionAllListRequest,
    TransactionInfoResponse,
    TransactionInfoPageWrapperResponse,
    TransactionInfoPageWrapperResponse2,
    TransactionReconciliationStatementRequest,
    TransactionReconciliationStatementResponse,
    TransactionStatisticRequest,
    TransactionStatisticResponse,
    TransactionStatisticTrendsRequest,
    TransactionStatisticTrendsResponseItem,
    TransactionStatisticAssetTrendsRequest,
    TransactionStatisticAssetTrendsResponseItem,
    TransactionAmountsRequestParams,
    TransactionAmountsResponse
} from '@/models/transaction.ts';
import {
    TransactionAmountsRequest
} from '@/models/transaction.ts';
import type {
    TransactionCategoryCreateRequest,
    TransactionCategoryCreateBatchRequest,
    TransactionCategoryModifyRequest,
    TransactionCategoryHideRequest,
    TransactionCategoryMoveRequest,
    TransactionCategoryDeleteRequest,
    TransactionCategoryInfoResponse
} from '@/models/transaction_category.ts';
import type {
    TransactionPictureUnusedDeleteRequest,
    TransactionPictureInfoBasicResponse
} from '@/models/transaction_picture_info.ts';
import type {
    TransactionTagGroupCreateRequest,
    TransactionTagGroupModifyRequest,
    TransactionTagGroupMoveRequest,
    TransactionTagGroupDeleteRequest,
    TransactionTagGroupInfoResponse
} from '@/models/transaction_tag_group.ts';
import type {
    TransactionTagCreateRequest,
    TransactionTagCreateBatchRequest,
    TransactionTagModifyRequest,
    TransactionTagHideRequest,
    TransactionTagMoveRequest,
    TransactionTagDeleteRequest,
    TransactionTagInfoResponse
} from '@/models/transaction_tag.ts';
import type {
    TransactionTemplateCreateRequest,
    TransactionTemplateModifyRequest,
    TransactionTemplateHideRequest,
    TransactionTemplateMoveRequest,
    TransactionTemplateDeleteRequest,
    TransactionTemplateInfoResponse
} from '@/models/transaction_template.ts';
import type {
    InsightsExplorerCreateRequest,
    InsightsExplorerModifyRequest,
    InsightsExplorerHideRequest,
    InsightsExplorerMoveRequest,
    InsightsExplorerDeleteRequest,
    InsightsExplorerInfoResponse,
} from '@/models/explorer.ts';
import type {
    TokenGenerateAPIRequest,
    TokenGenerateMCPRequest,
    TokenRevokeRequest,
    TokenGenerateAPIResponse,
    TokenGenerateMCPResponse,
    TokenRefreshResponse,
    TokenInfoResponse
} from '@/models/token.ts';
import type {
    TwoFactorEnableConfirmRequest,
    TwoFactorEnableResponse,
    TwoFactorEnableConfirmResponse,
    TwoFactorDisableRequest,
    TwoFactorRegenerateRecoveryCodeRequest,
    TwoFactorStatusResponse
} from '@/models/two_factor.ts';
import type {
    UserLoginRequest,
    UserRegisterRequest,
    UserVerifyEmailResponse,
    UserResendVerifyEmailRequest,
    UserProfileResponse,
    UserProfileUpdateRequest,
    UserProfileUpdateResponse
} from '@/models/user.ts';
import type {
    UserExternalAuthUnlinkRequest,
    UserExternalAuthInfoResponse
} from '@/models/user_external_auth.ts';
import type {
    OAuth2CallbackLoginRequest
} from '@/models/oauth2.ts';
import type {
    UserApplicationCloudSettingsUpdateRequest
} from '@/models/user_app_cloud_setting.ts';
import type {
    RecognizedTransactionResponse
} from '@/models/large_language_model.ts';
import type {
    PersonalFinanceEvidenceResult,
    PersonalFinanceImportBatch,
    PersonalFinanceImportFile,
    PersonalFinanceImportBatchPage,
    PersonalFinanceImportRowPage,
    PersonalFinanceImportUploadResult,
    PersonalFinancePaymentAccountConfirmRequest,
    PersonalFinancePaymentAccountExcludeRequest,
    PersonalFinancePaymentAccountGroup,
    PersonalFinancePaymentAccountPage,
    PersonalFinancePostingDraft,
    PersonalFinanceReparseRequest,
    PersonalFinanceReparseResult,
    PersonalFinanceSourceAccount,
    PersonalFinanceSourceAccountPage,
    PersonalFinanceSourceAccountSaveRequest,
    PersonalFinanceUndoImpact,
    PersonalFinanceConsistencyReport
} from '@/features/personal-finance/models.ts';
import type {
    LoanCalculationInput,
    LoanCloseContractRequest,
    LoanContractLifecycleRequest,
    LoanContractStatus,
    LoanCreateContractRequest,
    LoanReviseContractRequest,
    LoanSettlementApplyRequest,
    LoanSettlementCandidatesRequest,
    LoanSettlementUndoImpactRequest,
    LoanSettlementUndoRequest
} from '@/features/personal-finance/loans/models.ts';

interface PersonalFinanceReconciliationDecisionRequest {
    readonly caseId: string;
    readonly expectedCaseVersion: number;
    readonly idempotencyKey: string;
    readonly decisionType: string;
    readonly fieldSelection: {
        readonly accountAmountMemberOrder: 0 | 1 | 2;
        readonly merchantItemMemberOrder: 0 | 1 | 2;
        readonly refundOriginalMemberOrder: 0 | 1 | 2;
    };
    readonly primaryDraft?: PersonalFinancePostingDraft;
    readonly refundOriginalDraft?: PersonalFinancePostingDraft;
    readonly refundTransactionDraft?: PersonalFinancePostingDraft;
}

import {
    getCurrentToken,
    clearCurrentTokenAndUserInfo
} from './userstate.ts';

import {
    isDefined,
    isBoolean,
    objectFieldWithValueToArrayItem
} from './common.ts';
import {
    getTimeZone
} from './settings.ts';
import {
    getGoogleMapAPIKey,
    getBaiduMapAK,
    getAmapApplicationKey,
    getExchangeRatesRequestTimeout
} from './server_settings.ts';
import {
    getTimezoneOffsetMinutes,
    getBrowserTimezoneName,
    getCurrentUnixTime
} from './datetime.ts';
import { generateRandomUUID } from './misc.ts';
import { getBasePath } from './web.ts';
import logger from './logger.ts';

interface ApiRequestConfig extends AxiosRequestConfig {
    readonly headers: AxiosRequestHeaders;
    readonly noAuth?: boolean;
    readonly ignoreBlocked?: boolean;
    readonly ignoreError?: boolean;
    readonly timeout?: number;
    readonly cancelableUuid?: string;
}

export type ApiResponsePromise<T> = Promise<AxiosResponse<ApiResponse<T>>>;

let needBlockRequest = false;
const blockedRequests: ((token: string | undefined) => void)[] = [];
const cancelableRequests: Record<string, boolean> = {};

axios.defaults.baseURL = getBasePath() + BASE_API_URL_PATH;
axios.defaults.timeout = DEFAULT_API_TIMEOUT;
axios.interceptors.request.use((config: ApiRequestConfig) => {
    const token = getCurrentToken();

    if (token && !config.noAuth) {
        config.headers.Authorization = `Bearer ${token}`;
    }

    config.headers['X-Timezone-Offset'] = getTimezoneOffsetMinutes(getCurrentUnixTime());

    let timezoneName = getTimeZone();

    if (!timezoneName || timezoneName.trim().length < 1) {
        timezoneName = getBrowserTimezoneName();
    }

    config.headers['X-Timezone-Name'] = timezoneName;

    if (needBlockRequest && !config.ignoreBlocked) {
        return new Promise(resolve => {
            blockedRequests.push(newToken => {
                if (newToken) {
                    config.headers.Authorization = `Bearer ${newToken}`;
                }

                resolve(config);
            });
        });
    }

    return config;
}, error => {
    return Promise.reject(error);
});

axios.interceptors.response.use(response => {
    if ('cancelableUuid' in response.config && response.config.cancelableUuid && cancelableRequests[response.config.cancelableUuid as string]) {
        logger.debug('Response canceled by user request, url: ' + response.config.url + ', cancelableUuid: ' + response.config.cancelableUuid);
        delete cancelableRequests[response.config.cancelableUuid as string];
        return Promise.reject({ canceled: true });
    }

    return response;
}, error => {
    if ('cancelableUuid' in error.response.config && error.response.config.cancelableUuid && cancelableRequests[error.response.config.cancelableUuid]) {
        logger.debug('Response canceled by user request, url: ' + error.response.config.url + ', cancelableUuid: ' + error.response.config.cancelableUuid);
        delete cancelableRequests[error.response.config.cancelableUuid];
        return Promise.reject({ canceled: true });
    }

    if (error.response && !error.response.config.ignoreError && error.response.data && error.response.data.errorCode) {
        const errorCode = error.response.data.errorCode;

        if (errorCode === 202001 // unauthorized access
            || errorCode === 202002 // current token is invalid
            || errorCode === 202003 // current token is expired
            || errorCode === 202004 // current token type is invalid
            || errorCode === 202005 // current token requires two-factor authorization
            || errorCode === 202006 // current token does not require two-factor authorization
            || errorCode === 202012 // token is empty
        ) {
            clearCurrentTokenAndUserInfo(false);
            location.reload();
            return Promise.reject({ processed: true });
        }
    }

    return Promise.reject(error);
});

export default {
    setLocale: (locale: string) => {
        axios.defaults.headers.common['Accept-Language'] = locale;
    },
    authorize: (data: UserLoginRequest): ApiResponsePromise<AuthResponse> => {
        return axios.post<ApiResponse<AuthResponse>>('authorize.json', data);
    },
    authorize2FA: ({ passcode, token }: { passcode: string, token: string }): ApiResponsePromise<AuthResponse> => {
        return axios.post<ApiResponse<AuthResponse>>('2fa/authorize.json', {
            passcode: passcode
        }, {
            noAuth: true,
            headers: {
                Authorization: `Bearer ${token}`
            }
        } as ApiRequestConfig);
    },
    authorize2FAByBackupCode: ({ recoveryCode, token }: { recoveryCode: string, token: string }): ApiResponsePromise<AuthResponse> => {
        return axios.post<ApiResponse<AuthResponse>>('2fa/recovery.json', {
            recoveryCode: recoveryCode
        }, {
            noAuth: true,
            headers: {
                Authorization: `Bearer ${token}`
            }
        } as ApiRequestConfig);
    },
    authorizeOAuth2: ({ password, passcode, callbackToken }: { password?: string, passcode?: string, callbackToken: string }): ApiResponsePromise<AuthResponse> => {
        const req: OAuth2CallbackLoginRequest = {
            password,
            passcode,
            token: getCurrentToken() || undefined
        };

        return axios.post<ApiResponse<AuthResponse>>('oauth2/authorize.json', req, {
            noAuth: true,
            headers: {
                Authorization: `Bearer ${callbackToken}`
            }
        } as ApiRequestConfig);
    },
    register: (req: UserRegisterRequest): ApiResponsePromise<RegisterResponse> => {
        return axios.post<ApiResponse<RegisterResponse>>('register.json', req);
    },
    verifyEmail: ({ token, requestNewToken }: { token: string, requestNewToken: boolean }): ApiResponsePromise<UserVerifyEmailResponse> => {
        return axios.post<ApiResponse<UserVerifyEmailResponse>>('verify_email/by_token.json?token=' + token, {
            requestNewToken: requestNewToken
        }, {
            noAuth: true,
            ignoreError: true
        } as ApiRequestConfig);
    },
    resendVerifyEmailByUnloginUser: (req: UserResendVerifyEmailRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('verify_email/resend.json', req);
    },
    requestResetPassword: (req: ForgetPasswordRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('forget_password/request.json', req);
    },
    resetPassword: ({ email, token, password }: { email: string, token: string, password: string }): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('forget_password/reset/by_token.json?token=' + token, {
            email: email,
            password: password
        }, {
            noAuth: true,
            ignoreError: true
        } as ApiRequestConfig);
    },
    logout: (): ApiResponsePromise<boolean> => {
        return axios.get<ApiResponse<boolean>>('logout.json');
    },
    refreshToken: (): ApiResponsePromise<TokenRefreshResponse> => {
        return new Promise((resolve) => {
            needBlockRequest = true;

            axios.post<ApiResponse<TokenRefreshResponse>>('v1/tokens/refresh.json', {}, {
                ignoreBlocked: true
            } as ApiRequestConfig).then(response => {
                const data = response.data;

                resolve(response);
                needBlockRequest = false;

                return data.result.newToken;
            }).then(newToken => {
                blockedRequests.forEach(func => func(newToken));
                blockedRequests.length = 0;
            });
        });
    },
    getExternalAuths: (): ApiResponsePromise<UserExternalAuthInfoResponse[]> => {
        return axios.get<ApiResponse<UserExternalAuthInfoResponse[]>>('v1/users/external_auth/list.json');
    },
    unlinkExternalAuth: (req: UserExternalAuthUnlinkRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/users/external_auth/unlink.json', req);
    },
    getTokens: (): ApiResponsePromise<TokenInfoResponse[]> => {
        return axios.get<ApiResponse<TokenInfoResponse[]>>('v1/tokens/list.json');
    },
    generateAPIToken: (req: TokenGenerateAPIRequest): ApiResponsePromise<TokenGenerateAPIResponse> => {
        return axios.post<ApiResponse<TokenGenerateAPIResponse>>('v1/tokens/generate/api.json', req);
    },
    generateMCPToken: (req: TokenGenerateMCPRequest): ApiResponsePromise<TokenGenerateMCPResponse> => {
        return axios.post<ApiResponse<TokenGenerateMCPResponse>>('v1/tokens/generate/mcp.json', req);
    },
    revokeToken: ({ tokenId, ignoreError }: { tokenId: string, ignoreError?: boolean }): ApiResponsePromise<boolean> => {
        const req: TokenRevokeRequest = {
            tokenId: tokenId
        };

        return axios.post<ApiResponse<boolean>>('v1/tokens/revoke.json', req, {
            ignoreError: !!ignoreError
        } as ApiRequestConfig);
    },
    revokeAllTokens: (): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/tokens/revoke_all.json');
    },
    getProfile: (): ApiResponsePromise<UserProfileResponse> => {
        return axios.get<ApiResponse<UserProfileResponse>>('v1/users/profile/get.json');
    },
    updateProfile: (req: UserProfileUpdateRequest): ApiResponsePromise<UserProfileUpdateResponse> => {
        return axios.post<ApiResponse<UserProfileUpdateResponse>>('v1/users/profile/update.json', req);
    },
    updateAvatar: ({ avatarFile }: { avatarFile: File }): ApiResponsePromise<UserProfileResponse> => {
        return axios.postForm<ApiResponse<UserProfileResponse>>('v1/users/avatar/update.json', {
            avatar: avatarFile
        }, {
            timeout: DEFAULT_UPLOAD_API_TIMEOUT
        });
    },
    removeAvatar: (): ApiResponsePromise<UserProfileResponse> => {
        return axios.post<ApiResponse<UserProfileResponse>>('v1/users/avatar/remove.json');
    },
    resendVerifyEmailByLoginedUser: (): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/users/verify_email/resend.json');
    },
    getUserApplicationCloudSettings: (): ApiResponsePromise<ApplicationCloudSetting[] | false> => {
        return axios.get<ApiResponse<ApplicationCloudSetting[] | false>>('v1/users/settings/cloud/get.json');
    },
    updateUserApplicationCloudSettings: (req: UserApplicationCloudSettingsUpdateRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/users/settings/cloud/update.json', req);
    },
    disableUserApplicationCloudSettings: (): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/users/settings/cloud/disable.json');
    },
    get2FAStatus: (): ApiResponsePromise<TwoFactorStatusResponse> => {
        return axios.get<ApiResponse<TwoFactorStatusResponse>>('v1/users/2fa/status.json');
    },
    enable2FA: (): ApiResponsePromise<TwoFactorEnableResponse> => {
        return axios.post<ApiResponse<TwoFactorEnableResponse>>('v1/users/2fa/enable/request.json');
    },
    confirmEnable2FA: (req: TwoFactorEnableConfirmRequest): ApiResponsePromise<TwoFactorEnableConfirmResponse> => {
        return axios.post<ApiResponse<TwoFactorEnableConfirmResponse>>('v1/users/2fa/enable/confirm.json', req);
    },
    disable2FA: (req: TwoFactorDisableRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/users/2fa/disable.json', req);
    },
    regenerate2FARecoveryCode: (req: TwoFactorRegenerateRecoveryCodeRequest): ApiResponsePromise<TwoFactorEnableConfirmResponse> => {
        return axios.post<ApiResponse<TwoFactorEnableConfirmResponse>>('v1/users/2fa/recovery/regenerate.json', req);
    },
    getUserDataStatistics: (): ApiResponsePromise<DataStatisticsResponse> => {
        return axios.get<ApiResponse<DataStatisticsResponse>>('v1/data/statistics.json');
    },
    getExportedUserData: (fileType: string, req?: ExportTransactionDataRequest): Promise<AxiosResponse<BlobPart>> => {
        let params = '';

        if (req) {
            const tagFilter = encodeURIComponent(req.tagFilter);
            const amountFilter = encodeURIComponent(req.amountFilter);
            const keyword = encodeURIComponent(req.keyword);
            params = `max_time=${req.maxTime}&min_time=${req.minTime}&type=${req.type}&category_ids=${req.categoryIds}&account_ids=${req.accountIds}&tag_filter=${tagFilter}&amount_filter=${amountFilter}&keyword=${keyword}&match_mode=${req.matchMode}`;
        } else {
            params = 'max_time=0&min_time=0&type=0&category_ids=&account_ids=&tag_filter=&amount_filter=&keyword=&match_mode=0';
        }

        if (fileType === 'csv') {
            return axios.get<BlobPart>('v1/data/export.csv?' + params, {
                timeout: DEFAULT_EXPORT_API_TIMEOUT
            } as ApiRequestConfig);
        } else if (fileType === 'tsv') {
            return axios.get<BlobPart>('v1/data/export.tsv?' + params, {
                timeout: DEFAULT_EXPORT_API_TIMEOUT
            } as ApiRequestConfig);
        } else {
            return Promise.reject('Parameter Invalid');
        }
    },
    clearAllData: (req: ClearDataRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/data/clear/all.json', req, {
            timeout: DEFAULT_CLEAR_ALL_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    clearAllTransactions: (req: ClearDataRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/data/clear/transactions.json', req, {
            timeout: DEFAULT_CLEAR_ALL_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    clearAllTransactionsOfAccount: (req: ClearAccountTransactionsRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/data/clear/transactions/by_account.json', req, {
            timeout: DEFAULT_CLEAR_ALL_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    getAllAccounts: ({ visibleOnly }: { visibleOnly: boolean }): ApiResponsePromise<AccountInfoResponse[]> => {
        return axios.get<ApiResponse<AccountInfoResponse[]>>('v1/accounts/list.json?visible_only=' + visibleOnly);
    },
    getAccount: ({ id }: { id: string }): ApiResponsePromise<AccountInfoResponse> => {
        return axios.get<ApiResponse<AccountInfoResponse>>('v1/accounts/get.json?id=' + id);
    },
    addAccount: (req: AccountCreateRequest): ApiResponsePromise<AccountInfoResponse> => {
        return axios.post<ApiResponse<AccountInfoResponse>>('v1/accounts/add.json', req);
    },
    modifyAccount: (req: AccountModifyRequest): ApiResponsePromise<AccountInfoResponse> => {
        return axios.post<ApiResponse<AccountInfoResponse>>('v1/accounts/modify.json', req);
    },
    updateAccountLastReconciledTime: (req: AccountUpdateLastReconciledTimeRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/accounts/update/last_reconciled_time.json', req);
    },
    hideAccount: (req: AccountHideRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/accounts/hide.json', req);
    },
    moveAccount: (req: AccountMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/accounts/move.json', req);
    },
    deleteAccount: (req: AccountDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/accounts/delete.json', req);
    },
    deleteSubAccount: (req: AccountDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/accounts/sub_account/delete.json', req);
    },
    getTransactions: (req: TransactionListByMaxTimeRequest): ApiResponsePromise<TransactionInfoPageWrapperResponse> => {
        const tagFilter = encodeURIComponent(req.tagFilter);
        const amountFilter = encodeURIComponent(req.amountFilter);
        const keyword = encodeURIComponent(req.keyword);
        return axios.get<ApiResponse<TransactionInfoPageWrapperResponse>>(`v1/transactions/list.json?max_time=${req.maxTime}&min_time=${req.minTime}&type=${req.type}&category_ids=${req.categoryIds}&account_ids=${req.accountIds}&tag_filter=${tagFilter}&amount_filter=${amountFilter}&keyword=${keyword}&match_mode=${req.matchMode}&must_have_pictures=${!!req.mustHavePictures}&count=${req.count}&page=${req.page}&with_count=${req.withCount}&with_pictures=${!!req.withPictures}&trim_account=true&trim_category=true&trim_tag=true`);
    },
    getAllTransactionsByMonth: (req: TransactionListInMonthByPageRequest): ApiResponsePromise<TransactionInfoPageWrapperResponse2> => {
        const tagFilter = encodeURIComponent(req.tagFilter);
        const amountFilter = encodeURIComponent(req.amountFilter);
        const keyword = encodeURIComponent(req.keyword);
        return axios.get<ApiResponse<TransactionInfoPageWrapperResponse2>>(`v1/transactions/list/by_month.json?year=${req.year}&month=${req.month}&type=${req.type}&category_ids=${req.categoryIds}&account_ids=${req.accountIds}&tag_filter=${tagFilter}&amount_filter=${amountFilter}&keyword=${keyword}&match_mode=${req.matchMode}&must_have_pictures=${!!req.mustHavePictures}&with_pictures=${!!req.withPictures}&trim_account=true&trim_category=true&trim_tag=true`);
    },
    getAllTransactions: (req: TransactionAllListRequest): ApiResponsePromise<TransactionInfoResponse[]> => {
        return axios.get<ApiResponse<TransactionInfoResponse[]>>(`v1/transactions/list/all.json?trim_account=true&with_pictures=${!!req.withPictures}&trim_category=true&trim_tag=true&start_time=${req.startTime}&end_time=${req.endTime}`);
    },
    getReconciliationStatements: (req: TransactionReconciliationStatementRequest): ApiResponsePromise<TransactionReconciliationStatementResponse> => {
        return axios.get<ApiResponse<TransactionReconciliationStatementResponse>>(`v1/transactions/reconciliation_statements.json?account_id=${req.accountId}&start_time=${req.startTime}&end_time=${req.endTime}`);
    },
    getTransactionStatistics: (req: TransactionStatisticRequest): ApiResponsePromise<TransactionStatisticResponse> => {
        const queryParams: string[] = [];

        if (req.startTime) {
            queryParams.push(`start_time=${req.startTime}`);
        }

        if (req.endTime) {
            queryParams.push(`end_time=${req.endTime}`);
        }

        if (req.tagFilter) {
            queryParams.push(`tag_filter=${encodeURIComponent(req.tagFilter)}`);
        }

        if (req.keyword) {
            queryParams.push(`keyword=${encodeURIComponent(req.keyword)}`);
        }

        if (req.matchMode) {
            queryParams.push(`match_mode=${req.matchMode}`);
        }

        return axios.get<ApiResponse<TransactionStatisticResponse>>(`v1/transactions/statistics.json?use_transaction_timezone=${req.useTransactionTimezone}` + (queryParams.length ? '&' + queryParams.join('&') : ''));
    },
    getTransactionStatisticsTrends: (req: TransactionStatisticTrendsRequest): ApiResponsePromise<TransactionStatisticTrendsResponseItem[]> => {
        const queryParams: string[] = [];

        if (req.startYearMonth) {
            queryParams.push(`start_year_month=${req.startYearMonth}`);
        }

        if (req.endYearMonth) {
            queryParams.push(`end_year_month=${req.endYearMonth}`);
        }

        if (req.tagFilter) {
            queryParams.push(`tag_filter=${encodeURIComponent(req.tagFilter)}`);
        }

        if (req.keyword) {
            queryParams.push(`keyword=${encodeURIComponent(req.keyword)}`);
        }

        if (req.matchMode) {
            queryParams.push(`match_mode=${req.matchMode}`);
        }

        return axios.get<ApiResponse<TransactionStatisticTrendsResponseItem[]>>(`v1/transactions/statistics/trends.json?use_transaction_timezone=${req.useTransactionTimezone}` + (queryParams.length ? '&' + queryParams.join('&') : ''));
    },
    getTransactionStatisticsAssetTrends: (req: TransactionStatisticAssetTrendsRequest): ApiResponsePromise<TransactionStatisticAssetTrendsResponseItem[]> => {
        const queryParams: string[] = [];

        if (req.startTime) {
            queryParams.push(`start_time=${req.startTime}`);
        }

        if (req.endTime) {
            queryParams.push(`end_time=${req.endTime}`);
        }

        return axios.get<ApiResponse<TransactionStatisticAssetTrendsResponseItem[]>>('v1/transactions/statistics/asset_trends.json' + (queryParams.length ? '?' + queryParams.join('&') : ''));
    },
    getTransactionAmounts: (params: TransactionAmountsRequestParams, excludeAccountIds: string[], excludeCategoryIds: string[]): ApiResponsePromise<TransactionAmountsResponse> => {
        const req = TransactionAmountsRequest.of(params);
        let queryParams = req.buildQuery();

        if (excludeAccountIds && excludeAccountIds.length) {
            queryParams = queryParams + `&exclude_account_ids=${excludeAccountIds.join(',')}`;
        }

        if (excludeCategoryIds && excludeCategoryIds.length) {
            queryParams = queryParams + `&exclude_category_ids=${excludeCategoryIds.join(',')}`;
        }

        return axios.get<ApiResponse<TransactionAmountsResponse>>(`v1/transactions/amounts.json?${queryParams}`);
    },
    getTransaction: ({ id, withPictures }: { id: string, withPictures: boolean | undefined }): ApiResponsePromise<TransactionInfoResponse> => {
        if (!isDefined(withPictures)) {
            withPictures = true;
        }

        return axios.get<ApiResponse<TransactionInfoResponse>>(`v1/transactions/get.json?id=${id}&with_pictures=${withPictures}&trim_account=true&trim_category=true&trim_tag=true`);
    },
    addTransaction: (req: TransactionCreateRequest): ApiResponsePromise<TransactionInfoResponse> => {
        return axios.post<ApiResponse<TransactionInfoResponse>>('v1/transactions/add.json', req);
    },
    modifyTransaction: (req: TransactionModifyRequest): ApiResponsePromise<TransactionInfoResponse> => {
        return axios.post<ApiResponse<TransactionInfoResponse>>('v1/transactions/modify.json', req);
    },
    batchUpdateTransactionCategories: (req: TransactionBatchUpdateCategoryRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_update/category.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    batchUpdateTransactionAccounts: (req: TransactionBatchUpdateAccountRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_update/account.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    batchAddTagsToTransaction: (req: TransactionBatchAddTagsRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_update/tag/add.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    batchRemoveTagsFromTransaction: (req: TransactionBatchRemoveTagsRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_update/tag/remove.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    batchClearAllTagsFromTransaction: (req: TransactionBatchClearTagsRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_update/tag/clear.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    moveAllTransactionsBetweenAccounts: (req: TransactionMoveBetweenAccountsRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/move/all.json', req);
    },
    deleteTransaction: (req: TransactionDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/delete.json', req);
    },
    batchDeleteTransaction: (req: TransactionBatchDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transactions/batch_delete.json', req, {
            timeout: DEFAULT_BATCH_UPDATE_TRANSACTIONS_API_TIMEOUT
        } as ApiRequestConfig);
    },
    parseImportCustomFile: ({ fileType, fileEncoding, importFile }: { fileType: string, fileEncoding?: string, importFile: File }): ApiResponsePromise<string[][]> => {
        return axios.postForm<ApiResponse<string[][]>>('v1/transactions/parse_custom_file.json', {
            fileType: fileType,
            fileEncoding: fileEncoding,
            file: importFile
        }, {
            timeout: DEFAULT_UPLOAD_API_TIMEOUT
        } as ApiRequestConfig);
    },
    parseImportTransaction: ({ fileType, additionalOptions, aiAdditionalPrompt, fileEncoding, importFile, columnMapping, transactionTypeMapping, hasHeaderLine, timeFormat, timezoneFormat, amountDecimalSeparator, amountDigitGroupingSymbol, geoSeparator, geoOrder, tagSeparator, cancelableUuid }: { fileType: string, additionalOptions?: ImportFileTypeSupportedAdditionalOptions, aiAdditionalPrompt?: string, fileEncoding?: string, importFile: File, columnMapping?: Record<number, number>, transactionTypeMapping?: Record<string, TransactionType>, hasHeaderLine?: boolean, timeFormat?: string, timezoneFormat?: string, amountDecimalSeparator?: string, amountDigitGroupingSymbol?: string, geoSeparator?: string, geoOrder?: string, tagSeparator?: string, cancelableUuid?: string }): ApiResponsePromise<ImportTransactionResponsePageWrapper> => {
        let textualAdditionalOptions: string | undefined = undefined;
        let textualColumnMapping: string | undefined = undefined;
        let textualTransactionTypeMapping: string | undefined = undefined;
        let textualHasHeaderLine: string | undefined = undefined;

        if (additionalOptions) {
            textualAdditionalOptions = objectFieldWithValueToArrayItem(additionalOptions, true).join(',');
        }

        if (columnMapping) {
            textualColumnMapping = JSON.stringify(columnMapping);
        }

        if (transactionTypeMapping) {
            textualTransactionTypeMapping = JSON.stringify(transactionTypeMapping);
        }

        if (hasHeaderLine) {
            textualHasHeaderLine = 'true';
        }

        let timeout: number = DEFAULT_UPLOAD_API_TIMEOUT;

        if (fileType === 'ai_txt' || fileType === 'ai_image') {
            timeout = DEFAULT_LLM_API_TIMEOUT;
        }

        return axios.postForm<ApiResponse<ImportTransactionResponsePageWrapper>>('v1/transactions/parse_import.json', {
            fileType: fileType,
            options: textualAdditionalOptions,
            aiPrompt: aiAdditionalPrompt,
            fileEncoding: fileEncoding,
            file: importFile,
            columnMapping: textualColumnMapping,
            transactionTypeMapping: textualTransactionTypeMapping,
            hasHeaderLine: textualHasHeaderLine,
            timeFormat: timeFormat,
            timezoneFormat: timezoneFormat,
            amountDecimalSeparator: amountDecimalSeparator,
            amountDigitGroupingSymbol: amountDigitGroupingSymbol,
            geoSeparator: geoSeparator,
            geoOrder: geoOrder,
            tagSeparator: tagSeparator
        }, {
            timeout: timeout,
            cancelableUuid: cancelableUuid
        } as ApiRequestConfig);
    },
    importTransactions: (req: TransactionImportRequest): ApiResponsePromise<number> => {
        return axios.post<ApiResponse<number>>('v1/transactions/import.json', req, {
            timeout: DEFAULT_IMPORT_API_TIMEOUT
        } as ApiRequestConfig);
    },
    getImportTransactionsProcess: (clientSessionId: string): ApiResponsePromise<number | null> => {
        return axios.get<ApiResponse<number | null>>('v1/transactions/import/process.json?client_session_id=' + clientSessionId, {
            ignoreError: true
        } as ApiRequestConfig);
    },
    uploadTransactionPicture: ({ pictureFile, clientSessionId }: { pictureFile: File, clientSessionId?: string }): ApiResponsePromise<TransactionPictureInfoBasicResponse> => {
        return axios.postForm<ApiResponse<TransactionPictureInfoBasicResponse>>('v1/transaction/pictures/upload.json', {
            picture: pictureFile,
            clientSessionId: clientSessionId
        }, {
            timeout: DEFAULT_UPLOAD_API_TIMEOUT
        } as ApiRequestConfig);
    },
    removeUnusedTransactionPicture: (req: TransactionPictureUnusedDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/pictures/remove_unused.json', req);
    },
    getAllTransactionCategories: (): ApiResponsePromise<Record<number, TransactionCategoryInfoResponse[]>> => {
        return axios.get<ApiResponse<Record<number, TransactionCategoryInfoResponse[]>>>('v1/transaction/categories/list.json');
    },
    getTransactionCategory: ({ id }: { id: string }): ApiResponsePromise<TransactionCategoryInfoResponse> => {
        return axios.get<ApiResponse<TransactionCategoryInfoResponse>>('v1/transaction/categories/get.json?id=' + id);
    },
    addTransactionCategory: (req: TransactionCategoryCreateRequest): ApiResponsePromise<TransactionCategoryInfoResponse> => {
        return axios.post<ApiResponse<TransactionCategoryInfoResponse>>('v1/transaction/categories/add.json', req);
    },
    addTransactionCategoryBatch: (req: TransactionCategoryCreateBatchRequest): ApiResponsePromise<Record<number, TransactionCategoryInfoResponse[]>> => {
        return axios.post<ApiResponse<Record<number, TransactionCategoryInfoResponse[]>>>('v1/transaction/categories/add_batch.json', req);
    },
    modifyTransactionCategory: (req: TransactionCategoryModifyRequest): ApiResponsePromise<TransactionCategoryInfoResponse> => {
        return axios.post<ApiResponse<TransactionCategoryInfoResponse>>('v1/transaction/categories/modify.json', req);
    },
    hideTransactionCategory: (req: TransactionCategoryHideRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/categories/hide.json', req);
    },
    moveTransactionCategory: (req: TransactionCategoryMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/categories/move.json', req);
    },
    deleteTransactionCategory: (req: TransactionCategoryDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/categories/delete.json', req);
    },
    getAllTransactionTagGroups: (): ApiResponsePromise<TransactionTagGroupInfoResponse[]> => {
        return axios.get<ApiResponse<TransactionTagInfoResponse[]>>('v1/transaction/tags/groups/list.json');
    },
    getTransactionTagGroup: ({ id }: { id: string }): ApiResponsePromise<TransactionTagGroupInfoResponse> => {
        return axios.get<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/groups/get.json?id=' + id);
    },
    addTransactionTagGroup: (req: TransactionTagGroupCreateRequest): ApiResponsePromise<TransactionTagGroupInfoResponse> => {
        return axios.post<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/groups/add.json', req);
    },
    modifyTransactionTagGroup: (req: TransactionTagGroupModifyRequest): ApiResponsePromise<TransactionTagGroupInfoResponse> => {
        return axios.post<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/groups/modify.json', req);
    },
    moveTransactionTagGroup: (req: TransactionTagGroupMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/tags/groups/move.json', req);
    },
    deleteTransactionTagGroup: (req: TransactionTagGroupDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/tags/groups/delete.json', req);
    },
    getAllTransactionTags: (): ApiResponsePromise<TransactionTagInfoResponse[]> => {
        return axios.get<ApiResponse<TransactionTagInfoResponse[]>>('v1/transaction/tags/list.json');
    },
    getTransactionTag: ({ id }: { id: string }): ApiResponsePromise<TransactionTagInfoResponse> => {
        return axios.get<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/get.json?id=' + id);
    },
    addTransactionTag: (req: TransactionTagCreateRequest): ApiResponsePromise<TransactionTagInfoResponse> => {
        return axios.post<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/add.json', req);
    },
    addTransactionTagBatch: (req: TransactionTagCreateBatchRequest): ApiResponsePromise<TransactionTagInfoResponse[]> => {
        return axios.post<ApiResponse<TransactionTagInfoResponse[]>>('v1/transaction/tags/add_batch.json', req);
    },
    modifyTransactionTag: (req: TransactionTagModifyRequest): ApiResponsePromise<TransactionTagInfoResponse> => {
        return axios.post<ApiResponse<TransactionTagInfoResponse>>('v1/transaction/tags/modify.json', req);
    },
    hideTransactionTag: (req: TransactionTagHideRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/tags/hide.json', req);
    },
    moveTransactionTag: (req: TransactionTagMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/tags/move.json', req);
    },
    deleteTransactionTag: (req: TransactionTagDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/tags/delete.json', req);
    },
    getAllTransactionTemplates: ({ templateType }: { templateType: number }): ApiResponsePromise<TransactionTemplateInfoResponse[]> => {
        return axios.get<ApiResponse<TransactionTemplateInfoResponse[]>>('v1/transaction/templates/list.json?templateType=' + templateType);
    },
    getTransactionTemplate: ({ id }: { id: string }): ApiResponsePromise<TransactionTemplateInfoResponse> => {
        return axios.get<ApiResponse<TransactionTemplateInfoResponse>>('v1/transaction/templates/get.json?id=' + id);
    },
    addTransactionTemplate: (req: TransactionTemplateCreateRequest): ApiResponsePromise<TransactionTemplateInfoResponse> => {
        return axios.post<ApiResponse<TransactionTemplateInfoResponse>>('v1/transaction/templates/add.json', req);
    },
    modifyTransactionTemplate: (req: TransactionTemplateModifyRequest): ApiResponsePromise<TransactionTemplateInfoResponse> => {
        return axios.post<ApiResponse<TransactionTemplateInfoResponse>>('v1/transaction/templates/modify.json', req);
    },
    hideTransactionTemplate: (req: TransactionTemplateHideRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/templates/hide.json', req);
    },
    moveTransactionTemplate: (req: TransactionTemplateMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/templates/move.json', req);
    },
    deleteTransactionTemplate: (req: TransactionTemplateDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/transaction/templates/delete.json', req);
    },
    getAllExplorations: (): ApiResponsePromise<InsightsExplorerInfoResponse[]> => {
        return axios.get<ApiResponse<InsightsExplorerInfoResponse[]>>('v1/insights/explorers/list.json');
    },
    getExploration: ({ id }: { id: string }): ApiResponsePromise<InsightsExplorerInfoResponse> => {
        return axios.get<ApiResponse<InsightsExplorerInfoResponse>>('v1/insights/explorers/get.json?id=' + id);
    },
    addExploration: (req: InsightsExplorerCreateRequest): ApiResponsePromise<InsightsExplorerInfoResponse> => {
        return axios.post<ApiResponse<InsightsExplorerInfoResponse>>('v1/insights/explorers/add.json', req);
    },
    modifyExploration: (req: InsightsExplorerModifyRequest): ApiResponsePromise<InsightsExplorerInfoResponse> => {
        return axios.post<ApiResponse<InsightsExplorerInfoResponse>>('v1/insights/explorers/modify.json', req);
    },
    hideExploration: (req: InsightsExplorerHideRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/insights/explorers/hide.json', req);
    },
    moveExploration: (req: InsightsExplorerMoveRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/insights/explorers/move.json', req);
    },
    deleteExploration: (req: InsightsExplorerDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/insights/explorers/delete.json', req);
    },
    recognizeTransactionText: ({ text }: { text: string }): ApiResponsePromise<RecognizedTransactionResponse> => {
        return axios.post<ApiResponse<RecognizedTransactionResponse>>('v1/llm/transactions/recognize_text.json', {
            text: text
        }, {
            timeout: DEFAULT_LLM_API_TIMEOUT
        } as ApiRequestConfig);
    },
    recognizeReceiptImage: ({ imageFile, cancelableUuid }: { imageFile: File, cancelableUuid?: string }): ApiResponsePromise<RecognizedTransactionResponse> => {
        return axios.postForm<ApiResponse<RecognizedTransactionResponse>>('v1/llm/transactions/recognize_receipt_image.json', {
            image: imageFile
        }, {
            timeout: DEFAULT_LLM_API_TIMEOUT,
            cancelableUuid: cancelableUuid
        } as ApiRequestConfig);
    },
    uploadPersonalFinanceImportFile: ({ file }: { file: File }): ApiResponsePromise<PersonalFinanceImportUploadResult> => {
        return axios.postForm<ApiResponse<PersonalFinanceImportUploadResult>>('v1/personal_finance/import_files/upload.json', {
            file
        }, {
            timeout: DEFAULT_UPLOAD_API_TIMEOUT
        });
    },
    listPersonalFinanceImportBatches: ({ page, count }: { page: number, count: number }): ApiResponsePromise<PersonalFinanceImportBatchPage> => {
        return axios.get<ApiResponse<PersonalFinanceImportBatchPage>>(`v1/personal_finance/import_batches/list.json?page=${page}&count=${count}`);
    },
    getPersonalFinanceImportBatch: ({ batchId }: { batchId: string }): ApiResponsePromise<PersonalFinanceImportBatch> => {
        return axios.get<ApiResponse<PersonalFinanceImportBatch>>(`v1/personal_finance/import_batches/get.json?batch_id=${encodeURIComponent(batchId)}`);
    },
    listPersonalFinanceImportRows: ({ batchId, page, count }: { batchId: string, page: number, count: number }): ApiResponsePromise<PersonalFinanceImportRowPage> => {
        return axios.get<ApiResponse<PersonalFinanceImportRowPage>>(`v1/personal_finance/import_batches/rows.json?batch_id=${encodeURIComponent(batchId)}&page=${page}&count=${count}`);
    },
    reparsePersonalFinanceImportFile: (request: PersonalFinanceReparseRequest): ApiResponsePromise<PersonalFinanceReparseResult> => {
        return axios.post<ApiResponse<PersonalFinanceReparseResult>>('v1/personal_finance/import_batches/reparse.json', request);
    },
    listPersonalFinanceSourceAccounts: (): ApiResponsePromise<PersonalFinanceSourceAccountPage> => {
        return axios.get<ApiResponse<PersonalFinanceSourceAccountPage>>('v1/personal_finance/source_accounts/list.json');
    },
    savePersonalFinanceSourceAccount: (request: PersonalFinanceSourceAccountSaveRequest): ApiResponsePromise<PersonalFinanceSourceAccount> => {
        return axios.post<ApiResponse<PersonalFinanceSourceAccount>>('v1/personal_finance/source_accounts/save.json', request);
    },
    listPersonalFinancePaymentAccounts: ({ batchId }: { batchId: string }): ApiResponsePromise<PersonalFinancePaymentAccountPage> => {
        return axios.get<ApiResponse<PersonalFinancePaymentAccountPage>>(`v1/personal_finance/import_batches/payment_accounts.json?batch_id=${encodeURIComponent(batchId)}`);
    },
    confirmPersonalFinancePaymentAccount: (request: PersonalFinancePaymentAccountConfirmRequest): ApiResponsePromise<PersonalFinancePaymentAccountGroup> => {
        return axios.post<ApiResponse<PersonalFinancePaymentAccountGroup>>('v1/personal_finance/import_batches/payment_accounts/confirm.json', request);
    },
    excludePersonalFinancePaymentAccount: (request: PersonalFinancePaymentAccountExcludeRequest): ApiResponsePromise<PersonalFinancePaymentAccountGroup> => {
        return axios.post<ApiResponse<PersonalFinancePaymentAccountGroup>>('v1/personal_finance/import_batches/payment_accounts/exclude.json', request);
    },
    skipPersonalFinancePaymentAccount: (request: PersonalFinancePaymentAccountExcludeRequest): ApiResponsePromise<PersonalFinancePaymentAccountGroup> => {
        return axios.post<ApiResponse<PersonalFinancePaymentAccountGroup>>('v1/personal_finance/import_batches/payment_accounts/skip.json', request);
    },
    restorePersonalFinancePaymentAccount: (request: PersonalFinancePaymentAccountExcludeRequest): ApiResponsePromise<PersonalFinancePaymentAccountGroup> => {
        return axios.post<ApiResponse<PersonalFinancePaymentAccountGroup>>('v1/personal_finance/import_batches/payment_accounts/restore.json', request);
    },
    getPersonalFinanceTransactionEvidence: ({ transactionId }: { transactionId: string }): ApiResponsePromise<PersonalFinanceEvidenceResult> => {
        return axios.get<ApiResponse<PersonalFinanceEvidenceResult>>(`v1/personal_finance/transactions/evidence.json?transaction_id=${encodeURIComponent(transactionId)}`);
    },
	discardPersonalFinanceImportBatch: ({ batchId }: { batchId: string }): ApiResponsePromise<PersonalFinanceImportBatch> => {
		return axios.post<ApiResponse<PersonalFinanceImportBatch>>('v1/personal_finance/import_batches/discard.json', { batchId });
	},
	deletePersonalFinanceImportFileContent: ({ fileId }: { fileId: string }): ApiResponsePromise<PersonalFinanceImportFile> => {
		return axios.post<ApiResponse<PersonalFinanceImportFile>>('v1/personal_finance/import_files/delete_content.json', { fileId });
	},
	getPersonalFinanceImportBatchUndoImpact: ({ batchId }: { batchId: string }): ApiResponsePromise<PersonalFinanceUndoImpact> => {
		return axios.get<ApiResponse<PersonalFinanceUndoImpact>>(`v1/personal_finance/import_batches/undo_impact.json?batch_id=${encodeURIComponent(batchId)}`);
	},
	getPersonalFinanceConsistency: (): ApiResponsePromise<PersonalFinanceConsistencyReport> => {
		return axios.get<ApiResponse<PersonalFinanceConsistencyReport>>('v1/personal_finance/consistency.json');
	},
    generatePersonalFinanceReconciliationCandidates: (request: { batchId: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/reconciliation/candidates/generate.json', request);
    },
    listPersonalFinanceReconciliationCases: (params: { status: string, cursor?: { updatedUnixTime: number, caseId: string }, limit: number }): ApiResponsePromise<unknown> => {
        const cursor = params.cursor
            ? `&cursor_updated_unix_time=${params.cursor.updatedUnixTime}&cursor_case_id=${encodeURIComponent(params.cursor.caseId)}`
            : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/reconciliation/cases/list.json?status=${encodeURIComponent(params.status)}&limit=${params.limit}${cursor}`);
    },
    getPersonalFinanceReconciliationCase: ({ caseId }: { caseId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/reconciliation/cases/get.json?case_id=${encodeURIComponent(caseId)}`);
    },
    decidePersonalFinanceReconciliationCase: (request: PersonalFinanceReconciliationDecisionRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/reconciliation/cases/decide.json', request);
    },
    getPersonalFinanceReconciliationUndoImpact: ({ caseId }: { caseId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/reconciliation/cases/undo_impact.json?case_id=${encodeURIComponent(caseId)}`);
    },
    undoPersonalFinanceReconciliationCase: (request: { caseId: string, expectedCaseVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/reconciliation/cases/undo.json', request);
    },
    calculatePersonalFinanceLoan: (request: LoanCalculationInput): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/calculate.json', request);
    },
    listPersonalFinanceLoanContracts: (params: { status: LoanContractStatus, cursor?: { updatedUnixTime: number, contractId: string }, limit: number }): ApiResponsePromise<unknown> => {
        const cursor = params.cursor
            ? `&cursor_updated_unix_time=${params.cursor.updatedUnixTime}&cursor_contract_id=${encodeURIComponent(params.cursor.contractId)}`
            : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/loans/contracts/list.json?status=${encodeURIComponent(params.status)}&limit=${params.limit}${cursor}`);
    },
    getPersonalFinanceLoanContract: ({ contractId }: { contractId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/loans/contracts/get.json?contract_id=${encodeURIComponent(contractId)}`);
    },
    createPersonalFinanceLoanContract: (request: LoanCreateContractRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/contracts/create.json', request);
    },
    revisePersonalFinanceLoanContract: (request: LoanReviseContractRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/contracts/revise.json', request);
    },
    closePersonalFinanceLoanContract: (request: LoanCloseContractRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/contracts/close.json', request);
    },
    reopenPersonalFinanceLoanContract: (request: LoanContractLifecycleRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/contracts/reopen.json', request);
    },
    cancelPersonalFinanceLoanContract: (request: LoanContractLifecycleRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/contracts/cancel.json', request);
    },
    listPersonalFinanceLoanSettlementCandidates: (request: LoanSettlementCandidatesRequest): ApiResponsePromise<unknown> => {
        const installment = request.installmentId ? `&installment_id=${encodeURIComponent(request.installmentId)}` : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/loans/settlements/candidates.json?contract_id=${encodeURIComponent(request.contractId)}&component_type=${encodeURIComponent(request.componentType)}${installment}`);
    },
    applyPersonalFinanceLoanSettlement: (request: LoanSettlementApplyRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/settlements/apply.json', request);
    },
    getPersonalFinanceLoanSettlementUndoImpact: (request: LoanSettlementUndoImpactRequest): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/loans/settlements/undo_impact.json?contract_id=${encodeURIComponent(request.contractId)}&action_id=${encodeURIComponent(request.actionId)}`);
    },
    undoPersonalFinanceLoanSettlement: (request: LoanSettlementUndoRequest): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/loans/settlements/undo.json', request);
    },
    getPersonalFinanceDashboardOverview: (params: { startDate: string, asOfDate: string, months: number, firstDayOfWeek: number }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/dashboard/overview.json?start_date=${encodeURIComponent(params.startDate)}&as_of_date=${encodeURIComponent(params.asOfDate)}&months=${params.months}&week_start=${params.firstDayOfWeek}`);
    },
    createPersonalFinanceOrganizerUpdate: (request: { batchIds: string[], idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/updates/create.json', request);
    },
    listPersonalFinanceOrganizerUpdates: (params: { status: string, limit: number, cursorUpdatedUnixTime?: number, cursorUpdateId?: string }): ApiResponsePromise<unknown> => {
        const cursor = params.cursorUpdatedUnixTime && params.cursorUpdateId
            ? `&cursor_updated_unix_time=${params.cursorUpdatedUnixTime}&cursor_update_id=${encodeURIComponent(params.cursorUpdateId)}` : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/updates/list.json?status=${encodeURIComponent(params.status)}&limit=${params.limit}${cursor}`);
    },
    getPersonalFinanceOrganizerUpdate: ({ updateId }: { updateId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/updates/get.json?id=${encodeURIComponent(updateId)}`);
    },
    organizePersonalFinanceUpdate: (request: { updateId: string, expectedUpdateVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/updates/organize.json', request);
    },
    abandonPersonalFinanceOrganizerUpdate: (request: { updateId: string, expectedUpdateVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/updates/abandon.json', request);
    },
    listPersonalFinanceOrganizerEvents: (params: { updateId: string, status?: string, limit: number, cursorUpdatedUnixTime?: number, cursorEventId?: string }): ApiResponsePromise<unknown> => {
        const status = params.status ? `&status=${encodeURIComponent(params.status)}` : '';
        const cursor = params.cursorUpdatedUnixTime && params.cursorEventId
            ? `&cursor_updated_unix_time=${params.cursorUpdatedUnixTime}&cursor_event_id=${encodeURIComponent(params.cursorEventId)}` : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/events/list.json?update_id=${encodeURIComponent(params.updateId)}&limit=${params.limit}${status}${cursor}`);
    },
    getPersonalFinanceOrganizerEventEvidence: ({ eventId }: { eventId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/events/evidence.json?id=${encodeURIComponent(eventId)}`);
    },
	getPersonalFinanceOrganizerCorrectionImpact: ({ updateId, eventId }: { updateId: string, eventId: string }): ApiResponsePromise<unknown> => {
		return axios.get<ApiResponse<unknown>>(`v1/personal_finance/events/correction_impact.json?update_id=${encodeURIComponent(updateId)}&event_id=${encodeURIComponent(eventId)}`);
	},
	getPersonalFinanceOrganizerCategoryScope: ({ updateId, eventId }: { updateId: string, eventId: string }): ApiResponsePromise<unknown> => {
		return axios.get<ApiResponse<unknown>>(`v1/personal_finance/events/category_scope.json?update_id=${encodeURIComponent(updateId)}&event_id=${encodeURIComponent(eventId)}`);
	},
    correctPersonalFinanceOrganizerEvent: (request: object): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/events/correct.json', request);
    },
    excludePersonalFinanceOrganizerEvent: (request: { updateId: string, eventId: string, expectedUpdateVersion: number, expectedEventVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/events/exclude.json', request);
    },
    postAllReadyPersonalFinanceOrganizerEvents: (request: { updateId: string, expectedUpdateVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/actions/post-all-ready.json', request);
    },
    getPersonalFinanceOrganizerUndoImpact: ({ updateId }: { updateId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/actions/undo_impact.json?update_id=${encodeURIComponent(updateId)}`);
    },
    undoPersonalFinanceOrganizerUpdate: (request: { updateId: string, expectedUpdateVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/actions/undo.json', request);
    },
    getPersonalFinanceInstallmentCandidate: ({ candidateId }: { candidateId: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/installments/candidates/get.json?id=${encodeURIComponent(candidateId)}`);
    },
    listPersonalFinanceInstallmentCandidates: (params: { status: string, limit: number, cursorUpdatedUnixTime?: number, cursorCandidateId?: string }): ApiResponsePromise<unknown> => {
        const cursor = params.cursorUpdatedUnixTime && params.cursorCandidateId
            ? `&cursor_updated_unix_time=${params.cursorUpdatedUnixTime}&cursor_candidate_id=${encodeURIComponent(params.cursorCandidateId)}` : '';
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/installments/candidates/list.json?status=${encodeURIComponent(params.status)}&limit=${params.limit}${cursor}`);
    },
    confirmPersonalFinanceInstallmentCandidate: (request: Record<string, unknown>): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/installments/candidates/confirm.json', request);
    },
    listPersonalFinanceCardCycleAccounts: ({ asOfDate }: { asOfDate: string }): ApiResponsePromise<unknown> => {
        return axios.get<ApiResponse<unknown>>(`v1/personal_finance/card_cycle/accounts.json?as_of_date=${encodeURIComponent(asOfDate)}`);
    },
    savePersonalFinanceBalanceReview: (request: { ledgerAccountId: string, status: string, asOfDate: string, expectedVersion: number, idempotencyKey: string }): ApiResponsePromise<unknown> => {
        return axios.post<ApiResponse<unknown>>('v1/personal_finance/accounts/balance_review.json', request);
    },
    getLatestExchangeRates: (param: { ignoreError?: boolean }): ApiResponsePromise<LatestExchangeRateResponse> => {
        return axios.get<ApiResponse<LatestExchangeRateResponse>>('v1/exchange_rates/latest.json', {
            ignoreError: !!param.ignoreError,
            timeout: getExchangeRatesRequestTimeout() || DEFAULT_API_TIMEOUT
        } as ApiRequestConfig);
    },
    updateUserCustomExchangeRate: (req: UserCustomExchangeRateUpdateRequest): ApiResponsePromise<UserCustomExchangeRateUpdateResponse> => {
        return axios.post<ApiResponse<UserCustomExchangeRateUpdateResponse>>('v1/exchange_rates/user_custom/update.json', req);
    },
    deleteUserCustomExchangeRate: (req: UserCustomExchangeRateDeleteRequest): ApiResponsePromise<boolean> => {
        return axios.post<ApiResponse<boolean>>('v1/exchange_rates/user_custom/delete.json', req);
    },
    getServerVersion: (): ApiResponsePromise<VersionInfo> => {
        return axios.get<ApiResponse<VersionInfo>>('v1/systems/version.json');
    },
    cancelRequest: (cancelableUuid: string) => {
        cancelableRequests[cancelableUuid] = true;
    },
    generateOAuth2LoginUrl: (platform: 'mobile' | 'desktop', clientSessionId: string): string => {
        return `${getBasePath()}/oauth2/login?platform=${platform}&client_session_id=${clientSessionId}`;
    },
    generateOAuth2LinkUrl: (platform: 'mobile' | 'desktop', clientSessionId: string): string => {
        return `${getBasePath()}/oauth2/login?platform=${platform}&client_session_id=${clientSessionId}&token=${getCurrentToken()}`;
    },
    generateQrCodeUrl: (qrCodeName: string): string => {
        return `${getBasePath()}${BASE_QRCODE_PATH}/${qrCodeName}.png`;
    },
    getMapProxyTileImageAndAnnotationImageUrlPatterns(): string[] {
        return [
            `.*${BASE_PROXY_URL_PATH}/map/tile/[^/]+/[^/]+/[^/]+\\.png\\?provider=[^&]+.*$`,
            `.*${BASE_PROXY_URL_PATH}/map/annotation/[^/]+/[^/]+/[^/]+\\.png\\?provider=[^&]+.*$`
        ];
    },
    generateMapProxyTileImageUrl: (mapProvider: string, language: string): string => {
        const token = getCurrentToken();
        let url = `${getBasePath()}${BASE_PROXY_URL_PATH}/map/tile/{z}/{x}/{y}.png?provider=${mapProvider}&token=${token}`;

        if (language) {
            url = url + `&language=${language}`;
        }

        return url;
    },
    generateMapProxyAnnotationImageUrl: (mapProvider: string, language: string): string => {
        const token = getCurrentToken();
        let url = `${getBasePath()}${BASE_PROXY_URL_PATH}/map/annotation/{z}/{x}/{y}.png?provider=${mapProvider}&token=${token}`;

        if (language) {
            url = url + `&language=${language}`;
        }

        return url;
    },
    generateGoogleMapJavascriptUrl: (language: string | undefined, callbackFnName: string): string => {
        let url = `${GOOGLE_MAP_JAVASCRIPT_URL}?key=${getGoogleMapAPIKey()}&libraries=core,marker&callback=${callbackFnName}`;

        if (language) {
            url = url + `&language=${language}`;
        }

        return url;
    },
    generateBaiduMapJavascriptUrl: (callbackFnName: string): string => {
        return `${BAIDU_MAP_JAVASCRIPT_URL}&ak=${getBaiduMapAK()}&callback=${callbackFnName}`;
    },
    generateAmapJavascriptUrl: (callbackFnName: string): string => {
        return `${AMAP_JAVASCRIPT_URL}&key=${getAmapApplicationKey()}&plugin=AMap.ToolBar&callback=${callbackFnName}`;
    },
    generateAmapApiInternalProxyUrl: (): string => {
        return `${window.location.origin}${getBasePath()}${BASE_AMAP_API_PROXY_URL_PATH}`;
    },
    getInternalAvatarUrlWithToken(avatarUrl: string, disableBrowserCache?: boolean | string): string {
        if (!avatarUrl) {
            return avatarUrl;
        }

        const params: string[] = [];
        params.push('token=' + getCurrentToken());

        if (disableBrowserCache) {
            if (isBoolean(disableBrowserCache)) {
                params.push('_nocache=' + generateRandomUUID());
            } else {
                params.push('_nocache=' + disableBrowserCache);
            }
        }

        if (avatarUrl.indexOf('?') >= 0) {
            return avatarUrl + '&' + params.join('&');
        } else {
            return avatarUrl + '?' + params.join('&');
        }
    },
    getTransactionPictureUrlWithToken(pictureUrl: string, disableBrowserCache?: boolean | string): string {
        if (!pictureUrl) {
            return pictureUrl;
        }

        const params: string[] = [];
        params.push('token=' + getCurrentToken());

        if (disableBrowserCache) {
            if (isBoolean(disableBrowserCache)) {
                params.push('_nocache=' + generateRandomUUID());
            } else {
                params.push('_nocache=' + disableBrowserCache);
            }
        }

        if (pictureUrl.indexOf('?') >= 0) {
            return pictureUrl + '&' + params.join('&');
        } else {
            return pictureUrl + '?' + params.join('&');
        }
    }
};
