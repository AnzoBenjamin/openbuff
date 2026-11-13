#!/usr/bin/env node

console.error(
  [
    '\nOpenbuff installed · local-first, bring your own API key.',
    'Start in your project: cd ~/my-project && openbuff',
    'In chat, run /provider to configure your provider and model.',
    ...(process.platform === 'win32'
      ? [
          'Windows terminal tools need Git Bash or WSL; use OPENBUFF_GIT_BASH_PATH for a custom Bash path.',
        ]
      : []),
    ...(process.platform === 'darwin' ? ['Requires macOS 11 or newer.'] : []),
    'If openbuff is missing, restart your shell and check your npm global bin PATH.',
    'Command directory: openbuff --help',
    'Installation help: https://github.com/AnzoBenjamin/openbuff#installation',
    '',
  ].join('\n'),
)
