import { describe, it, expect } from 'vitest';

// Import helper functions from resource-indexer
// These are not exported, so we'll copy them here for testing
function sanitizeUrl(url) {
  return (url || '').replace(/[`\n\r]+/g, '').replace(/[.)]+$/, '');
}

function isTemplateUrl(url) {
  if (/[`{}]/.test(url)) return true;
  if (/\/(RepoName|RepositoryName|ProjectName|OrgName|YourRepo|example)\b/i.test(url)) return true;
  if (/\/\.\.\.\//i.test(url)) return true;
  if (/\.Example\./i.test(url)) return true;
  return false;
}

describe('sanitizeUrl', () => {
  it('removes backticks from URLs', () => {
    expect(sanitizeUrl('https://dev.azure.com/org/proj/_git/Repo`')).toBe('https://dev.azure.com/org/proj/_git/Repo');
    expect(sanitizeUrl('`https://example.com`')).toBe('https://example.com');
  });

  it('removes newline characters', () => {
    expect(sanitizeUrl('https://example.com\n')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com\r\n')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com\r')).toBe('https://example.com');
  });

  it('removes trailing periods and parentheses', () => {
    expect(sanitizeUrl('https://example.com.')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com)')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com.)')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com...')).toBe('https://example.com');
  });

  it('handles URLs with multiple trailing junk characters', () => {
    expect(sanitizeUrl('https://example.com)..')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com...)))')).toBe('https://example.com');
  });

  it('combines all sanitizations', () => {
    expect(sanitizeUrl('`https://example.com\n).')).toBe('https://example.com');
  });

  it('handles empty and null inputs', () => {
    expect(sanitizeUrl('')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
  });

  it('preserves valid URLs unchanged', () => {
    expect(sanitizeUrl('https://dev.azure.com/microsoft/project/_git/MyRepo')).toBe('https://dev.azure.com/microsoft/project/_git/MyRepo');
  });
});

describe('isTemplateUrl', () => {
  it('detects backticks as template markers', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/`project`/_git/repo')).toBe(true);
    expect(isTemplateUrl('https://example.com/`placeholder`')).toBe(true);
  });

  it('detects curly braces as template markers', () => {
    expect(isTemplateUrl('https://dev.azure.com/{org}/{project}/_git/repo')).toBe(true);
    expect(isTemplateUrl('https://example.com/{id}')).toBe(true);
  });

  it('detects "RepoName" placeholder (case-insensitive)', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/RepoName')).toBe(true);
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/reponame')).toBe(true);
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/REPONAME')).toBe(true);
  });

  it('detects "RepositoryName" placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/RepositoryName/_git/repo')).toBe(true);
  });

  it('detects "ProjectName" placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/ProjectName/_git/repo')).toBe(true);
  });

  it('detects "OrgName" placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/OrgName/proj/_git/repo')).toBe(true);
  });

  it('detects "YourRepo" placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/YourRepo')).toBe(true);
  });

  it('detects "example" placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/example/_git/repo')).toBe(true);
  });

  it('detects ".../" ellipsis placeholder', () => {
    expect(isTemplateUrl('https://dev.azure.com/.../proj/_git/repo')).toBe(true);
  });

  it('detects ".Example." in domain', () => {
    expect(isTemplateUrl('https://www.Example.com/path')).toBe(true);
    expect(isTemplateUrl('https://api.example.Example.org')).toBe(true);
  });

  it('accepts valid real URLs', () => {
    expect(isTemplateUrl('https://dev.azure.com/microsoft/Cloud/_git/Cloud.Api.Public')).toBe(false);
    expect(isTemplateUrl('https://dev.azure.com/microsoft/Detection/_git/Detection.Service')).toBe(false);
    expect(isTemplateUrl('https://github.com/microsoft/vscode')).toBe(false);
  });

  it('accepts URLs with "repo" substring that are not placeholders', () => {
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/Cloud.Repository')).toBe(false);
    expect(isTemplateUrl('https://dev.azure.com/org/proj/_git/RepositoryService')).toBe(false);
  });

  it('handles empty and null inputs', () => {
    expect(isTemplateUrl('')).toBe(false);
    expect(isTemplateUrl(null)).toBe(false);
    expect(isTemplateUrl(undefined)).toBe(false);
  });
});
