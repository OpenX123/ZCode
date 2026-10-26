<div align="center">
  <img src="public/logo/icons/128x128.png" alt="YCode" width="88" height="88" />
  <h1>YCode</h1>
  <p><strong>Your AI coding workspace.</strong></p>
  <p>Bring models, agents, code, and tools together.</p>

[![Build](https://github.com/OpenX123/ZCode/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/OpenX123/ZCode/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/OpenX123/ZCode?color=6366f1)](https://github.com/OpenX123/ZCode/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/macOS%20%7C%20Windows-ARM64%20%2B%20x64-18181b)

  <p><a href="README.md">简体中文</a> · English</p>
  <h3><a href="https://github.com/OpenX123/ZCode/releases/latest">Download YCode</a> · <a href="https://github.com/OpenX123/ZCode/actions/workflows/build.yml">Build status</a></h3>
</div>

![YCode desktop workspace](docs/images/readme/workspace.png)

YCode is an open-source AI coding workspace built with Electron, React, and TypeScript. Configure your own API provider, or connect Claude Code and Codex through ACP adapters in local desktop sessions. Adapters are installed explicitly from Settings; authentication stays with the corresponding CLI.

Features include streaming conversations and tool output, project and task management, files and diffs, Git, integrated terminals, a native Claude Code terminal, Skills, plugins, MCP, subagents, scheduled automation, dynamic workflows, and SSH workspaces. External engines currently support local desktop workspaces and expose a smaller set of session actions. Provider billing and CLI subscriptions follow their respective providers' rules.

## Download and install

Get installers from [GitHub Releases](https://github.com/OpenX123/ZCode/releases/latest). Each main update builds macOS ARM64/x64 and Windows ARM64/x64; a release is published only after all four targets succeed, with SHA256SUMS included.

| System  | Architecture          | Package  |
| ------- | --------------------- | -------- |
| macOS   | Apple Silicon / ARM64 | DMG, ZIP |
| macOS   | Intel / x64           | DMG, ZIP |
| Windows | Intel / AMD x64       | EXE      |
| Windows | ARM64                 | EXE      |

On macOS, open the DMG and drag **YCode.app** into Applications. GitHub builds currently have no Developer ID signature or Apple notarization. After checking the download source, if macOS blocks the application, run:

```bash
sudo xattr -rd com.apple.quarantine "/Applications/YCode.app"
```

Then open YCode again. Adjust the path if installed elsewhere. On Windows, run the EXE for your architecture; unsigned builds may trigger SmartScreen, so check the source and checksum first.

## Technology

| Layer                 | Implementation                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Desktop               | Electron 41; Main / Host / Renderer                                                                     |
| UI                    | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Radix UI / shadcn/ui                                    |
| State and interaction | Zustand 5, Motion, Lexical, xterm.js                                                                    |
| Services              | Node.js, Hono, HTTP / WebSocket, typed RPC, stdio Agent transport                                       |
| Agents                | TypeScript runtime, AI SDK 6, MCP, ACP adapters                                                         |
| Storage and remote    | SQLite, local files, ssh2 / SFTP, node-pty                                                              |
| Tooling               | pnpm workspaces, Turborepo, tsup, Vitest, WebdriverIO, Oxlint / Oxfmt, electron-builder, GitHub Actions |

## Development

Install Git, **Node.js 24.14.0**, and **pnpm 10.33.2** as pinned in mise.toml.

```bash
git clone https://github.com/OpenX123/ZCode.git
cd ZCode
pnpm bootstrap
pnpm dev:desktop
```

Use `pnpm dev:web` for the Web UI and local server, `pnpm bootstrap:with-remote` for remote resources, `pnpm typecheck` and `pnpm lint` for static checks, and `pnpm verify:pre-push` for affected validation.

```bash
pnpm bundle:desktop -- --os mac --arch arm64
pnpm bundle:desktop -- --os win --arch x64
```

The shared UI lives in packages/ui; desktop, Web, server, services, contracts, and providers are separate workspace packages. Agent CLI and runtime sources live in apps/zcode-cli. Existing internal package names, CLI names, environment variables, and data paths remain compatible.

See the [Chinese guide](README.md) for the directory map and commands. Licensed under [Apache-2.0](LICENSE); original copyright notices and third-party licenses remain in [NOTICE.md](NOTICE.md) and [third-party/README.md](third-party/README.md).
