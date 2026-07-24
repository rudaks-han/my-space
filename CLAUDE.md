# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**My Space** — a Tauri 2 desktop app intended to aggregate multiple internal/work tools behind a left sidebar, added one feature at a time. Scaffolded with **tauri-ui** (`bun create tauri-ui`, `vite` template + `--starter` dashboard). Stack: Tauri 2 (Rust) + React 19 + TypeScript + Vite + **Tailwind v4** + **shadcn/ui** (built on `@base-ui/react`, not Radix). Package manager is **bun**.

## tauri-ui reference

This project is based on the tauri-ui template. When working on template structure, shadcn/ui conventions, batteries (debug-panel, workflow), or scaffold options, consult the official docs: **https://tauriui.vercel.app/docs**

## Commands

Run from repo root. `bun` and `cargo` must be on PATH (`export PATH="$HOME/.bun/bin:$PATH"`; `source ~/.cargo/env` if `cargo` is missing).

```bash
bun install            # once
bun run tauri dev      # dev mode — opens the app window, hot-reloads (Ctrl+C to quit)
bun run tauri build    # production build → src-tauri/target/release/bundle/ (.dmg + .app)
bun run build          # frontend only: tsc -b + vite build (the type-safety gate)
bun run typecheck      # tsc --noEmit
bun run lint           # eslint
bun run format         # prettier --write
```

There is no test runner. `bun run build` (via `tsc -b`) is the type gate. First `cargo` compile is slow (~2 min); later builds are incremental. Rust-only check: `cd src-tauri && cargo check`.

## Architecture

**Single window, menu-registry view switching (no router lib).** `src/App.tsx` holds one `activeId` (persisted to localStorage via `useLocalStorage`), looks up the matching entry in `MENUS`, and renders its `element` inside `<SidebarInset>` next to `<SiteHeader title={active.title}>`. `src/main.tsx` wraps everything in `ThemeProvider` (light/dark via `next-themes`) and `ExternalLinkGuard`. The original shadcn dashboard-01 demo widgets were removed.

**The extension point is `src/menus.tsx`** — it exports `MENUS: MenuItem[]` of `{ id, title, icon (LucideIcon), element }`. The sidebar and the content area are both driven off this array. Adding a feature = build a view under `src/features/<name>/`, import it in `menus.tsx`, append one entry. `src/components/app-sidebar.tsx` maps over `MENUS` and calls `onSelectMenu(id)` (named that, not `onSelect`, to avoid colliding with the DOM `onSelect` handler); the active item uses `SidebarMenuButton isActive`.

**Feature folder convention** (see `src/features/todo/`): a `*-view.tsx` component plus domain logic in a `use-*.ts` hook wrapping `useLocalStorage` (`src/lib/use-local-storage.ts`). Todo data lives under the `myspace.todos` key; the active menu under `myspace.activeMenu`.

**Calling Rust:** use `trackedInvoke<T>(command, args)` from `src/lib/tauri.ts` instead of raw `invoke` — it wraps `@tauri-apps/api` and emits debug events. Rust commands are registered in `src-tauri/src/lib.rs` via `invoke_handler(generate_handler![...])`; the scaffold ships a `greet` example. `lib.rs` also installs `tauri-plugin-log` and a custom `external-navigation` plugin that opens `http(s)`/`mailto`/`tel` links in the system browser. The window starts hidden (`visible: false`) and is shown on `PageLoadEvent::Finished`.

**UI conventions (shadcn on @base-ui):** components live in `src/components/ui/`. This build uses `@base-ui/react`, whose prop API differs from Radix — some Radix-era props (`asChild`, `delayDuration` on providers) don't exist. Add new components with `bunx shadcn@latest add <name>`. `cn()` (clsx + tailwind-merge) is in `src/lib/utils.ts`. Path alias `@/` → `src/`. Global styles/theme tokens in `src/index.css`.

## Releasing & auto-update

Distribution target is **macOS Apple Silicon only** (no OS code signing/notarization yet — recipients bypass Gatekeeper on first launch). Auto-update is wired via `tauri-plugin-updater` + GitHub Releases.

**How it works:** `App.tsx` calls `checkForUpdates()` (`src/lib/updater.ts`) once on startup. It reads `latest.json` from the endpoint in `tauri.conf.json` → `plugins.updater.endpoints` (`.../releases/latest/download/latest.json`), compares versions against `tauri.conf.json` `version`, and if newer prompts via a sonner toast → downloads → `relaunch()`. Updater artifacts are signed with a minisign key; the **public** key lives in `tauri.conf.json` `plugins.updater.pubkey`.

**Release steps:**
1. Bump `version` in `src-tauri/tauri.conf.json` (this is the version the updater compares; keep `Cargo.toml` in sync).
2. Commit, then push a matching tag: `git tag v0.1.1 && git push origin v0.1.1`.
3. `.github/workflows/release.yml` builds on `macos-latest` (aarch64) via `tauri-action`, signs artifacts, and creates a **draft** release with the `.dmg`, `.app.tar.gz`, `.sig`, and `latest.json`.
4. **Publish the draft** on GitHub — the updater's `releases/latest/download/` endpoint only serves published (non-draft) releases.

**Required GitHub secrets** (Settings → Secrets and variables → Actions): `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/myspace-updater.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the current key). ⚠️ The private key is **not** in the repo — losing it breaks the update chain for installed apps.

## Naming note

Rust crate/lib is `my-space` / `my_space_lib`; product/identifier in `src-tauri/tauri.conf.json` are `productName: "My Space"` / `com.rudaks.myspace`. Keep in sync when renaming; the lib name is referenced in `src-tauri/src/main.rs`.
