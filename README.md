# Slack Inbox

A keyboard-driven inbox for unread Slack messages and a viewer for direct messages. Each unread conversation is one inbox row. Mark a row as read, save it for later, mute it, or reply without leaving the list. The **DMs** tab shows read and unread conversations with messages from both sides.

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

React Compiler runs in development and production through Vite's `reactCompilerPreset`, targeting React 19. Components use `useStore` for subscriptions and `inboxStore` for imperative Zustand access. The compiler leaves unsupported functions unoptimized; currently the webview polling hook and browser sign-in button are skipped because they contain `try/finally`.

A native macOS prototype built with GPUI is in [`gpui/`](gpui/README.md). It works on its own, without this web app.

## Electron desktop experiment

Run `pnpm desktop` to install Electron's runtime, build the app, and open the desktop window. If `.env.local` already has `SLACK_SESSION_TOKEN` and `SLACK_SESSION_COOKIE`, the desktop shell validates that session and reuses its Slack cookie automatically. Otherwise, use **Open Slack to sign in** for the first login. After signing in, return with **Back to Inbox**.

The separate Chrome login is experimental: a fresh profile with debugging enabled may trigger repeated CAPTCHA challenges. Prefer the configured-session path when available.

For macOS SSO requiring an existing passkey, choose **Sign in with Chrome / passkey**. This opens the installed Google Chrome in a dedicated `userData/signin-chrome` profile, where you can choose a physical security key or scan Chrome's QR code and use a passkey on your phone. Your regular Chrome profile and its extensions are not used. Once Slack opens, the app imports only Slack-domain cookies into its embedded profile, closes the dedicated Chrome window, and resumes sync automatically. Rippling/other SSO cookies remain in the dedicated browser profile. Communication uses a private DevTools pipe, with no debugging port. Set `SLACK_SIGNIN_CHROME` to override the Chrome executable path. The default path targets macOS.

Electron 44's macOS Touch ID credentials belong to the app and cannot use your existing Rippling passkey, so native `configureWebAuthn({ touchID: ... })` is not enabled. The ordinary `pnpm dev` browser version still works with its existing credentials.

The desktop shell hosts the React app and a separate, sandboxed Slack `WebContentsView`. Slack cookies and storage persist in the app's own profile. The shell captures Slack's session token from its API requests in memory and uses that profile's Chromium network stack for API calls and image downloads. It does not copy credentials into `.env.local` or expose them to React.

Slack's own WebSocket frames feed messages, edits, deletions, reactions, and read markers into the existing sync engine. No second realtime socket is opened. SQLite still supplies the UI, caches image bytes and history pages, and records history coverage. Polling and reconnection checks remain available when observed realtime updates stop.

**Open Slack** in a conversation explicitly reveals that conversation in the real Slack client, where its composer provides mentions, slash commands, and other workflows. Selecting DMs in our viewer does not navigate Slack. Composer contents and keystrokes are not mirrored; the two editors retain independent drafts. Opening the real Slack client can mark its active conversation read as Slack normally does.

This first experiment targets one workspace. It uses a separate database at Electron's `userData/slack.sqlite`, so it can run alongside the browser app without two engines writing the same cache. Override it with `SLACK_DESKTOP_DATABASE_PATH`. The local renderer uses port 5174; override with `SLACK_DESKTOP_PORT` if needed. `pnpm desktop:build` builds without launching; after building, `pnpm exec electron electron-dist/main.cjs` launches directly.

The configured-session path has been verified against the live workspace, including authenticated sync and the embedded realtime connection. The fresh Chrome SSO path remains experimental. This is a development shell, with no packaged installer yet.

## How it works

The Vite server runs a sync process that copies your Slack data into a local SQLite database at `data/slack.sqlite`. The browser reads the inbox from this database and never calls Slack directly. Your token stays in the server.

- Users, custom emoji, and the list of conversations refresh once an hour.
- With a session token, the server keeps a real-time connection to Slack. New messages, edits, deletions, reactions, and conversations you read in other Slack apps appear at once. A full check of unread state also runs every 5 minutes, and after each reconnection, to catch anything the connection missed. The header shows **Live** while the connection is open.
- With a user token, Slack does not offer a real-time connection, so the server checks unread state continuously.
- Unread message history is fetched only for conversations that have new messages. DM history loads when you open a conversation or scroll to an earlier page.
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

