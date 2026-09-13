//! Platform-independent session state for Afterglide.
//!
//! UI, Xbox protocol, and media implementations communicate through events and
//! commands. Keeping policy here makes reconnection behavior deterministic and
//! lets us test it without a console or display server.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Console {
    pub id: String,
    pub name: String,
    pub power: PowerState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PowerState {
    Online,
    Standby,
    Offline,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectStage {
    WakingConsole,
    Negotiating,
    StartingVideo,
}

impl ConnectStage {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::WakingConsole => "Waking your Xbox",
            Self::Negotiating => "Securing the connection",
            Self::StartingVideo => "Starting video",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    #[default]
    SignedOut,
    Discovering,
    Ready {
        console: Console,
    },
    Connecting {
        console: Console,
        stage: ConnectStage,
    },
    Streaming {
        console: Console,
        session_id: String,
    },
    Recovering {
        console: Console,
        attempt: u8,
    },
    Failed {
        console: Option<Console>,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    SignedIn,
    ConsoleFound(Console),
    PlayRequested,
    ConsoleWoken,
    ConnectionNegotiated,
    StreamStarted { session_id: String },
    StreamInterrupted,
    RecoverySucceeded { session_id: String },
    RecoveryFailed,
    DisconnectRequested,
    Failed { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    DiscoverConsoles,
    WakeConsole { console_id: String },
    NegotiateSession { console_id: String },
    StartMedia,
    AttemptRecovery { attempt: u8 },
    StopMedia,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error("event {event} is invalid while {state}")]
    InvalidEvent {
        event: &'static str,
        state: &'static str,
    },
}

#[derive(Default)]
pub struct SessionMachine {
    state: SessionState,
}

impl SessionMachine {
    #[must_use]
    pub const fn new(state: SessionState) -> Self {
        Self { state }
    }

    #[must_use]
    pub const fn state(&self) -> &SessionState {
        &self.state
    }

    pub fn apply(&mut self, event: Event) -> Result<Vec<Command>, TransitionError> {
        use Command as Cmd;
        use ConnectStage as Stage;
        use Event as Ev;
        use SessionState as State;

        let current = std::mem::take(&mut self.state);
        let (next, commands) = match (current, event) {
            (State::SignedOut, Ev::SignedIn) => (State::Discovering, vec![Cmd::DiscoverConsoles]),
            (State::Discovering, Ev::ConsoleFound(console)) => (State::Ready { console }, vec![]),
            (State::Ready { console }, Ev::PlayRequested) => {
                let command = match console.power {
                    PowerState::Online => Cmd::NegotiateSession {
                        console_id: console.id.clone(),
                    },
                    _ => Cmd::WakeConsole {
                        console_id: console.id.clone(),
                    },
                };
                let stage = match console.power {
                    PowerState::Online => Stage::Negotiating,
                    _ => Stage::WakingConsole,
                };
                (State::Connecting { console, stage }, vec![command])
            }
            (
                State::Connecting {
                    console,
                    stage: Stage::WakingConsole,
                },
                Ev::ConsoleWoken,
            ) => {
                let command = Cmd::NegotiateSession {
                    console_id: console.id.clone(),
                };
                (
                    State::Connecting {
                        console,
                        stage: Stage::Negotiating,
                    },
                    vec![command],
                )
            }
            (
                State::Connecting {
                    console,
                    stage: Stage::Negotiating,
                },
                Ev::ConnectionNegotiated,
            ) => (
                State::Connecting {
                    console,
                    stage: Stage::StartingVideo,
                },
                vec![Cmd::StartMedia],
            ),
            (State::Connecting { console, .. }, Ev::StreamStarted { session_id }) => (
                State::Streaming {
                    console,
                    session_id,
                },
                vec![],
            ),
            (State::Streaming { console, .. }, Ev::StreamInterrupted) => (
                State::Recovering {
                    console,
                    attempt: 1,
                },
                vec![Cmd::AttemptRecovery { attempt: 1 }],
            ),
            (State::Recovering { console, .. }, Ev::RecoverySucceeded { session_id }) => (
                State::Streaming {
                    console,
                    session_id,
                },
                vec![],
            ),
            (State::Recovering { console, attempt }, Ev::RecoveryFailed) if attempt < 3 => {
                let next_attempt = attempt + 1;
                (
                    State::Recovering {
                        console,
                        attempt: next_attempt,
                    },
                    vec![Cmd::AttemptRecovery {
                        attempt: next_attempt,
                    }],
                )
            }
            (State::Recovering { console, .. }, Ev::RecoveryFailed) => (
                State::Failed {
                    console: Some(console),
                    message: "We couldn't restore the stream. Your Xbox is still available.".into(),
                },
                vec![Cmd::StopMedia],
            ),
            (State::Streaming { console, .. }, Ev::DisconnectRequested) => {
                (State::Ready { console }, vec![Cmd::StopMedia])
            }
            (state, Ev::Failed { message }) => {
                let console = console_from(&state).cloned();
                (State::Failed { console, message }, vec![Cmd::StopMedia])
            }
            (state, event) => {
                let error = TransitionError::InvalidEvent {
                    event: event_name(&event),
                    state: state_name(&state),
                };
                self.state = state;
                return Err(error);
            }
        };

        self.state = next;
        Ok(commands)
    }
}

fn console_from(state: &SessionState) -> Option<&Console> {
    match state {
        SessionState::Ready { console }
        | SessionState::Connecting { console, .. }
        | SessionState::Streaming { console, .. }
        | SessionState::Recovering { console, .. } => Some(console),
        SessionState::Failed { console, .. } => console.as_ref(),
        SessionState::SignedOut | SessionState::Discovering => None,
    }
}

const fn event_name(event: &Event) -> &'static str {
    match event {
        Event::SignedIn => "signed in",
        Event::ConsoleFound(_) => "console found",
        Event::PlayRequested => "play requested",
        Event::ConsoleWoken => "console woken",
        Event::ConnectionNegotiated => "connection negotiated",
        Event::StreamStarted { .. } => "stream started",
        Event::StreamInterrupted => "stream interrupted",
        Event::RecoverySucceeded { .. } => "recovery succeeded",
        Event::RecoveryFailed => "recovery failed",
        Event::DisconnectRequested => "disconnect requested",
        Event::Failed { .. } => "failed",
    }
}

const fn state_name(state: &SessionState) -> &'static str {
    match state {
        SessionState::SignedOut => "signed out",
        SessionState::Discovering => "discovering",
        SessionState::Ready { .. } => "ready",
        SessionState::Connecting { .. } => "connecting",
        SessionState::Streaming { .. } => "streaming",
        SessionState::Recovering { .. } => "recovering",
        SessionState::Failed { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn console(power: PowerState) -> Console {
        Console {
            id: "living-room".into(),
            name: "Living Room Xbox".into(),
            power,
        }
    }

    #[test]
    fn standby_console_flows_through_wake_to_stream() {
        let mut machine = SessionMachine::default();

        assert_eq!(
            machine.apply(Event::SignedIn),
            Ok(vec![Command::DiscoverConsoles])
        );
        assert_eq!(
            machine.apply(Event::ConsoleFound(console(PowerState::Standby))),
            Ok(vec![])
        );
        assert_eq!(
            machine.apply(Event::PlayRequested),
            Ok(vec![Command::WakeConsole {
                console_id: "living-room".into()
            }])
        );
        assert_eq!(
            machine.apply(Event::ConsoleWoken),
            Ok(vec![Command::NegotiateSession {
                console_id: "living-room".into()
            }])
        );
        assert_eq!(
            machine.apply(Event::ConnectionNegotiated),
            Ok(vec![Command::StartMedia])
        );
        assert_eq!(
            machine.apply(Event::StreamStarted {
                session_id: "session-1".into()
            }),
            Ok(vec![])
        );
        assert!(matches!(machine.state(), SessionState::Streaming { .. }));
    }

    #[test]
    fn online_console_skips_wake() {
        let mut machine = SessionMachine::new(SessionState::Ready {
            console: console(PowerState::Online),
        });

        assert_eq!(
            machine.apply(Event::PlayRequested),
            Ok(vec![Command::NegotiateSession {
                console_id: "living-room".into()
            }])
        );
    }

    #[test]
    fn recovery_stops_after_three_attempts() {
        let mut machine = SessionMachine::new(SessionState::Streaming {
            console: console(PowerState::Online),
            session_id: "session-1".into(),
        });

        assert_eq!(
            machine.apply(Event::StreamInterrupted),
            Ok(vec![Command::AttemptRecovery { attempt: 1 }])
        );
        assert_eq!(
            machine.apply(Event::RecoveryFailed),
            Ok(vec![Command::AttemptRecovery { attempt: 2 }])
        );
        assert_eq!(
            machine.apply(Event::RecoveryFailed),
            Ok(vec![Command::AttemptRecovery { attempt: 3 }])
        );
        assert_eq!(
            machine.apply(Event::RecoveryFailed),
            Ok(vec![Command::StopMedia])
        );
        assert!(matches!(machine.state(), SessionState::Failed { .. }));
    }

    #[test]
    fn invalid_event_preserves_state() {
        let mut machine = SessionMachine::default();

        assert!(machine.apply(Event::PlayRequested).is_err());
        assert_eq!(machine.state(), &SessionState::SignedOut);
    }
}
