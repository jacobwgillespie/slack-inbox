# Slack Inbox

A keyboard-driven inbox for Slack DMs and channels. Browse cached history, reply, and press E to mark a conversation read and move it to Done. New messages bring it back to the inbox.

## Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps?new_app=1) and choose **Create New App → From a manifest**. Paste the contents of `slack-app-manifest.json`.
2. Install the app to your workspace.
3. Copy the **User OAuth Token** (it starts with `xoxp-`) into `.env.local`:

   ```sh
   cp .env.example .env.local
   ```

4. Install dependencies and start the app:

   ```sh
   pnpm install
   pnpm dev
   ```

The app needs Node.js 22.13 or later.

React Compiler runs in development and production through Vite's `reactCompilerPreset`, targeting React 19. Components use TanStack DB live queries for data, `useStore` for interaction state, and `inboxStore` for imperative command access. The compiler leaves unsupported functions, including hooks with `try/finally`, unoptimized.

A native macOS prototype built with GPUI is in [`gpui/`](gpui/README.md). It works on its own, without this web app.

## Electron desktop experiment

Run `pnpm desktop` to install Electron's runtime, build the app, and open the desktop window. If `.env.local` already has `SLACK_SESSION_TOKEN` and `SLACK_SESSION_COOKIE`, the desktop shell validates that session and reuses its Slack cookie automatically. Otherwise, use **Open Slack to sign in** for the first login. After signing in, return with **Back to Inbox**.

The separate Chrome login is experimental: a fresh profile with debugging enabled may trigger repeated CAPTCHA challenges. Prefer the configured-session path when available.

For macOS SSO requiring an existing passkey, choose **Sign in with Chrome / passkey**. This opens the installed Google Chrome in a dedicated `userData/signin-chrome` profile, where you can choose a physical security key or scan Chrome's QR code and use a passkey on your phone. Your regular Chrome profile and its extensions are not used. Once Slack opens, the app imports only Slack-domain cookies into its embedded profile, closes the dedicated Chrome window, and resumes sync automatically. Rippling/other SSO cookies remain in the dedicated browser profile. Communication uses a private DevTools pipe, with no debugging port. Set `SLACK_SIGNIN_CHROME` to override the Chrome executable path. The default path targets macOS.

Electron 44's macOS Touch ID credentials belong to the app and cannot use your existing Rippling passkey, so native `configureWebAuthn({ touchID: ... })` is not enabled. The ordinary `pnpm dev` browser version still works with its existing credentials.

The desktop shell hosts the React app and a separate, sandboxed Slack `WebContentsView`. Slack cookies and storage persist in the app's own profile. The shell captures Slack's session token from its API requests in memory and uses that profile's Chromium network stack for API calls and image downloads. It does not copy credentials into `.env.local` or expose them to React.

The avatar menu contains Help and Log out. Logging out clears the embedded Slack login and the dedicated Chrome sign-in profile, then restarts at sign-in. It also disables automatic import of `.env.local` credentials for future desktop launches. Your regular Chrome profile is unaffected. Local conversation and Done state remain available when you sign back into the same account; signing into a different account clears the previous workspace cache.

Slack's own WebSocket frames feed messages, edits, deletions, reactions, and read markers into the existing sync engine. Our sync engine does not open its own realtime socket; each embedded Slack view manages its normal connection. SQLite still supplies the UI, caches image bytes and history pages, and records history coverage. Polling and reconnection checks remain available when observed realtime updates stop.

**Open Slack** in a conversation explicitly reveals that conversation in the real Slack client, where its composer provides mentions, slash commands, and other workflows. Selecting DMs or channels in our viewer does not navigate Slack. Composer contents and keystrokes are not mirrored; the two editors retain independent drafts. Opening the real Slack client can mark its active conversation read as Slack normally does.

This first experiment targets one workspace. It uses a separate database at Electron's `userData/slack.sqlite`, so it can run alongside the browser app without two engines writing the same cache. Override it with `SLACK_DESKTOP_DATABASE_PATH`. The local renderer uses port 5174; override with `SLACK_DESKTOP_PORT` if needed. `pnpm desktop:build` builds without launching; after building, `pnpm exec electron electron-dist/main.cjs` launches directly.

The configured-session path has been verified against the live workspace, including authenticated sync and the embedded realtime connection. The fresh Chrome SSO path remains experimental. This is a development shell, with no packaged installer yet.

## How it works

