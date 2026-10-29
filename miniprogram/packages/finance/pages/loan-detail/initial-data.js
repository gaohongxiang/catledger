const scheduleForm = require('./schedule-form')

// 只定义业务初值；主题由页面生命周期适配器独立维护。
module.exports = { ...require('../../services/historical-charge-coverage').initial,deletedPlan:false,deletingPreview:false,deleteBlockers:[],retainedChargeMode:false,retainedCharge:null, ...require('./upfront-fee').initial,...require('./charge-actions').initial,chargeRefundAccounts:[],sourceTransactionId: '', sourceContext: null, loan: null, loading: false, saving: false, errorMessage: '', fieldError: '', savedMessage: '', formOpen: false, hasPending: false,
    periodOpen: false, periodLoading: false, periodError: '', selectedPeriod: null, periodSources: [], periodLegacy: [], periodMoreSources: false, periodCanBook: false, periodEditing: false, periodEvidenceOpen:false, periodDraft: null, progressOpen: false, progressThrough: '',
    repaymentRows: [], repaymentChoiceCount: 0, repaymentSelectedCount: 0, repaymentDirtyCount: 0, detail: null, detailLoading: false, detailError: '', periodRows: [], scheduleMore: false, scheduleHistorical: false, guideOpen: false, costOpen: false,
    accounts: [], accountIndex: -1, kinds: ['普通借款','消费分期'], kindIndex: 0, name: '', institution: '',
    principalYuan: '', baselineDate: '', startDate: '', endDate: '', repaymentMethod: '',
    scheduleOpen: false, schedule: scheduleForm.blank(), scheduleMethods: scheduleForm.METHOD_OPTIONS, scheduleQuotes: scheduleForm.QUOTE_OPTIONS, scheduleMeasurements: scheduleForm.MEASUREMENT_OPTIONS }
