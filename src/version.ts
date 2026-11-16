// The version shown in the header, so a tester and a developer can tell they are looking at the same build.
// FEATURE_VERSION goes up by one with every change to the delete feature (ADR 0016); the commit comes from git at build or
// dev-server start (vite.config.ts), with "+" when the working copy had uncommitted changes.
export const FEATURE_VERSION = '1.3.0-borrado.5';

declare const __DC_COMMIT__: string;
export const BUILD_COMMIT: string = typeof __DC_COMMIT__ === 'string' ? __DC_COMMIT__ : 'dev';
