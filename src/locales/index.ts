import en from './en.json';
import zhHans from './zh_Hans.json';

export interface LanguageInfo {
    readonly name: string;
    readonly displayName: string;
    readonly alternativeLanguageTag: string;
    readonly aliases?: string[];
    readonly textDirection: 'ltr' | 'rtl';
    readonly content: object;
}

export interface LanguageOption {
    readonly languageTag: string;
    readonly displayName: string;
    readonly nativeDisplayName: string;
}

export const DEFAULT_LANGUAGE: string = 'zh-Hans';

// CatLedger targets Chinese users. Keep English as the fallback language while
// leaving upstream translation files unregistered so they do not enter the bundle.
export const ALL_LANGUAGES: Record<string, LanguageInfo> = {
    'en': {
        name: 'English',
        displayName: 'English',
        alternativeLanguageTag: 'en-US',
        textDirection: 'ltr',
        content: en
    },
    'zh-Hans': {
        name: 'Chinese (Simplified)',
        displayName: '中文 (简体)',
        alternativeLanguageTag: 'zh-CN',
        aliases: ['zh-CHS', 'zh-CN', 'zh-SG'],
        textDirection: 'ltr',
        content: zhHans
    },
};
