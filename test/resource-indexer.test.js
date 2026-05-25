import { describe, it, expect } from 'vitest';

const ResourceIndexer = require('../src/resource-indexer');
const { resourceKey, parseUrlToResource } = ResourceIndexer;

describe('resource-indexer > parseUrlToResource', () => {
  it('parses a pull-request URL with repo segment', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_git/Cloud.Monitoring/pullrequest/12345');
    expect(r.type).toBe('pr');
    expect(r.id).toBe('12345');
    expect(r.repo).toBe('Cloud.Monitoring');
  });

  it('parses a work item URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_workitems/edit/678');
    expect(r).toMatchObject({ type: 'workitem', id: '678' });
  });

  it('parses a build pipeline URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_build/results?buildId=999');
    expect(r).toMatchObject({ type: 'pipeline', id: '999' });
  });

  it('parses a pipeline definition URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_build?definitionId=42');
    expect(r).toMatchObject({ type: 'pipeline', id: 'def-42' });
  });

  it('parses a release URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_releaseProgress?releaseId=7');
    expect(r).toMatchObject({ type: 'release', id: '7' });
  });

  it('parses a wiki URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/OS/_wiki/wikis/Docs/123/Welcome');
    expect(r.type).toBe('wiki');
  });

  it('parses a repo URL and normalizes it', () => {
    const r = parseUrlToResource('https://microsoft.visualstudio.com/DefaultCollection/OS/_git/Cloud.Monitoring/somefile');
    expect(r.type).toBe('repo');
    expect(r.url).toBe('https://dev.azure.com/microsoft/OS/_git/Cloud.Monitoring');
  });

  it('falls back to a generic link for unknown URLs', () => {
    const r = parseUrlToResource('https://example.com/a/b/c/d');
    expect(r.type).toBe('link');
    expect(r.name).toBe('example.com/a/b');
  });
});

describe('resource-indexer > resourceKey', () => {
  it('uses type:id when an id is present', () => {
    expect(resourceKey({ type: 'pr', id: '99', url: 'whatever' })).toBe('pr:99');
  });

  it('normalizes repo URLs when no id is present', () => {
    const a = resourceKey({ type: 'repo', url: 'https://microsoft.visualstudio.com/OS/_git/Cloud.Monitoring/extra/' });
    const b = resourceKey({ type: 'repo', url: 'https://dev.azure.com/microsoft/OS/_git/Cloud.Monitoring' });
    expect(a).toBe(b);
  });

  it('strips query strings and trailing slashes for non-repo links', () => {
    const a = resourceKey({ type: 'link', url: 'https://example.com/page/?x=1' });
    const b = resourceKey({ type: 'link', url: 'https://example.com/page' });
    expect(a).toBe(b);
  });
});
