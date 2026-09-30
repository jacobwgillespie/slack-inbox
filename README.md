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
- To find unread conversations, the app checks each conversation you belong to. In large workspaces the first load can take a minute because of Slack rate limits. Conversations appear as they load. The app refreshes every 5 minutes and when the window regains focus.
