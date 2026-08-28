import { describe, expect, test } from 'vitest';

import { ALL_LANGUAGES, DEFAULT_LANGUAGE } from './index.ts';

describe('CatLedger supported interface languages', () => {
    test('defaults to simplified Chinese and only bundles Chinese and English', () => {
        expect(DEFAULT_LANGUAGE).toBe('zh-Hans');
        expect(Object.keys(ALL_LANGUAGES).sort()).toEqual(['en', 'zh-Hans']);
    });
});