The Vite server runs a sync process that copies your Slack data into a local SQLite database at `data/slack.sqlite`. The browser reads the inbox from this database and never calls Slack directly. Your token stays in the server.

- Users, custom emoji, and the list of conversations refresh once an hour.
- With a session token, the server keeps a real-time connection to Slack. New messages, edits, deletions, reactions, and conversations you read in other Slack apps appear at once. A full check of unread state also runs every 5 minutes, and after each reconnection, to catch anything the connection missed. The header shows **Live** while the connection is open.
- With a user token, Slack does not offer a real-time connection, so the server checks unread state continuously.
- Unread message history is fetched only for conversations that have new messages. DM and channel history loads when you open a conversation or scroll to an earlier page.
- When you mark a conversation as read or send a reply, the server updates Slack and the database.
- The server tells the browser when data changes, so the inbox updates without a reload.

Image attachments load inline as you scroll. The server authenticates downloads and caches previews in SQLite; your token stays out of the browser. If a preview is unavailable, the attachment remains a link to Slack. User OAuth tokens need the `files:read` scope from the app manifest; existing installations need to be reinstalled after adding that scope.

Because the server does this work, the browser app only runs through `pnpm dev` or `pnpm preview`, not as static files. To start again with an empty database, stop the server and delete the `data` directory. To store the database somewhere else, set `SLACK_DATABASE_PATH` in `.env.local`.

## Faster scans with a session token (optional)

With a user token, Slack does not report which conversations are unread. The app must call `conversations.info` once for each conversation, and Slack allows about 50 of these calls each minute. If you belong to 600 conversations, each scan takes about 12 minutes. The inbox shows the last result from the database while the scan runs.

A browser session token lets the app ask Slack for all unread conversations in one request (`client.counts`), so a scan takes a few seconds. It also lets the app receive updates in real time (`rtm.connect`).

To get the session token:

