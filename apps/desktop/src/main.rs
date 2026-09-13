use std::{cell::RefCell, rc::Rc, time::Duration};

use afterglide_core::{ConnectStage, Console, Event, PowerState, SessionMachine, SessionState};

slint::include_modules!();

fn main() -> Result<(), slint::PlatformError> {
    let app = AppWindow::new()?;
    let console = Console {
        id: "living-room".into(),
        name: "Living Room Xbox".into(),
        power: PowerState::Standby,
    };
    let machine = Rc::new(RefCell::new(SessionMachine::new(SessionState::Ready {
        console,
    })));

    app.set_status_text("Ready from standby".into());

    app.on_play_requested({
        let weak = app.as_weak();
        let machine = machine.clone();
        move || begin_simulated_connection(weak.clone(), machine.clone())
    });

    app.on_settings_requested({
        let weak = app.as_weak();
        move || {
            if let Some(app) = weak.upgrade() {
                app.set_toast_text("Settings are coming in the next slice".into());
                app.set_toast_visible(true);
            }
        }
    });

    app.on_diagnostics_requested({
        let weak = app.as_weak();
        move || {
            if let Some(app) = weak.upgrade() {
                app.set_toast_text("Network check: excellent · 5 GHz".into());
                app.set_toast_visible(true);
            }
        }
    });

    app.on_quit_requested({
        let weak = app.as_weak();
        move || {
            if let Some(app) = weak.upgrade() {
                let _ = app.hide();
            }
        }
    });

    app.run()
}

fn begin_simulated_connection(weak: slint::Weak<AppWindow>, machine: Rc<RefCell<SessionMachine>>) {
    if machine.borrow_mut().apply(Event::PlayRequested).is_err() {
        return;
    }
    render_state(&weak, &machine.borrow());

    slint::Timer::single_shot(Duration::from_millis(650), {
        let weak = weak.clone();
        let machine = machine.clone();
        move || {
            let _ = machine.borrow_mut().apply(Event::ConsoleWoken);
            render_state(&weak, &machine.borrow());

            slint::Timer::single_shot(Duration::from_millis(650), {
                let weak = weak.clone();
                let machine = machine.clone();
                move || {
                    let _ = machine.borrow_mut().apply(Event::ConnectionNegotiated);
                    render_state(&weak, &machine.borrow());

                    slint::Timer::single_shot(Duration::from_millis(800), move || {
                        let _ = machine.borrow_mut().apply(Event::StreamStarted {
                            session_id: "preview-session".into(),
                        });
                        render_state(&weak, &machine.borrow());
                    });
                }
            });
        }
    });
}

fn render_state(weak: &slint::Weak<AppWindow>, machine: &SessionMachine) {
    let Some(app) = weak.upgrade() else {
        return;
    };

    match machine.state() {
        SessionState::Connecting { stage, .. } => {
            app.set_is_connecting(true);
            app.set_is_streaming(false);
            app.set_status_text(stage.label().into());
            app.set_progress(match stage {
                ConnectStage::WakingConsole => 0.28,
                ConnectStage::Negotiating => 0.60,
                ConnectStage::StartingVideo => 0.86,
            });
        }
        SessionState::Streaming { .. } => {
            app.set_is_connecting(false);
            app.set_is_streaming(true);
            app.set_status_text("Preview connected".into());
            app.set_progress(1.0);
            app.set_toast_text("Streaming adapter is simulated in this build".into());
            app.set_toast_visible(true);
        }
        _ => {}
    }
}
