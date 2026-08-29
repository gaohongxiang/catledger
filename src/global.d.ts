declare module 'vuetify/styles';
declare module 'framework7-icons';

declare const __CATLEDGER_IS_PRODUCTION__: boolean;
declare const __CATLEDGER_VERSION__: string;
declare const __CATLEDGER_BUILD_UNIX_TIME__: string;
declare const __CATLEDGER_BUILD_COMMIT_HASH__: string;

interface Window {
    CATLEDGER_SERVER_SETTINGS?: {
        [key: string]: string | number | boolean | undefined | null;
    };
}

interface Navigator {
    browserLanguage?: string;
}

interface Credential {
    rawId: ArrayBuffer;
    response: {
        clientDataJSON: ArrayBuffer;
        attestationObject: ArrayBuffer;
        userHandle: ArrayBuffer;
    };
}
