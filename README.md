# DeepSky ✦

**Your command center for GitHub Copilot CLI.**

Stop juggling session IDs. DeepSky gives you a sleek desktop app to manage, search, and switch between all your Copilot CLI sessions — so you can focus on building, not bookkeeping.

![Windows](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Why DeepSky?

Copilot CLI is powerful, but managing sessions is painful. You're copying UUIDs, grepping through directories, and losing track of what's running. DeepSky fixes all of that with a visual interface purpose-built for power users.

## ✨ Features

### Session Management
- **Visual sidebar** with all your sessions — active and historical — searchable by title, tags, or linked resources
- **Concurrent sessions** — keep multiple sessions alive in the background with smart eviction when you hit the limit
- **Session rename** — double-click any title to give it a meaningful name
- **Instant resume** — click to reopen any past session exactly where you left off

### Embedded Terminal
- Full-featured terminal with 10,000-line scrollback, link detection, and clipboard support
- Multi-tab interface — switch between sessions like browser tabs
- Seamless session switching without losing state

### Smart Search & Resources
- Find sessions by title, tags, PR numbers, work item IDs, or repo names
- **Session Status resources** — every session shows linked PRs, work items, repos, wiki pages, and saved links inside the Session Status panel

### Notifications
- Real-time alerts when tasks complete, sessions error out, or input is needed
- Badge counter, dropdown panel, and DeepSky toast popups
- Never miss a completed build or a session waiting for input again

### Custom Instructions
- Built-in viewer for your `copilot-instructions.md` with Markdown rendering, collapsible sections, and table of contents
- Import/export and merge instructions across projects

### Polish
- **Catppuccin themes** — Mocha (dark) and Latte (light), because aesthetics matter
- **Auto-updates** — new versions download and install in the background

---

## Installation

### Windows Installer (recommended)

1. Download the latest `DeepSky-Setup-x.x.x.exe` from [**Releases**](https://github.com/itsela-ms/DeepSky/releases)
2. Run the installer — installs to your user profile with a Start Menu entry
3. Launch DeepSky from the Start Menu

> **Prerequisite:** [GitHub Copilot CLI](https://github.com/github/copilot-cli) — `winget install github.copilot`

### From Source

```bash
git clone https://github.com/itsela-ms/DeepSky.git
cd DeepSky
npm install
npm start
```

---

## Updates

DeepSky checks for updates automatically every 15 minutes. When a new version is found, it downloads silently and installs on your next quit — no restarts, no interruptions. A green badge on the settings gear lets you know an update is pending.

---

## License

MIT