1. Open [app.slack.com](https://app.slack.com) in a browser and sign in to the workspace.
2. Open the developer tools console and run:

   ```js
   Object.values(JSON.parse(localStorage.localConfig_v2).teams).map((team) => [team.name, team.token])
   ```

   Copy the token for your workspace. It starts with `xoxc-`.

3. In the developer tools, go to **Application → Cookies → https://app.slack.com**. Copy the value of the `d` cookie exactly as shown. It starts with `xoxd-`.
4. Add both values to `.env.local` and restart the development server:

   ```sh
   SLACK_SESSION_TOKEN=xoxc-...
   SLACK_SESSION_COOKIE=xoxd-...
   ```

When a session token is set, the app uses it instead of `SLACK_USER_TOKEN`.

Before you use a session token, know that:

- `client.counts`, `subscriptions.thread.*`, `saved.*`, and `users.prefs.*` are not documented Slack APIs, and `rtm.connect` is deprecated for Slack apps. Slack can change or block any of them at any time.
- The token has full access to your account, not only the scopes in the manifest. Keep `.env.local` private.
- The token stops working when you sign out of that browser session. You must then copy new values.
- Your workspace's security policy may not allow this.

## Message classifier (optional)

If `OPENAI_API_KEY` is set in `.env.local`, the server asks an OpenAI model to sort each new unread message into Important or Other. The default model is `gpt-6-luna`. To use a different model, set `OPENAI_CLASSIFIER_MODEL`.

- The server sends unread messages from the last 7 days in groups of up to 25. It sends the message text, the conversation name, the author, and whether the message mentions you.
- The model records each decision with a short reason. The result is saved in the local database, so each message is sorted only once. Select a message to see the label, and hold the pointer over the label to see the reason.
- A conversation is in Important if any of its unread messages is important. Messages that are not sorted yet use the built-in rules: direct messages, group messages, and mentions are important.
- The model can read the local database with SQL to get more context, for example earlier messages in the conversation. It cannot change the database, except to record decisions and memories.
- Press `C` to move a conversation to the other view. The model receives your correction on its next run and can save a memory, such as "Messages in #announcements are important." It includes all memories every time it sorts messages. Memories are stored in the `memories` table in the database.

Message text and the context the model reads are sent to OpenAI.

## Views

The selector contains **DMs**, **Channels**, and **Done**. DMs and Channels show conversations you have not explicitly marked done, including conversations already read in Slack. Both lists sort by latest activity. Channels includes joined public and private channels.

Press **E** or select **Mark done** to mark a conversation read in Slack and move it to Done. SQLite records the conversation ID and the last message timestamp at that moment. Any newer message, including one you send, returns the conversation to its DM or channel list. Edits and reactions on existing messages do not reopen it. Done combines archived DMs and channels; press **E** there to restore a conversation without changing its Slack read position. **Z** undoes the last archive or restore. Marking a conversation read in another Slack client does not archive it here.

Opening a conversation shows its latest messages. React Activities retain the eight most recently opened panels, scroll positions, and unsent drafts. Scroll up to load older pages while keeping your position. Hover a bubble to reply in a thread. Swipe or drag left to reveal timestamps; they spring closed on release. Channels and group DMs show other participants' names above each message group, while one-to-one DMs omit names.

Cached history and archive markers survive app restarts. Background sync collects new messages and fills older history without navigating our visible UI. Collection errors leave cached messages readable and offer **Retry sync**.

## Keyboard shortcuts

| Key             | Action                                                   |
| --------------- | -------------------------------------------------------- |
| `J` / `K`       | Next or previous conversation    |
| `Enter` / `O`   | Read conversation    |
| `Esc`           | Return to list, clear selection, or cancel thread reply  |
| `E`             | Mark done and read; in Done, restore to inbox           |
| `M`             | Mute or unmute                                           |
| `Z`             | Undo the last action                                     |
| `R`             | Reply in the conversation                                |
| `T`             | Reply in the thread of the latest message               |
| `U`             | Open in Slack                                            |
| `Tab` / `1`–`3` | Switch between DMs, Channels, and Done                    |
| `Shift+R`       | Refresh                                                  |
| `?`             | Show all shortcuts                                       |

Sending a reply marks the conversation read and keeps it open. Only an explicit Done action archives it.

Viewing a conversation at the bottom marks its latest displayed messages read. Viewing older history keeps newer messages unread.

## Limits

- Unread replies in threads you follow need a session token. With only a user token, the inbox shows unread top-level messages only. You can still expand threads and reply in them.
- The inbox loads up to 100 unread messages for each conversation. The **DMs** and **Channels** views load additional history as you scroll.
- With a user token, each scan checks every conversation you belong to, which takes minutes in a large workspace. Direct messages are checked first. See [Faster scans with a session token](#faster-scans-with-a-session-token-optional).

### Desktop conversation sync

The Electron DM and channel views read a durable SQLite cache through TanStack DB live collections. Switching conversations does not navigate Slack or wait for its DOM. React Activities retain the eight most recently opened panels and their scroll positions. The browser version continues to use API-backed SQLite history.

A dedicated background Slack view collects rendered messages into SQLite, keyed by conversation ID and Slack message timestamp. It is separate from the Slack view opened by **Open Slack**, so inspecting Slack does not interrupt collection. A MutationObserver reports rendered changes immediately. The collector prioritizes the selected conversation, incoming unread messages observed on Slack's realtime connection, then visible sidebar rows. Visible conversations with stale caches are refreshed when the sidebar reports them; unchanged caches younger than a minute are reused.

History collection reads overlapping virtualized windows, yields between batches of four, and resumes at its cached message timestamp. Visible threads continue backfilling in the background; scrolling our timeline reads cached pages of 100 before requesting more collection. Newer messages stay in SQLite and in the UI when older pages arrive. Collection errors leave cached messages readable and expose **Retry sync**. Only Slack's rendered beginning-of-conversation marker marks a history complete. Background HTTP and WebSocket read-marker writes are blocked, including in the manual view while it is hidden; explicit read actions and the visible manual Slack view continue to work normally.

TanStack DB owns the reactive message, DM, channel, inbox, saved-item, and user collections used by the UI. SQLite remains their persistent source. The existing Zustand command layer still handles selection, drafts, shortcuts, and optimistic inbox actions, publishing its domain snapshots into those collections. Incoming realtime events update SQLite and active collections immediately, while the collector supplements them with rendered rich content. Image previews are also persisted in SQLite.

Sending, marking read, workspace discovery, and inbox synchronization still use the existing API transport. This is not a complete replacement for Slack's API surface: rich text, reactions, and images are extracted from the DOM, while complex app cards and unfurls still need adapters. First visits suspend until local cache hydration or the first collected page is ready, retaining the previous conversation during navigation. Image previews for recently collected messages are warmed in the background. One collector keeps Slack rendering and request load bounded; additional workers are not yet needed for cached navigation.
