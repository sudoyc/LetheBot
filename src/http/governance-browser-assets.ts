import { readFileSync } from 'node:fs';

export interface GovernanceBrowserAsset {
  readonly contentType:
    | 'text/html; charset=utf-8'
    | 'text/css; charset=utf-8'
    | 'text/javascript; charset=utf-8';
  readonly body: string;
}

const BROWSER_ASSET_DIRECTORY = new URL('./governance-browser-assets/', import.meta.url);

function readBrowserAsset(filename: string): string {
  return readFileSync(new URL(filename, BROWSER_ASSET_DIRECTORY), 'utf8');
}

const GOVERNANCE_HTML = readBrowserAsset('app.html');
const GOVERNANCE_CSS = readBrowserAsset('app.css');
const GOVERNANCE_ACTIVITY_JAVASCRIPT = readBrowserAsset('activity.js');
const GOVERNANCE_ADMINISTRATION_JAVASCRIPT = readBrowserAsset('administration.js');
const GOVERNANCE_RETENTION_JAVASCRIPT = readBrowserAsset('retention.js');
const GOVERNANCE_DISPLAY_PROFILE_JAVASCRIPT = readBrowserAsset('display-profile.js');
const GOVERNANCE_EXPLAIN_JAVASCRIPT = readBrowserAsset('explain.js');
const GOVERNANCE_GROUP_SUMMARY_JAVASCRIPT = readBrowserAsset('group-summary.js');
const GOVERNANCE_PRIVACY_JAVASCRIPT = readBrowserAsset('privacy.js');
const GOVERNANCE_MEMORY_PRESENTATION_JAVASCRIPT = readBrowserAsset('memory-presentation.js');
const GOVERNANCE_MEMORY_JAVASCRIPT = readBrowserAsset('memory.js');
const GOVERNANCE_MEMORY_RECORD_MUTATIONS_JAVASCRIPT = readBrowserAsset(
  'memory-record-mutations.js',
);
const GOVERNANCE_MEMORY_APPLICATION_JAVASCRIPT = readBrowserAsset('memory-application.js');
const GOVERNANCE_MEMORY_MAINTENANCE_TRANSITIONS_JAVASCRIPT = readBrowserAsset(
  'memory-maintenance-transitions.js',
);
const GOVERNANCE_JAVASCRIPT = readBrowserAsset('app.js');

function compactAssetBody(body: string): string {
  return body.replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n').trim();
}

function compactJavaScriptBody(body: string): string {
  return compactAssetBody(body)
    .replace(/([({[,;])\n/g, '$1')
    .replace(/\n([)}\],;])/g, '$1');
}

const HTML_ASSET: GovernanceBrowserAsset = {
  contentType: 'text/html; charset=utf-8',
  body: compactAssetBody(GOVERNANCE_HTML),
};

const ASSETS: ReadonlyMap<string, GovernanceBrowserAsset> = new Map([
  ['/governance', HTML_ASSET],
  ['/governance/', HTML_ASSET],
  ['/governance/app.css', {
    contentType: 'text/css; charset=utf-8',
    body: compactAssetBody(GOVERNANCE_CSS),
  }],
  ['/governance/app.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_JAVASCRIPT),
  }],
  ['/governance/activity.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_ACTIVITY_JAVASCRIPT),
  }],
  ['/governance/administration.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_ADMINISTRATION_JAVASCRIPT),
  }],
  ['/governance/retention.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_RETENTION_JAVASCRIPT),
  }],
  ['/governance/display-profile.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_DISPLAY_PROFILE_JAVASCRIPT),
  }],
  ['/governance/explain.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_EXPLAIN_JAVASCRIPT),
  }],
  ['/governance/group-summary.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_GROUP_SUMMARY_JAVASCRIPT),
  }],
  ['/governance/privacy.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_PRIVACY_JAVASCRIPT),
  }],
  ['/governance/memory.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_MEMORY_JAVASCRIPT),
  }],
  ['/governance/memory-record-mutations.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_MEMORY_RECORD_MUTATIONS_JAVASCRIPT),
  }],
  ['/governance/memory-application.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_MEMORY_APPLICATION_JAVASCRIPT),
  }],
  ['/governance/memory-maintenance-transitions.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_MEMORY_MAINTENANCE_TRANSITIONS_JAVASCRIPT),
  }],
  ['/governance/memory-presentation.js', {
    contentType: 'text/javascript; charset=utf-8',
    body: compactJavaScriptBody(GOVERNANCE_MEMORY_PRESENTATION_JAVASCRIPT),
  }],
]);

export function getGovernanceBrowserAsset(pathname: string): GovernanceBrowserAsset | null {
  return ASSETS.get(pathname) ?? null;
}
