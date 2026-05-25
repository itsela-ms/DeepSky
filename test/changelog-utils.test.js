import { describe, it, expect } from 'vitest';

const { parseChangelog, getRecentChangelogReleases } = require('../src/changelog-utils');

const SAMPLE_CHANGELOG = `# Changelog

## [1.2.0] - 2026-05-18

### Changed
- **Better visibility** for release notes
- \`Ctrl+Shift+T\` works again

### Fixed
- Sidebar restore uses full session inventory

## [1.1.0] - 2026-05-04

### Added
- New About tab

## [1.0.0] - 2026-04-26

- Plain note before any explicit section
`;

describe('changelog-utils', () => {
  it('parses releases, sections, and bullet items', () => {
    const releases = parseChangelog(SAMPLE_CHANGELOG);
    expect(releases).toHaveLength(3);
    expect(releases[0]).toEqual({
      version: '1.2.0',
      date: '2026-05-18',
      sections: [
        {
          title: 'Changed',
          items: [
            '**Better visibility** for release notes',
            '`Ctrl+Shift+T` works again',
          ],
        },
        {
          title: 'Fixed',
          items: [
            'Sidebar restore uses full session inventory',
          ],
        },
      ],
    });
  });

  it('limits the recent release view without reordering entries', () => {
    const releases = getRecentChangelogReleases(SAMPLE_CHANGELOG, 2);
    expect(releases.map(release => release.version)).toEqual(['1.2.0', '1.1.0']);
  });

  it('creates a Notes section when bullets appear before a section heading', () => {
    const releases = parseChangelog(SAMPLE_CHANGELOG);
    expect(releases[2].sections).toEqual([
      {
        title: 'Notes',
        items: ['Plain note before any explicit section'],
      },
    ]);
  });
});
