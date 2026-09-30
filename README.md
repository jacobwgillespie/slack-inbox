# Slack Inbox

A keyboard-driven inbox for unread Slack messages. Each conversation with unread messages is one row. Mark a row as read, save it for later, mute it, or reply without leaving the list.

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

The token stays on your computer. The Vite server forwards requests from `/api/*` to `https://slack.com/api/*` and adds the token to each request. The browser never receives the token. For this reason the app only runs through `pnpm dev` or `pnpm preview`, not as static files.

## Faster scans with a session token (optional)

With a user token, Slack does not report which conversations are unread. The app must call `conversations.info` once for each conversation, and Slack allows about 50 of these calls each minute. If you belong to 600 conversations, each scan takes about 12 minutes. The app saves the last result in the browser, so it shows the inbox at once and updates it as the scan runs.

A browser session token lets the app ask Slack for all unread conversations in one request (`client.counts`). A scan then takes a few seconds.

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

- `client.counts` is not a documented Slack API. Slack can change or block it at any time.
- The token has full access to your account, not only the scopes in the manifest. Keep `.env.local` private.
- The token stops working when you sign out of that browser session. You must then copy new values.
- Your workspace's security policy may not allow this.

## Views

| View      | Contents                                                              |
| --------- | --------------------------------------------------------------------- |
| Important | Direct messages, group messages, and channels that mention you        |
| Other     | All other channels with unread messages                               |
| Later     | Conversations you saved for later. This list is stored in the browser |
| Muted     | Muted conversations that have unread messages                         |

## Keyboard shortcuts

| Key             | Action                                                   |
| --------------- | -------------------------------------------------------- |
| `J` / `K`       | Next or previous conversation (message while reading)    |
| `Enter` / `O`   | Read conversation; while reading, show thread replies    |
| `Esc`           | Return to list, clear selection, or cancel thread reply  |
| `E`             | Mark as read in Slack (in Later: remove from Later)      |
| `L`             | Save for later and mark as read in Slack                 |
| `M`             | Mute or unmute                                           |
| `X`             | Select for a bulk action                                 |
| `Z`             | Undo the last action                                     |
| `R`             | Reply in the conversation                                |
| `T`             | Reply in the thread of the current message               |
| `U`             | Open in Slack                                            |
| `Tab` / `1`–`4` | Change view                                              |
| `Shift+R`       | Refresh                                                  |
| `?`             | Show all shortcuts                                       |

Sending a reply also marks the conversation as read.

## Limits

- Slack's API does not report unread thread replies, so the inbox shows unread top-level messages only.
- Slack mutes are not visible through the API. Use `M` to mute conversations in this app.
- The app loads up to 100 unread messages for each conversation.
- With a user token, each scan checks every conversation you belong to, which takes minutes in a large workspace. Direct messages are checked first. See [Faster scans with a session token](#faster-scans-with-a-session-token-optional).
- The app refreshes every 5 minutes and when the window regains focus.
