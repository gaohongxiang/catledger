import { type NavigationGuardReturn, createRouter, createWebHashHistory } from 'vue-router';

import { isUserLogined, isUserUnlocked } from '@/lib/userstate.ts';

import LoginPage from '@/views/desktop/LoginPage.vue';
import SignUpPage from '@/views/desktop/SignupPage.vue';
import VerifyEmailPage from '@/views/desktop/VerifyEmailPage.vue';
import ForgetPasswordPage from '@/views/desktop/ForgetPasswordPage.vue';
import ResetPasswordPage from '@/views/desktop/ResetPasswordPage.vue';
import OAuth2CallbackPage from '@/views/desktop/OAuth2CallbackPage.vue';
import UnlockPage from '@/views/desktop/UnlockPage.vue';

import PersonalFinancePageLayout from '@/components/desktop/PersonalFinancePageLayout.vue';
import PersonalFinanceBillOrganizerPage from '@/features/personal-finance/desktop/BillOrganizerPage.vue';
import PersonalFinanceLoanWorkbenchPage from '@/features/personal-finance/loans/desktop/LoanWorkbenchPage.vue';
import PersonalFinanceDashboardPage from '@/features/personal-finance/dashboard/desktop/DashboardPage.vue';

import TransactionListPage from '@/views/desktop/transactions/ListPage.vue';

import StatisticsTransactionPage from '@/views/desktop/statistics/TransactionPage.vue';

import AccountListPage from '@/views/desktop/accounts/ListPage.vue';

import CategoryPageLayout from '@/views/desktop/categories/CategoryPageLayout.vue';
import TransactionCategoryListPage from '@/views/desktop/categories/ListPage.vue';

import UserSettingsPageLayout from '@/views/desktop/user/UserSettingsPageLayout.vue';
import UserBasicSettingPage from '@/views/desktop/user/UserBasicSettingPage.vue';
import UserSecuritySettingPage from '@/views/desktop/user/UserSecuritySettingPage.vue';
import UserTwoFactorAuthSettingPage from '@/views/desktop/user/UserTwoFactorAuthSettingPage.vue';
import UserDataManagementSettingPage from '@/views/desktop/user/UserDataManagementSettingPage.vue';

import AppBasicSettingPage from '@/views/desktop/app/AppBasicSettingPage.vue';
import AppLockSettingPage from '@/views/desktop/app/AppLockSettingPage.vue';
import ExchangeRatesListPage from '@/views/desktop/exchangerates/ListPage.vue';

function checkLogin(): NavigationGuardReturn {
    if (!isUserLogined()) {
        return {
            path: '/login',
            replace: true
        };
    }

    if (!isUserUnlocked()) {
        return {
            path: '/unlock',
            replace: true
        };
    }

    return true;
}

function checkLocked(): NavigationGuardReturn {
    if (!isUserLogined()) {
        return {
            path: '/login',
            replace: true
        };
    }

    if (isUserUnlocked()) {
        return {
            path: '/',
            replace: true
        };
    }

    return true;
}

function checkNotLogin(): NavigationGuardReturn {
    if (isUserLogined() && !isUserUnlocked()) {
        return {
            path: '/unlock',
            replace: true
        };
    }

    if (isUserLogined()) {
        return {
            path: '/',
            replace: true
        };
    }

    return true;
}