| View      | Contents                                                                           |
| --------- | ---------------------------------------------------------------------------------- |
| Important | Direct messages, group messages, channels that mention you, and threads you follow |
| Other     | All other channels with unread messages                                            |
| Later     | Messages in your Slack **Later** list                                              |
| Muted     | Muted conversations that have unread messages                                      |
| DMs       | All direct and group messages, including read and muted conversations              |

In **DMs**, opening a conversation shows its latest messages. The eight most recently opened DMs retain their rendered panels, scroll positions, and unsent drafts when you switch conversations. Hidden panels pause polling. Scroll up or select **Load earlier messages** to load older messages, 100 at a time. The app preserves your scroll position as messages load. The arrow above the composer returns you to the latest messages. Hover over a bubble to reply in a thread. Swipe or drag left to reveal timestamps on the right; they spring closed when you release. Group DMs show other participants' names at the start of each message group; one-to-one DMs omit sender names.

Fetched pages stay in SQLite across app restarts. The server tracks which time ranges are complete, so messages saved by the inbox do not hide gaps in history. Opening the sidebar does not fetch every DM's history. With a live connection, new messages update the cache immediately, and the selected conversation checks its latest page at most once every 5 minutes. Without a live connection, this check runs once a minute. Reconnecting also checks for missed messages. Earlier cached pages load without another Slack request.

With a session token, each thread you follow that has unread replies appears in Important as its own row. The row shows the thread's first message and the unread replies. Pressing `E` marks the thread as read in Slack, and `R` replies in the thread. Muting a channel does not hide its threads, which matches Slack's Threads view.

With a session token, Later and Muted use your Slack settings:

- The Later view shows the in-progress items from Slack's **Later** list, including items you save in Slack. Pressing `L` saves the newest message of a conversation to Slack's Later list and marks the conversation as read. Pressing `E` in the Later view marks the item complete in Slack.
- Pressing `M` mutes or unmutes the conversation in Slack. Conversations you mute in Slack also appear as muted here.

Mute changes made in Slack appear at once. Later changes made in Slack appear at the next full sync, within 5 minutes. With only a user token, Slack does not allow access to these settings, so the app keeps Later and Muted in the local database instead.

## Keyboard shortcuts

| Key             | Action                                                   |
| --------------- | -------------------------------------------------------- |
| `J` / `K`       | Next or previous conversation (message while reading)    |
| `Enter` / `O`   | Read conversation; while reading, show thread replies    |
| `Esc`           | Return to list, clear selection, or cancel thread reply  |
| `E`             | Mark as read in Slack (in Later: mark complete)          |
| `L`             | Save the newest message for later and mark as read       |
| `M`             | Mute or unmute                                           |
| `C`             | Move to Important or Other, and teach the classifier     |
| `X`             | Select for a bulk action                                 |
| `Z`             | Undo the last action                                     |
| `R`             | Reply in the conversation                                |
| `T`             | Reply in the thread of the current message               |
| `U`             | Open in Slack                                            |
| `Tab` / `1`–`5` | Change view                                              |
| `Shift+R`       | Refresh                                                  |
| `?`             | Show all shortcuts                                       |

Sending a reply also marks the conversation as read. In **DMs**, the conversation stays open after you send or mark it as read.

## Limits

- Unread replies in threads you follow need a session token. With only a user token, the inbox shows unread top-level messages only. You can still expand threads and reply in them.
- The inbox loads up to 100 unread messages for each conversation. The **DMs** view loads additional history as you scroll.
- With a user token, each scan checks every conversation you belong to, which takes minutes in a large workspace. Direct messages are checked first. See [Faster scans with a session token](#faster-scans-with-a-session-token-optional).

### Webview DM experiment

In Electron, selecting a DM navigates the background Slack view to that conversation. The message panel reads Slack's rendered timeline over a narrow IPC bridge, without reading SQLite history or making our own history API requests. It polls the DOM every 750 ms while active. Scroll upward at the start of our list, or choose **Show earlier messages**, to scroll Slack's virtualized list and read the resulting rows. **Open in Slack** reveals the underlying conversation for comparison.

This is a screen-content experiment: each active panel accumulates the rows observed in Slack in memory, so scrolling back does not discard newer messages. Scroll position is anchored to a message timestamp as older rows and images arrive. These observed messages are not stored in SQLite. The sidebar and user directory still use the existing SQLite sync, and sending still uses our API transport. Rich text, reactions, and image attachment links are extracted from the DOM; complex unfurls, app cards, and thread interactions need further adapters. The browser version continues to use SQLite-backed history.
