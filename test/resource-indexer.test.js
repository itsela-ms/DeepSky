import { describe, it, expect } from 'vitest';
const { parseUrlToResource } = require('../src/resource-indexer');

describe('parseUrlToResource', () => {
  // Valid URLs
  it('parses PR URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/project/_git/repo/pullrequest/123');
    expect(r).toMatchObject({ type: 'pr', id: '123', repo: 'repo' });
  });

  it('parses work item URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/_workitems/edit/456');
    expect(r).toMatchObject({ type: 'workitem', id: '456' });
  });

  it('parses pipeline build URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/project/_build/results?buildId=789');
    expect(r).toMatchObject({ type: 'pipeline', id: '789' });
  });

  it('parses repo URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/project/_git/MyRepo');
    expect(r).toMatchObject({ type: 'repo', name: 'MyRepo' });
  });

  it('parses wiki URL', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/project/_wiki/Page');
    expect(r).toMatchObject({ type: 'wiki' });
  });

  // Placeholder filtering
  it('rejects URLs with backticks', () => {
    expect(parseUrlToResource('https://dev.azure.com/microsoft/project/_git/RepoName`')).toBeNull();
  });

  it('rejects URLs with curly braces', () => {
    expect(parseUrlToResource('https://dev.azure.com/{org}/{project}/_git/repo')).toBeNull();
  });

  it('rejects URLs with "RepoName" placeholder', () => {
    expect(parseUrlToResource('https://dev.azure.com/microsoft/project/_git/RepoName')).toBeNull();
  });

  it('rejects URLs with "ProjectName" placeholder', () => {
    expect(parseUrlToResource('https://dev.azure.com/microsoft/ProjectName/_git/actual-repo')).toBeNull();
  });

  it('rejects URLs with "YourRepo" placeholder', () => {
    expect(parseUrlToResource('https://dev.azure.com/microsoft/project/_git/YourRepo')).toBeNull();
  });

  it('rejects URLs with "example" placeholder', () => {
    expect(parseUrlToResource('https://dev.azure.com/microsoft/example/_git/repo')).toBeNull();
  });

  // Case insensitive placeholder check
  it('rejects "reponame" case-insensitively', () => {
    expect(parseUrlToResource('https://dev.azure.com/org/proj/_git/repoName')).toBeNull();
  });

  // Valid repos that look similar but aren't placeholders
  it('accepts real repo names containing "repo"', () => {
    const r = parseUrlToResource('https://dev.azure.com/microsoft/project/_git/Cloud.Api.Repository');
    expect(r).not.toBeNull();
    expect(r.type).toBe('repo');
  });

  it('accepts generic links', () => {
    const r = parseUrlToResource('https://teams.microsoft.com/something');
    expect(r).not.toBeNull();
    expect(r.type).toBe('link');
  });
});
