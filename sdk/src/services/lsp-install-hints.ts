/**
 * Install hints for the stdio language servers in
 * `common/src/util/language-capabilities.ts`, keyed by the server command
 * (argv[0]). Kept in the SDK rather than the registry so the published
 * language-capability manifest (schemaVersion 1) does not change. Shown only
 * when a server binary is missing (language-intel-07).
 */
const LSP_INSTALL_HINTS: Readonly<Record<string, string>> = {
  'typescript-language-server':
    'npm install -g typescript-language-server typescript',
  'pyright-langserver': 'npm install -g pyright',
  'rust-analyzer': 'rustup component add rust-analyzer',
  gopls: 'go install golang.org/x/tools/gopls@latest',
  jdtls:
    'install Eclipse JDT Language Server (for example `brew install jdtls`) and put `jdtls` on PATH',
  'csharp-ls': 'dotnet tool install --global csharp-ls',
  clangd:
    'install clangd from your LLVM packages (for example `apt install clangd` or `brew install llvm`)',
  'ruby-lsp': 'gem install ruby-lsp',
  intelephense: 'npm install -g intelephense',
  'sourcekit-lsp': 'install the Swift toolchain (sourcekit-lsp ships with it)',
  'kotlin-language-server':
    'install kotlin-language-server (for example `brew install kotlin-language-server`) and put it on PATH',
}

export function lspInstallHint(command: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(LSP_INSTALL_HINTS, command)
    ? LSP_INSTALL_HINTS[command]
    : undefined
}
