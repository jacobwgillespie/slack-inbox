# Slack Inbox for macOS (prototype)

A native version of the inbox, built with [GPUI](https://gpui.rs) and [GPUI Kit](https://gpui-kit.com). It does not need the web app or its server. It connects to Slack, stores data in SQLite, keeps a real-time connection, and runs the classifier itself.

## Run

```sh
cd gpui
cargo run --release
```

`rust-toolchain.toml` selects Rust 1.98.1, because GPUI needs a newer compiler than 1.94.

## Configuration

The app reads `.env.local` from the current directory or the nearest parent directory that has one. When you run it from `gpui/`, it uses the same `.env.local` as the web app. The variables are the same:

| Variable                 | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `SLACK_USER_TOKEN`       | User OAuth token (`xoxp-`)                                        |
| `SLACK_SESSION_TOKEN`    | Optional browser session token (`xoxc-`) for fast scans and real-time updates |
| `SLACK_SESSION_COOKIE`   | The `d` cookie (`xoxd-`) that goes with the session token          |
| `OPENAI_API_KEY`         | Optional. Turns on the classifier                                 |
| `OPENAI_CLASSIFIER_MODEL`| Optional. The default is `gpt-6-luna`                             |
| `SLACK_DATABASE_PATH`    | Optional. The default is `data/slack.sqlite` next to `.env.local` |

The database schema is the same as the web app's, so both apps can use the same file. If both run at the same time, both sync with Slack.

## Keyboard shortcuts

Press `?` in the app to see all shortcuts. They match the web app: `J`/`K` to move, `Enter` to read, `E` to mark as read, `L` for Later, `M` to mute, `C` to move between Important and Other, `R` and `T` to reply, `Z` to undo, and `Tab` or `1`–`4` to change view.

## Check the engine without the window

```sh
cargo run --example print_inbox -- 10
```

This starts the sync engine, waits 10 seconds, and prints the inbox.

## Differences from the web app

- Messages show plain text. Formatting such as bold and code is not rendered, and custom emoji show as their names.
- The app does not show avatars.
