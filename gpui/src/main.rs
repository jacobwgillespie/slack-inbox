mod app;
mod format;
mod model;

use gpui_kit::component::Theme;
use gpui_kit::*;
use slack_inbox_gpui::engine::config::Config;

use crate::app::InboxView;

fn main() {
    let config = Config::load();
    for problem in &config.problems {
        eprintln!("Configuration problem: {problem}");
    }
    gpui_kit::application().with_assets(gpui_kit::assets::AllAssets).run(move |cx| {
        gpui_kit::init(cx);
        Theme::sync_system_appearance(None, cx);
        app::bind_keys(cx);
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1280.), px(820.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some("Slack Inbox".into()), ..Default::default() }),
            window_min_size: Some(size(px(800.), px(500.))),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| {
            let view = cx.new(|cx| InboxView::new(config, window, cx));
            window.focus(&view.read(cx).focus_handle(cx), cx);
            view
        })
        .expect("failed to open window");
        cx.activate(true);
    });
}
