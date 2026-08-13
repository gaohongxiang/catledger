import type {
    LoanComponentType,
    LoanContractStatus,
    LoanContractType,
    LoanInstallmentDisplayStatus,
    LoanRepaymentMethod
} from './models.ts';

const contractTypeKeys: Record<LoanContractType, string> = {
    credit_card_installment: 'personalFinance.loans.contractType.creditCardInstallment',
    bank_loan: 'personalFinance.loans.contractType.bankLoan',
    consumer_loan: 'personalFinance.loans.contractType.consumerLoan',
    personal_loan: 'personalFinance.loans.contractType.personalLoan'
};

const repaymentMethodKeys: Record<LoanRepaymentMethod, string> = {
    flat: 'personalFinance.loans.repaymentMethod.flat',
    equal_payment: 'personalFinance.loans.repaymentMethod.equalPayment',
    equal_principal: 'personalFinance.loans.repaymentMethod.equalPrincipal',
    interest_only: 'personalFinance.loans.repaymentMethod.interestOnly'
};

const contractStatusKeys: Record<LoanContractStatus, string> = {
    active: 'personalFinance.loans.status.active',
    closed: 'personalFinance.loans.status.closed',
    cancelled: 'personalFinance.loans.status.cancelled'
};

const installmentStatusKeys: Record<LoanInstallmentDisplayStatus, string> = {
    unpaid: 'personalFinance.loans.installmentStatus.unpaid',
    partial: 'personalFinance.loans.installmentStatus.partial',
    paid: 'personalFinance.loans.installmentStatus.paid',
    overdue: 'personalFinance.loans.installmentStatus.overdue',
    action_required: 'personalFinance.loans.installmentStatus.actionRequired'
};

const componentTypeKeys: Record<LoanComponentType, string> = {
    disbursement: 'personalFinance.loans.component.disbursement',
    principal: 'personalFinance.loans.component.principal',
    interest: 'personalFinance.loans.component.interest',
    fee: 'personalFinance.loans.component.fee'
};

export function getLoanContractTypeKey(type: LoanContractType): string {
    return contractTypeKeys[type];
}

export function getLoanRepaymentMethodKey(method: LoanRepaymentMethod): string {
    return repaymentMethodKeys[method];
}

export function getLoanContractStatusKey(status: LoanContractStatus): string {
    return contractStatusKeys[status];
}

export function getLoanInstallmentStatusKey(status: LoanInstallmentDisplayStatus): string {
    return installmentStatusKeys[status];
}

export function getLoanComponentTypeKey(type: LoanComponentType): string {
    return componentTypeKeys[type];
}

export function getLoanStatusColor(status: LoanContractStatus | LoanInstallmentDisplayStatus): string {
    if (status === 'paid' || status === 'closed') {
        return 'success';
    }
    if (status === 'partial') {
        return 'warning';
    }
    if (status === 'overdue' || status === 'action_required') {
        return 'error';
    }
    return status === 'cancelled' ? 'secondary' : 'primary';
}
