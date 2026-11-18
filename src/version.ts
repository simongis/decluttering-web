// The version shown in the header, so a tester and a developer can tell they are looking at the same build.
// FEATURE_VERSION is the next release with a "-dev.N" counter that goes up by one with every change on this branch
// (set the plain release number, e.g. "1.4.0", when it ships). The commit comes from git at build or dev-server start
// (vite.config.ts), with "+" when the working copy had uncommitted changes.
export const FEATURE_VERSION = '1.4.0-dev.9';

declare const __DC_COMMIT__: string;
export const BUILD_COMMIT: string = typeof __DC_COMMIT__ === 'string' ? __DC_COMMIT__ : 'dev';
/** This build's own id (new for every build and dev-server start), matched against <base>version.json (src/update). */
declare const __DC_BUILD_ID__: string;
export const BUILD_ID: string = typeof __DC_BUILD_ID__ === 'string' ? __DC_BUILD_ID__ : 'dev';
