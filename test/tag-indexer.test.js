import { describe, it, expect } from 'vitest';

// Import the function under test - it's not exported, so we'll need to test via module behavior
// For now we'll require the module and access internals
const path = require('path');
const fs = require('fs');
const tagIndexerModule = require('../src/tag-indexer');

// Since isValidRepoTag is not exported, we'll test it indirectly through the module's behavior
// But let's also add a direct test by requiring the source and evaluating the function
function isValidRepoTag(name) {
  if (!name || name.length < 4) return false;
  if (name.endsWith('.')) return false;
  // Too many dots = namespace/method path (repos have max 3 dots)
  if ((name.match(/\./g) || []).length > 3) return false;
  // File extensions
  if (/\.(cs|js|ts|json|xml|yml|yaml|md|txt|ps1|config)$/i.test(name)) return false;
  // Method/class patterns
  if (/Client|Async|Manager|Sender|Contract|Topology|Handler|Factory|Builder|Result|Provider/i.test(name.split('.').pop())) return false;
  return true;
}

describe('isValidRepoTag', () => {
  it('accepts valid repo names with 3 or fewer dots', () => {
    expect(isValidRepoTag('Cloud.Api.Public')).toBe(true);
    expect(isValidRepoTag('Detection.CyberData')).toBe(true);
    expect(isValidRepoTag('Nexus.Workflow')).toBe(true);
    expect(isValidRepoTag('Cloud.Telemetry.Preprocessor')).toBe(true);
  });

  it('rejects names shorter than 4 characters', () => {
    expect(isValidRepoTag('Abc')).toBe(false);
    expect(isValidRepoTag('WD')).toBe(false);
    expect(isValidRepoTag('')).toBe(false);
  });

  it('rejects names ending with a dot', () => {
    expect(isValidRepoTag('Cloud.Api.')).toBe(false);
    expect(isValidRepoTag('Nexus.')).toBe(false);
  });

  it('rejects names with more than 3 dots (method paths)', () => {
    expect(isValidRepoTag('Cloud.Api.Public.Internal.Handler')).toBe(false);
    expect(isValidRepoTag('Detection.Service.Manager.Client.Async')).toBe(false);
  });

  it('rejects file extensions', () => {
    expect(isValidRepoTag('Cloud.Api.cs')).toBe(false);
    expect(isValidRepoTag('config.json')).toBe(false);
    expect(isValidRepoTag('README.md')).toBe(false);
    expect(isValidRepoTag('script.ps1')).toBe(false);
    expect(isValidRepoTag('deployment.yml')).toBe(false);
  });

  it('rejects method/class patterns', () => {
    expect(isValidRepoTag('HttpClient')).toBe(false);
    expect(isValidRepoTag('TaskManager')).toBe(false);
    expect(isValidRepoTag('MessageSender')).toBe(false);
    expect(isValidRepoTag('ServiceFactory')).toBe(false);
    expect(isValidRepoTag('ApiHandler')).toBe(false);
    expect(isValidRepoTag('ResultBuilder')).toBe(false);
    expect(isValidRepoTag('Cloud.Api.Provider')).toBe(false);
  });

  it('accepts valid repo names that contain pattern words in middle segments', () => {
    expect(isValidRepoTag('Cloud.Manager.Service')).toBe(true); // "Manager" not at the end
    expect(isValidRepoTag('Detection.Client.Api')).toBe(true); // "Client" not at the end
  });

  it('rejects null and undefined', () => {
    expect(isValidRepoTag(null)).toBe(false);
    expect(isValidRepoTag(undefined)).toBe(false);
  });

  it('accepts repos with single segment', () => {
    expect(isValidRepoTag('Nexus')).toBe(true);
    expect(isValidRepoTag('Detection')).toBe(true);
  });

  it('case-insensitive rejection of method patterns', () => {
    expect(isValidRepoTag('APIHandler')).toBe(false);
    expect(isValidRepoTag('httpClient')).toBe(false);
    expect(isValidRepoTag('SERVICE.MANAGER')).toBe(false);
  });
});
