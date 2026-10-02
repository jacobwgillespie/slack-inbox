# Development

Slack Inbox is an Electron app with a React interface and a local SQLite cache. The [README](README.md) covers installing and using the app.

## Run locally

Use macOS, Node.js 22.13 or later, and pnpm 12.6.0. Install Xcode Command Line Tools to build the native authentication module and macOS icons.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and launches Electron. Sign in through the app; no `.env.local` file, Slack app registration, or manually copied tokens are required.

| Command | Purpose |
| --- | --- |
| `pnpm dev` or `pnpm desktop` | Build and launch Electron |
| `pnpm desktop:build` | Build the renderer and desktop processes |
| `pnpm typecheck` | Check TypeScript |
| `pnpm desktop:package` | Build a local macOS app, DMG, and ZIP |
| `pnpm desktop:release` | Build signed releases for Apple Silicon and Intel |
| `pnpm icons` | Regenerate app icons |

After building, `pnpm exec electron electron-dist/main.cjs` launches directly. Rebuild and relaunch to pick up code changes. Vite builds the renderer; it doesn't host a separate Slack backend.

The existing file-cache and credential-redirect checks run with:

```sh
node --experimental-transform-types --test server/files.test.ts
```

Only add tests for critical behavior.

## Architecture

- `desktop/main.ts` owns the window, embedded Slack views, authentication, local HTTP API, sync engine, and shutdown.
- `desktop/preload.ts` exposes a typed IPC bridge to the renderer. The renderer runs with context isolation and sandboxing, without Node.js integration.
- `src/` contains the React interface. TanStack DB provides reactive message, conversation, saved-item, and user collections. Zustand handles commands, selection, drafts, shortcuts, and optimistic actions.
- `server/` contains the SQLite database, Slack API transport, inbox sync, saved items, thread replies, and image cache. Electron hosts these modules in its main process.

The UI loads from a loopback HTTP server. IPC calls are restricted to the app's own renderer. Slack API requests use the embedded session's network stack; the session token stays in the main process.

### Sign-in and realtime updates

`desktop/browser-signin.ts` uses `electron-native-auth` for the macOS browser authentication handoff. Slack returns one-time login keys, which the app exchanges through the embedded session to establish its cookies. Browser passwords, passkeys, and MFA stay in the browser. Device-bound Slack login callbacks are currently rejected.

`desktop/slack-session.ts` observes Slack's own WebSocket traffic for messages, edits, deletions, reactions, typing, and read markers. The sync engine doesn't open a second realtime connection. It periodically reconciles unread state and refreshes the directory to recover missed updates.

### Conversation history and composing

A dedicated background Slack view collects rendered history into SQLite, keyed by conversation ID and message timestamp. It prioritizes the selected conversation, observed unread activity, and visible sidebar rows. Overlapping virtualized windows fill history in batches; only Slack's rendered beginning-of-conversation marker establishes complete history.

The renderer hydrates conversations from SQLite through IPC, reads older pages as you scroll, and shows cached messages when collection fails. React Activities retain the eight most recently opened conversation panels and their scroll positions.

The separate Slack view follows the selected conversation for composing. Sanitized snapshots supply Slack's editor and suggestion menus; edits and supported control actions are forwarded to Slack's composer. Thread replies use the app's plain-text composer and Slack API. **Open Slack** reveals the full client with the same draft.

Background HTTP and WebSocket read-marker writes are blocked. Explicit read actions and the visible Slack view can mark messages read. Sending, marking read, reactions, workspace discovery, and inbox synchronization still use the Slack API.

Image previews are cached in SQLite. Standard emoji come from [emoji-data](https://github.com/iamcal/emoji-data); `scripts/build-emoji.mjs` generates the lookup. Its license is in `src/slack/emoji-data.LICENSE`.

### Local state

Electron stores cookies and SQLite in its `userData` directory. On macOS, the default is `~/Library/Application Support/Slack Inbox`; the database is `slack.sqlite`. Renderer preferences and onboarding state use Chromium local storage in the same profile.

| Environment variable | Purpose |
| --- | --- |
| `SLACK_DESKTOP_DATABASE_PATH` | Override the SQLite file path |
| `SLACK_DESKTOP_PORT` | Override the loopback renderer port, which defaults to `5174` |

Changes to the cache must preserve existing profiles, Done markers, and saved items. Historical SQLite tables and renderer preference migrations remain compatible with older app data. Shutdown stops collection and sync, flushes Slack cookies, and closes the database before exiting.

## Packaging

```sh
pnpm desktop:package
```

This creates **Slack Inbox.app**, a DMG, and a ZIP in `release/` for the current architecture. It uses ad-hoc signing and skips notarization for local development. Open the app from `release/mac-arm64/` on Apple Silicon or `release/mac/` on Intel.

Packages contain the built renderer and desktop code, without local credentials, databases, or browser profiles. Generated code is in `dist/` and `electron-dist/`.

The icon source is `assets/icon-source.png`. `pnpm icons` generates the renderer PNG and `assets/icon.icns`; builds run this automatically.

## Signing and releases

GitHub Actions runs `pnpm desktop:build` for pull requests and pushes to `main`. The **Release** workflow builds signed, notarized DMGs and ZIPs for both Mac architectures, then checks the signatures, Gatekeeper assessment, and stapled notarization tickets.

Configure these [repository Actions secrets](https://github.com/jacobwgillespie/slack-inbox/settings/secrets/actions):

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded `.p12` containing the Developer ID Application certificate and private key |
| `MAC_CSC_KEY_PASSWORD` | Password that encrypts the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `HOMEBREW_TAP_DEPLOY_KEY` | SSH private key with a write-enabled deploy key on `jacobwgillespie/homebrew-tap` |

Use a **Developer ID Application** certificate from Apple's **G2 Sub-CA**. Export it with its private key as a password-protected `.p12` and keep a secure backup outside the repository. For OpenSSL exports, use Keychain-compatible encryption: `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1`.

Run the **Release** workflow manually to download signed artifacts without creating a release. To publish a version:

1. Update `version` in `package.json` and commit the change to `main`.
2. Tag that commit with the matching version and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Wait for the workflow to create a draft GitHub Release. It uploads only after both architectures build and refuses to overwrite published releases.
4. Install the DMG on a clean Mac and check sign-in and startup.
5. Review the release notes and publish the draft. Keep the ZIPs, blockmaps, and `latest-mac.yml` with the DMGs; automatic updates need them.

The updater reads public GitHub Releases without an access token; draft releases aren't visible to update checks.

Publishing a stable release triggers **Update Homebrew cask**. It updates `Casks/slack-inbox.rb` in `jacobwgillespie/homebrew-tap` with the published version and GitHub's SHA-256 digests for both DMGs, then commits directly to the tap's `main` branch. Prereleases and releases that aren't the latest stable version are skipped. Run this workflow manually to retry an update; an already-current cask produces no commit.

`desktop/updates.ts` checks at startup and every four hours in packaged macOS apps. It downloads in the background and notifies the renderer when an update is ready. The footer's download button restarts and installs it. Development runs skip update checks.

For release validation, install one signed version and update to a newer one. Check automatic relaunch, retained sign-in, cached conversations, and Done state.
