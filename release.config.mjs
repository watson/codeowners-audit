export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    [
      './scripts/semantic-release-publishable.mjs',
      {
        releasePaths: [
          'report.js',
          'lib/**',
          'package.json',
        ],
        notesHeader: 'Only conventional commits that touched publishable CLI/runtime files are included in this release.',
        commitAnalyzer: {
          parserOpts: {
            noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES'],
          },
        },
        releaseNotesGenerator: {
          writerOpts: {
            commitsSort: ['subject', 'scope'],
          },
        },
      },
    ],
    [
      '@semantic-release/npm',
      {
        npmPublish: true,
      },
    ],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
}
