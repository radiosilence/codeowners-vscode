# CODEOWNERS LSP

[![CI](https://github.com/radiosilence/codeowners-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/radiosilence/codeowners-vscode/actions/workflows/ci.yml)
[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/radiosilence.codeowners-lsp)](https://marketplace.visualstudio.com/items?itemName=radiosilence.codeowners-lsp)

Language support for GitHub CODEOWNERS files via [codeowners-lsp](https://github.com/radiosilence/codeowners-lsp).

## Features

### In CODEOWNERS files
- Syntax highlighting
- Diagnostics (invalid patterns, shadowed rules, missing owners, etc.)
- Code actions (remove dead rules, fix duplicates, add owners)
- Completions for paths and owners
- Formatting
- Hover info with GitHub user/team details

### In any file
- Inlay hints showing file ownership
- Go-to-definition jumps to matching CODEOWNERS rule
- Hover shows ownership info
- Code actions to take ownership of unowned files

## Configuration

Settings under `codeowners.*`:

| Setting | Description |
|---------|-------------|
| `path` | Custom CODEOWNERS path (auto-detects if empty) |
| `individual` | Your @username for "take ownership" actions |
| `team` | Your @org/team for "take ownership" actions |
| `githubToken` | Token for owner validation (`env:VAR` syntax supported) |
| `validateOwners` | Enable GitHub API validation |
| `serverPath` | Custom LSP binary path |

### Diagnostic Severities

Configure severity (`error`, `warning`, `info`, `hint`, `off`) for each diagnostic:

- `diagnostics.invalidPattern` - Invalid glob syntax
- `diagnostics.invalidOwner` - Invalid owner format
- `diagnostics.patternNoMatch` - Pattern matches no files
- `diagnostics.duplicateOwner` - Same owner twice on rule
- `diagnostics.shadowedRule` - Rule shadowed by earlier rule
- `diagnostics.noOwners` - Rule has no owners
- `diagnostics.unownedFiles` - Files without CODEOWNERS entry
- `diagnostics.githubOwnerNotFound` - Owner not found on GitHub
- `diagnostics.fileNotOwned` - Current file has no owner

## Commands

- `CODEOWNERS: Restart Language Server` - Restart the LSP
- `CODEOWNERS: Show File Ownership` - Show current file's owners
- `CODEOWNERS: Go to Matching Rule` - Jump to CODEOWNERS rule

## Project Configuration

Create `.codeowners-lsp.toml` in your workspace root:

```toml
path = ".github/CODEOWNERS"
individual = "@yourname"
team = "@org/yourteam"
github_token = "env:GITHUB_TOKEN"
validate_owners = true

[diagnostics]
pattern-no-match = "warning"
no-owners = "off"
```

Use `.codeowners-lsp.local.toml` for personal overrides (gitignored).

## Binary Management

The extension automatically downloads the LSP binary from GitHub releases. Override with:
- `codeowners.serverPath` setting
- `codeowners-lsp` in your PATH