const router = createRouter({
    history: createWebHashHistory(),
    routes: [
        {
            path: '/',
            component: PersonalFinancePageLayout,
            beforeEnter: checkLogin,
            children: [
                {
                    path: '',
                    component: PersonalFinanceDashboardPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/personal-finance/bills',
                    component: PersonalFinanceBillOrganizerPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/personal-finance/loans',
                    component: PersonalFinanceLoanWorkbenchPage,
                    beforeEnter: checkLogin
                }
            ]
        },
        {
            path: '/transaction/list',
            component: TransactionListPage,
            beforeEnter: checkLogin,
            props: route => ({
                initPageType: route.query['pageType'],
                initDateType: route.query['dateType'],
                initMaxTime: route.query['maxTime'],
                initMinTime: route.query['minTime'],
                initType: route.query['type'],
                initCategoryIds: route.query['categoryIds'],
                initAccountIds: route.query['accountIds'],
                initAmountFilter: route.query['amountFilter'],
                initKeyword: route.query['keyword'],
                initMatchMode: route.query['matchMode']
            })
        },
        {
            path: '/statistics/transaction',
            component: StatisticsTransactionPage,
            beforeEnter: checkLogin,
            props: route => ({
                initAnalysisType: route.query['analysisType'],
                initChartDataType: route.query['chartDataType'],
                initChartType: route.query['chartType'],
                initChartDateType: route.query['chartDateType'],
                initStartTime: route.query['startTime'],
                initEndTime: route.query['endTime'],
                initFilterAccountIds: route.query['filterAccountIds'],
                initFilterCategoryIds: route.query['filterCategoryIds'],
                initKeyword: route.query['keyword'],
                initMatchMode: route.query['matchMode'],
                initSortingType: route.query['sortingType'],
                initTrendDateAggregationType: route.query['trendDateAggregationType'],
                initAssetTrendsDateAggregationType: route.query['assetTrendsDateAggregationType']
            })
        },
        {
            path: '/account/list',
            component: AccountListPage,
            beforeEnter: checkLogin
        },
        {
            path: '/category',
            component: CategoryPageLayout,
            beforeEnter: checkLogin,
            redirect: '/category/list',
            children: [
                {
                    path: 'list',
                    component: TransactionCategoryListPage,
                    beforeEnter: checkLogin
                }
            ]
        },
        {
            path: '/',
            component: UserSettingsPageLayout,
            beforeEnter: checkLogin,
            children: [
                {
                    path: '/user/settings/basic',
                    component: UserBasicSettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/user/settings/security',
                    component: UserSecuritySettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/user/settings/two_factor',
                    component: UserTwoFactorAuthSettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/user/settings/data_management',
                    component: UserDataManagementSettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/app/settings/basic',
                    component: AppBasicSettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/app/settings/application_lock',
                    component: AppLockSettingPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/exchange_rate',
                    component: ExchangeRatesListPage,
                    beforeEnter: checkLogin
                },
                {
                    path: '/exchange_rates',
                    redirect: () => ({ path: '/exchange_rate', replace: true })
                }
            ]
        },
        {
            path: '/user/settings',
            redirect: () => ({ path: '/user/settings/basic', replace: true })
        },
        {
            path: '/app/settings',
            redirect: () => ({ path: '/app/settings/basic', replace: true })
        },
        {
            path: '/about',
            redirect: () => ({ path: '/', replace: true })
        },
        {
            path: '/login',
            component: LoginPage,
            beforeEnter: checkNotLogin
        },
        {
            path: '/signup',
            component: SignUpPage,
            beforeEnter: checkNotLogin
        },
        {
            path: '/verify_email',
            component: VerifyEmailPage,
            props: route => ({
                email: route.query['email'],
                token: route.query['token'],
                hasValidEmailVerifyToken: route.query['emailSent'] === 'true'
            })
        },
        {
            path: '/forgetpassword',
            component: ForgetPasswordPage,
            beforeEnter: checkNotLogin
        },
        {
            path: '/resetpassword',
            component: ResetPasswordPage,
            props: route => ({
                token: route.query['token']
            })
        },
        {
            path: '/oauth2_callback',
            component: OAuth2CallbackPage,
            props: route => ({
                token: route.query['token'],
                provider: route.query['provider'],
                platform: route.query['platform'],
                userName: route.query['userName'],
                errorCode: route.query['errorCode'],
                errorMessage: route.query['errorMessage']
            })
        },
        {
            path: '/unlock',
            component: UnlockPage,
            beforeEnter: checkLocked
        }
    ],
})

export default router;
