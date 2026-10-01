<img src="public/icon.png" alt="Slack Inbox app icon" width="96" height="96">

# Slack Inbox

An unofficial macOS app for working through your Slack conversations. Read and reply, save messages for later, and mark conversations done without losing their history.

## Install

Slack Inbox supports Apple Silicon and Intel Macs. Public releases are not available yet; see [Development](DEVELOPMENT.md) to run the app from source.

When installing a packaged build from [GitHub Releases](https://github.com/jacobwgillespie/slack-inbox/releases):

1. Choose the `arm64.dmg` for Apple Silicon or `x64.dmg` for Intel.
2. Open the DMG and drag **Slack Inbox** into **Applications**.
3. Open the app and choose **Sign in to Slack**. Complete sign-in in your browser, then return to Slack Inbox.

You don't need to create a Slack app or copy an API token. Your sign-in persists between launches.

## Use your inbox

The sidebar has three lists:

- **Inbox** contains DMs, group messages, and joined channels you haven't marked done, including conversations already read in Slack.
- **Later** contains messages you've saved for later.
- **Done** contains conversations you've finished handling.

Press **E** to mark a conversation read in Slack and move it to Done. A new message returns it to Inbox; edits and reactions don't. Press **E** in Done to restore a conversation, or **Z** to undo the last action. Reading a conversation in another Slack client doesn't mark it done here.

Open a conversation to read its cached history. Scroll up for earlier messages, hover a message to reply in a thread, and swipe or drag left to reveal timestamps. Reading at the bottom marks the displayed messages read; browsing older history leaves newer messages unread. Sending a reply keeps the conversation open.

Press **L** to save a message for later. Choose **Open Slack** when you need the full Slack interface; it shares your current draft and sign-in. Cached messages remain readable if sync fails. Choose **Retry sync** to try again.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `J` / `K` or `↓` / `↑` | Next or previous conversation |
| `Enter` / `O` | Read conversation |
| `Esc` | Return to the list, clear selection, or cancel a thread reply |
| `E` | Mark done and read; in Done, restore to Inbox |
| `L` | Save a message for later |
| `M` | Mute or unmute a conversation in Slack |
| `Z` | Undo the last action |
| `R` | Reply in the conversation |
| `T` | Reply in a thread |
| `U` | Open Slack |
| `Tab` / `Shift+Tab` | Next or previous list |
| `1` / `2` / `3` | Inbox, Later, or Done |
| `Shift+R` | Refresh |
| `?` | Show keyboard shortcuts |

The avatar menu also contains **Welcome**, **Help**, and **Log out**.

## Updates

Slack Inbox checks for updates at startup and every four hours. You can also choose **Slack Inbox → Check for Updates…**.

Updates download in the background. When one is ready, a white download button appears beside Refresh. Click it to restart and install the update, or let it install when you quit. Your sign-in, cached conversations, and Done state stay on your Mac.

## Your data

Slack Inbox keeps its own Slack sign-in and a local cache of conversations, images, and inbox state. Marking messages read, replying, reacting, muting, and saving for later update your Slack account.

**Log out** clears the app's Slack sign-in. Cached conversations and Done state remain available when you sign back into the same account. Signing into a different account clears the previous workspace cache.

## Current limits

- One workspace at a time; macOS only.
- Workspaces requiring device-bound sign-in aren't supported yet.
- Some Slack content and composer controls, including complex app cards, file dialogs, and media controls, aren't fully integrated. Use **Open Slack** for these interactions.

For source setup, architecture, packaging, and releases, see [Development](DEVELOPMENT.md).
