import { isEnableDebug } from './settings.ts';

function logDebug(msg: string, obj?: unknown): void {
    if (isEnableDebug()) {
        if (obj) {
            console.debug('[CatLedger Debug] ' + msg, obj);
        } else {
            console.debug('[CatLedger Debug] ' + msg);
        }
    }
}

function logInfo(msg: string, obj?: unknown): void {
    if (obj) {
        console.info('[CatLedger Info] ' + msg, obj);
    } else {
        console.info('[CatLedger Info] ' + msg);
    }
}

function logWarn(msg: string, obj?: unknown): void {
    if (obj) {
        console.warn('[CatLedger Warn] ' + msg, obj);
    } else {
        console.warn('[CatLedger Warn] ' + msg);
    }
}

function logError(msg: string, obj?: unknown): void {
    if (obj) {
        console.error('[CatLedger Error] ' + msg, obj);
    } else {
        console.error('[CatLedger Error] ' + msg);
    }
}

export default {
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError
};
