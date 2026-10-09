import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppSnapshot,
  CloudTitle,
  ControllerTuning,
  StreamDescriptor,
} from "../shared/contracts";
import { Icon, type IconName } from "./icons";
import { useControllerNavigation } from "./hooks/use-controller-navigation";
import {
  CONTROLLER_CONTROL_GUIDE,
  KEYBOARD_CONTROL_GUIDE,
  LOCAL_CONTROL_SHORTCUTS,
  isLocalControlShortcut,
} from "./stream/input-schema";
import { StreamSurface } from "./stream/StreamSurface";
import {
  friendlyControllerName,
  selectController,
} from "./stream/controller-input";
import type { ControllerStatus } from "./stream/stream-engine";
import { QuickSettings } from "./components/QuickSettings";
import { StreamRecovery, type RecoveryState } from "./recovery";

type Page = "cloud" | "diagnostics" | "settings";
const CLOUD_PAGE_SIZE = 48;
const GAMEPAD_BUTTON_LABELS = [
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "LT",
  "RT",
  "View",
  "Menu",
  "L3",
  "R3",
  "D-pad up",
  "D-pad down",
  "D-pad left",
  "D-pad right",
  "Xbox",
] as const;

interface ControllerDiagnostic {
  id: string;
  index: number;
  name: string;
  mapping: string;
  buttons: number;
  axes: number[];
  pressed: string[];
  rumble: boolean;
}

function useControllerDiagnostics(): ControllerDiagnostic[] {
  const [controllers, setControllers] = useState<ControllerDiagnostic[]>([]);
  useEffect(() => {
    let previous = "";
    const refresh = () => {
      const next = Array.from(navigator.getGamepads())
        .filter((gamepad): gamepad is Gamepad => Boolean(gamepad?.connected))
        .map((gamepad) => ({
          id: gamepad.id,
          index: gamepad.index,
          name: friendlyControllerName(gamepad.id),
          mapping:
            gamepad.mapping === "standard" ? "Standard mapping" : "Raw mapping",
          buttons: gamepad.buttons.length,
          axes: gamepad.axes.map((axis) => Math.round(axis * 100) / 100),
          pressed: gamepad.buttons.flatMap((button, index) =>
            button.pressed || button.value > 0.18
              ? [GAMEPAD_BUTTON_LABELS[index] ?? `Button ${index + 1}`]
              : [],
          ),
          rumble: Boolean(gamepad.vibrationActuator),
        }));
      const signature = JSON.stringify(next);
      if (signature !== previous) {
        previous = signature;
        setControllers(next);
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 125);
    window.addEventListener("gamepadconnected", refresh);
    window.addEventListener("gamepaddisconnected", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("gamepadconnected", refresh);
      window.removeEventListener("gamepaddisconnected", refresh);
    };
  }, []);
  return controllers;
}

function useBackAction(onBack: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onBack]);
}

function DemoNotice({
  environment,
}: {
  environment: AppSnapshot["environment"];
}) {
  return environment === "test" ? (
    <p className="demo-notice" role="status">
      Demo mode — Simulated sign-in, games, stream and network measurements
    </p>
  ) : null;
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | undefined>(undefined);
  const [page, setPage] = useState<Page>("cloud");
  const [searchRequested, setSearchRequested] = useState(false);
  const [descriptor, setDescriptor] = useState<StreamDescriptor | undefined>(
    undefined,
  );
  const launchVersion = useRef(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [recoveryState, setRecoveryState] = useState<RecoveryState>({
    status: "idle",
    attempts: 0,
  });
  const [recovery] = useState(
    () =>
      new StreamRecovery<StreamDescriptor>({
        retry: () => window.afterglideCloud.retryStream(),
        onAttempt: () => setDescriptor(undefined),
        onRecovered: setDescriptor,
        onState: setRecoveryState,
      }),
  );

  useEffect(() => {
    let active = true;
    let receivedSnapshot = false;
    const unsubscribe = window.afterglideCloud.onSnapshot((value) => {
      receivedSnapshot = true;
      if (active) setSnapshot(value);
    });
    void window.afterglideCloud.getSnapshot().then((value) => {
      if (active && !receivedSnapshot) setSnapshot(value);
    });
    return () => {
      active = false;
      launchVersion.current++;
      recovery.cancel();
      unsubscribe();
    };
  }, [recovery]);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      recovery.setOnline(navigator.onLine);
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [recovery]);

  const stopStream = useCallback(async () => {
    launchVersion.current++;
    recovery.cancel();
    setDescriptor(undefined);
    await window.afterglideCloud.stopStream();
  }, [recovery]);

  const signedIn = snapshot?.auth.status === "signed-in";
  const inStream = Boolean(descriptor) && snapshot?.session.phase !== "error";
  const focusScope =
    page === "cloud" ? `${page}:${snapshot?.cloud.status}` : page;
  useControllerNavigation(
    Boolean(
      snapshot &&
      (page !== "cloud" ||
        (signedIn && snapshot.settings.onboardingComplete)) &&
      !inStream &&
      recoveryState.status === "idle" &&
      snapshot.session.phase !== "error" &&
      !isConnecting(snapshot),
    ),
    focusScope,
    snapshot?.settings.preferredControllerId,
  );

  useEffect(() => {
    const onBack = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        descriptor ||
        !snapshot ||
        recoveryState.status !== "idle"
      )
        return;
      if (
        !isConnecting(snapshot) &&
        snapshot.session.phase !== "error" &&
        snapshot.auth.status !== "waiting"
      ) {
        if (page !== "cloud") setPage("cloud");
        else if (snapshot.fullscreen)
          void window.afterglideCloud.setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onBack);
    return () => window.removeEventListener("keydown", onBack);
  }, [signedIn, descriptor, page, snapshot, stopStream, recoveryState.status]);

  useEffect(
    () =>
      window.afterglideCloud.onDesktopCommand((command) => {
        if (command === "controls" || (command === "settings" && descriptor)) {
          window.dispatchEvent(
            new CustomEvent("afterglide-desktop-controls", {
              detail: command === "settings" ? "show" : "toggle",
            }),
          );
          return;
        }
        if (
          !snapshot ||
          descriptor ||
          isConnecting(snapshot) ||
          snapshot.session.phase === "error" ||
          recoveryState.status !== "idle" ||
          ["waiting", "restoring"].includes(snapshot.auth.status)
        )
          return;
        if (command === "settings") setPage("settings");
        else if (signedIn && snapshot.settings.onboardingComplete) {
          setPage("cloud");
          setSearchRequested(true);
        }
      }),
    [snapshot, descriptor, recoveryState.status, signedIn],
  );

  useEffect(() => {
    if (!searchRequested || page !== "cloud") return;
    const input = document.querySelector<HTMLInputElement>(
      ".cloud-search input",
    );
    if (!input) return;
    input.focus();
    input.select();
    setSearchRequested(false);
  }, [searchRequested, page]);

  const startCloudStream = useCallback(
    async (titleId: string) => {
      if (!online) return;
      const version = ++launchVersion.current;
      recovery.begin();
      try {
        const stream = await window.afterglideCloud.startCloudStream(titleId);
        if (version === launchVersion.current) setDescriptor(stream);
      } catch {
        // The main-process snapshot contains the safe, actionable error.
      }
    },
    [recovery, online],
  );

  const retryStream = useCallback(() => {
    launchVersion.current++;
    setDescriptor(undefined);
    recovery.begin();
    recovery.interrupt("manual");
  }, [recovery]);

  useEffect(() => {
    if (snapshot?.session.phase === "recovering" && descriptor) {
      recovery.interrupt(descriptor.sessionId);
    }
    if (
      snapshot?.session.phase === "idle" ||
      (snapshot && snapshot.auth.status !== "signed-in")
    ) {
      launchVersion.current++;
      recovery.cancel();
      setDescriptor(undefined);
    }
  }, [snapshot?.session.phase, snapshot?.auth.status, descriptor, recovery]);

  const renderScreen = () => {
    if (!snapshot || snapshot.auth.status === "restoring")
      return <BootScreen />;
    if (
      page !== "cloud" &&
      !descriptor &&
      !isConnecting(snapshot) &&
      snapshot.session.phase !== "error" &&
      snapshot.auth.status !== "waiting" &&
      recoveryState.status === "idle"
    )
      return (
        <Shell snapshot={snapshot} page={page} onPage={setPage}>
          {page === "settings" ? (
            <SettingsPage
              snapshot={snapshot}
              onReviewSetup={() => {
                setPage("cloud");
                void window.afterglideCloud.updateSettings({
                  onboardingComplete: false,
                });
              }}
            />
          ) : (
            <DiagnosticsPage snapshot={snapshot} />
          )}
        </Shell>
      );
    if (
      snapshot.auth.status === "signed-out" ||
      snapshot.auth.status === "error"
    ) {
      return (
        <WelcomeScreen
          environment={snapshot.environment}
          error={snapshot.auth.error}
          onSettings={() => setPage("settings")}
          onSignIn={() => void window.afterglideCloud.beginSignIn()}
        />
      );
    }
    if (snapshot.auth.status === "waiting") {
      return <DeviceCodeScreen snapshot={snapshot} />;
    }
    if (!snapshot.settings.onboardingComplete) {
      return (
        <ReadinessScreen
          snapshot={snapshot}
          onComplete={() =>
            void window.afterglideCloud.updateSettings({
              onboardingComplete: true,
            })
          }
        />
      );
    }
    if (
      recoveryState.status !== "idle" &&
      (!descriptor || recoveryState.status === "exhausted" || !online)
    ) {
      return (
        <RecoveryScreen
          environment={snapshot.environment}
          state={recoveryState}
          online={online}
          preferredControllerId={snapshot.settings.preferredControllerId}
          onRetry={retryStream}
          onExit={() => void stopStream()}
        />
      );
    }
    if (snapshot.session.phase === "error") {
      return (
        <SessionErrorScreen
          snapshot={snapshot}
          onRetry={() => void retryStream()}
          onBack={() => void stopStream()}
        />
      );
    }
    if (
      descriptor &&
      ["negotiating", "streaming", "recovering"].includes(
        snapshot.session.phase,
      )
    ) {
      return (
        <StreamView
          snapshot={snapshot}
          descriptor={descriptor}
          online={online}
          recoveryState={recoveryState}
          onExit={stopStream}
        />
      );
    }
    if (isConnecting(snapshot))
      return (
        <ConnectingScreen
          snapshot={snapshot}
          onCancel={() => void stopStream()}
        />
      );

    return (
      <Shell snapshot={snapshot} page={page} onPage={setPage}>
        {page === "cloud" && (
          <CloudPage snapshot={snapshot} onPlay={startCloudStream} />
        )}
        {page === "diagnostics" && <DiagnosticsPage snapshot={snapshot} />}
        {page === "settings" && (
          <SettingsPage
            snapshot={snapshot}
            onReviewSetup={() => {
              setPage("cloud");
              void window.afterglideCloud.updateSettings({
                onboardingComplete: false,
              });
            }}
          />
        )}
      </Shell>
    );
  };
  const showFullscreenExit = Boolean(snapshot?.fullscreen && !descriptor);
  return (
    <div
      className={`desktop-frame ${snapshot?.settings.reducedMotion ? "reduced-motion" : ""}`}
    >
      {showFullscreenExit && (
        <header className="desktop-fullscreen-bar">
          <span>Afterglide Cloud</span>
          <button
            data-focusable
            onClick={() => void window.afterglideCloud.setFullscreen(false)}
          >
            Exit fullscreen
          </button>
        </header>
      )}
      <div
        className={`desktop-content ${showFullscreenExit ? "with-fullscreen-bar" : ""}`}
      >
        {renderScreen()}
      </div>
    </div>
  );
}

function BootScreen() {
  return (
    <main className="boot-screen" aria-live="polite">
      <BrandMark size="large" />
      <div className="boot-line">
        <span />
      </div>
      <p>Starting Afterglide Cloud</p>
    </main>
  );
}

function WelcomeScreen({
  environment,
  error,
  onSettings,
  onSignIn,
}: {
  environment: AppSnapshot["environment"];
  error?: string;
  onSettings: () => void;
  onSignIn: () => void;
}) {
  useControllerNavigation(true);
  return (
    <main className="welcome-screen">
      <div className="welcome-topline">
        <BrandLockup />
        <button
          className="text-action welcome-settings"
          data-focusable
          onClick={onSettings}
        >
          <Icon name="settings" /> Settings
        </button>
      </div>
      <section className="welcome-copy">
        <h1>
          Your cloud library.
          <br />
          <span>Ready when you are.</span>
        </h1>
        <p className="welcome-lede">
          A focused Xbox Cloud Gaming library for Windows and macOS. Choose a
          game, connect your controller, and play.
        </p>
        <DemoNotice environment={environment} />
        {error && (
          <div className="inline-error" role="alert">
            <Icon name="warning" />
            {error}
          </div>
        )}
        <button
          className="primary-action welcome-action"
          data-focusable
          data-autofocus
          onClick={onSignIn}
        >
          <span>Sign in with Microsoft</span>
          <ControllerHint label="A" />
          <Icon name="external" />
        </button>
        <p className="privacy-note">
          <Icon name="shield" /> Your Microsoft password is never seen by
          Afterglide Cloud.
        </p>
      </section>
      <WelcomeVisual />
      <div className="welcome-steps" aria-label="How Afterglide Cloud works">
        <Step
          number="01"
          label="Sign in"
          detail="Link securely with Microsoft"
        />
        <Step
          number="02"
          label="Choose a game"
          detail="Your Xbox cloud library"
        />
        <Step
          number="03"
          label="Play"
          detail="Video, audio, and controls together"
        />
      </div>
      <p className="legal-line">
        Afterglide Cloud is an independent client, not affiliated with Microsoft
        or Xbox.
      </p>
    </main>
  );
}

function DeviceCodeScreen({ snapshot }: { snapshot: AppSnapshot }) {
  const code = snapshot.auth.deviceCode;
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState("15:00");
  useEffect(() => {
    if (!code) return;
    const update = () => {
      const seconds = Math.max(
        0,
        Math.ceil((code.expiresAt - Date.now()) / 1_000),
      );
      setRemaining(
        `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
      );
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [code]);
  useControllerNavigation(true, code ? "ready" : "waiting");
  useBackAction(() => void window.afterglideCloud.cancelSignIn());

  return (
    <main className="auth-screen">
      <div className="auth-header">
        <BrandLockup />
        <span className="secure-label">
          <Icon name="shield" /> Secure Microsoft sign-in
        </span>
      </div>
      <section className="auth-card">
        <DemoNotice environment={snapshot.environment} />
        <div className="auth-index">
          <span>1</span>
        </div>
        <div>
          <h1>Open the Microsoft link</h1>
          <p>We’ll wait here while you connect your Xbox account.</p>
          <button
            className="secondary-action"
            data-focusable
            data-autofocus
            disabled={!code}
            onClick={() =>
              code &&
              void window.afterglideCloud.openExternal(code.verificationUrl)
            }
          >
            Open microsoft.com/link <Icon name="external" />
          </button>
        </div>
        <div className="auth-divider" />
        <div className="auth-index">
          <span>2</span>
        </div>
        <div>
          <h2 className="auth-instruction">Enter this one-time code</h2>
          <button
            className="device-code"
            data-focusable
            disabled={!code}
            aria-label={`Copy code ${code?.code ?? ""}`}
            onClick={async () => {
              if (!code) return;
              await window.afterglideCloud.copyText(code.code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }}
          >
            <span>{code?.code ?? "••••••"}</span>
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <p className="code-caption">
            {code
              ? `${copied ? "Copied to clipboard" : "Select the code to copy"} · Expires in ${remaining}`
              : "Requesting a sign-in code…"}
          </p>
        </div>
        <div className="auth-waiting">
          <span className="waiting-dot" />
          <span>Waiting for Microsoft</span>
        </div>
      </section>
      <button
        className="text-action auth-cancel"
        data-focusable
        onClick={() => void window.afterglideCloud.cancelSignIn()}
      >
        <Icon name="back" /> Cancel
      </button>
    </main>
  );
}

function ReadinessScreen({
  snapshot,
  onComplete,
}: {
  snapshot: AppSnapshot;
  onComplete: () => void;
}) {
  const controllers = useControllerDiagnostics();
  const consoleCheck =
    snapshot.cloud.status === "loading"
      ? {
          state: "checking" as const,
          title: "Checking your cloud library",
          detail: "Xbox is checking the games available for this account.",
        }
      : snapshot.cloud.status === "ready"
        ? {
            state: "ready" as const,
            title: "Cloud library ready",
            detail: "Your account's available cloud games are loaded.",
          }
        : {
            state: "attention" as const,
            title: "Cloud availability needs attention",
            detail:
              snapshot.cloud.error ?? "Continue to Library to check again.",
          };
  useControllerNavigation(true, `${consoleCheck.state}:${controllers.length}`);

  return (
    <main className="readiness-screen">
      <header className="readiness-header">
        <BrandLockup />
        <button className="text-action" data-focusable onClick={onComplete}>
          Skip for now
        </button>
      </header>
      <section className="readiness-panel">
        <div className="readiness-copy">
          <h1>Check before your first stream.</h1>
          <DemoNotice environment={snapshot.environment} />
          <p>
            These are the three things worth checking. You can change or recheck
            them later in Settings and Health.
          </p>
        </div>
        <div className="readiness-checks" aria-live="polite">
          <ReadinessCheck
            icon="cloud"
            label="Cloud availability"
            {...consoleCheck}
          />
          <ReadinessCheck
            icon="shield"
            label="Sign-in storage"
            state={snapshot.hardware.secureStorage ? "ready" : "attention"}
            title={snapshot.hardware.credentialStorage.backend}
            detail={snapshot.hardware.credentialStorage.detail}
          />
          <ReadinessCheck
            icon="controller"
            label="Controller"
            state={controllers.length > 0 ? "ready" : "attention"}
            title={
              controllers.length > 0
                ? controllers[0].name
                : "No controller detected"
            }
            detail={
              controllers.length > 0
                ? "Controller input is available."
                : "Wake a controller now, or connect one when you’re ready to play."
            }
          />
        </div>
        <div className="readiness-actions">
          <button
            className="primary-action"
            data-focusable
            data-autofocus
            onClick={onComplete}
          >
            Continue to Afterglide Cloud <ControllerHint label="A" />
          </button>
          <span>Nothing here blocks setup.</span>
        </div>
      </section>
      <p className="legal-line">
        Afterglide Cloud is an independent client, not affiliated with Microsoft
        or Xbox.
      </p>
    </main>
  );
}

function ReadinessCheck({
  icon,
  label,
  state,
  title,
  detail,
}: {
  icon: IconName;
  label: string;
  state: "checking" | "ready" | "attention";
  title: string;
  detail: string;
}) {
  return (
    <article className={`readiness-check ${state}`}>
      <div className="readiness-check-icon">
        <Icon name={state === "ready" ? "check" : icon} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </article>
  );
}

function Shell({
  snapshot,
  page,
  onPage,
  children,
}: {
  snapshot: AppSnapshot;
  page: Page;
  onPage: (page: Page) => void;
  children: React.ReactNode;
}) {
  return (
    <main
      className={`app-shell ${snapshot.settings.reducedMotion ? "reduced-motion" : ""}`}
    >
      <aside className="rail" aria-label="Main navigation">
        <BrandMark />
        <nav>
          <RailButton
            icon="cloud"
            label="Library"
            active={page === "cloud"}
            onClick={() => onPage("cloud")}
          />
          <RailButton
            icon="pulse"
            label="Health"
            active={page === "diagnostics"}
            onClick={() => onPage("diagnostics")}
          />
        </nav>
        <RailButton
          icon="settings"
          label="Settings"
          active={page === "settings"}
          onClick={() => onPage("settings")}
        />
      </aside>
      <div className="shell-main">
        <header className="shell-header">
          <BrandWord />
          <div className="shell-status">
            {snapshot.update.status === "available" &&
              snapshot.update.releaseUrl && (
                <button
                  className="update-pill"
                  data-focusable
                  onClick={() =>
                    void window.afterglideCloud.openExternal(
                      snapshot.update.releaseUrl!,
                    )
                  }
                >
                  <Icon name="refresh" /> Update {snapshot.update.version}
                </button>
              )}
            <div className="account-ready">
              <Icon name="shield" />
              <span>
                {snapshot.auth.status === "signed-in"
                  ? "Account connected"
                  : "Not signed in"}
              </span>
            </div>
          </div>
        </header>
        {children}
        <footer className="controller-footer">
          <span>
            <ControllerHint label="A" /> / <ControllerHint label="Enter" wide />
            Select
          </span>
          <span>
            <ControllerHint label="B" /> / <ControllerHint label="Esc" wide />
            Back
          </span>
          <span>
            <ControllerHint label="✣" /> /{" "}
            <ControllerHint label="Arrows" wide />
            Move
          </span>
          <span className="footer-version">v{snapshot.version}</span>
        </footer>
      </div>
    </main>
  );
}

function CloudPage({
  snapshot,
  onPlay,
}: {
  snapshot: AppSnapshot;
  onPlay: (titleId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [recentOnly, setRecentOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CLOUD_PAGE_SIZE);
  const [search, setSearch] = useState<{
    query: string;
    status: "loading" | "ready" | "error";
    titles: CloudTitle[];
    error?: string;
  }>();
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setSearch(undefined);
      return;
    }
    let active = true;
    setSearch({ query: text, status: "loading", titles: [] });
    const timer = setTimeout(() => {
      void window.afterglideCloud
        .searchCloudTitles(text)
        .then((titles) => {
          if (active) setSearch({ query: text, status: "ready", titles });
        })
        .catch(() => {
          if (active)
            setSearch({
              query: text,
              status: "error",
              titles: [],
              error: "Cloud search didn’t finish. Try your search again.",
            });
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = snapshot.cloud.titles.find(
    (title) => title.id === snapshot.cloud.selectedTitleId,
  );
  const localMatches = snapshot.cloud.titles.filter(
    (title) =>
      (!recentOnly || title.recentlyPlayed) &&
      `${title.name} ${title.publisher}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const filtered =
    query.trim() && search?.query === query.trim()
      ? [
          ...new Map(
            [
              ...localMatches,
              ...search.titles.filter(
                (title) => !recentOnly || title.recentlyPlayed,
              ),
            ].map((title) => [title.id, title]),
          ).values(),
        ]
      : localMatches;
  const visibleTitles = filtered.slice(0, visibleCount);

  useEffect(() => setVisibleCount(CLOUD_PAGE_SIZE), [query, recentOnly]);

  return (
    <section className="page cloud-page">
      <div className="cloud-heading">
        <div className="page-heading">
          <h1>Your cloud library.</h1>
          <p>Games available to stream with this Microsoft account.</p>
        </div>
        {snapshot.cloud.status === "ready" && (
          <div className="cloud-search" role="search">
            <Icon name="search" />
            <label className="sr-only" htmlFor="cloud-game-search">
              Search cloud games
            </label>
            <input
              ref={searchInput}
              id="cloud-game-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search games"
              maxLength={128}
              data-focusable
            />
            {query && (
              <button
                type="button"
                aria-label="Clear game search"
                data-focusable
                onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      <div className="library-tools">
        <div className="segmented" role="group" aria-label="Library filter">
          <button
            data-focusable
            aria-pressed={!recentOnly}
            className={!recentOnly ? "active" : ""}
            onClick={() => setRecentOnly(false)}
          >
            All games
          </button>
          <button
            data-focusable
            aria-pressed={recentOnly}
            className={recentOnly ? "active" : ""}
            onClick={() => setRecentOnly(true)}
          >
            Recently played
          </button>
        </div>
        <button
          className="text-action"
          data-focusable
          disabled={
            snapshot.cloud.status === "loading" || snapshot.cloud.hydrating
          }
          onClick={() => void window.afterglideCloud.refreshCloudTitles()}
        >
          <Icon name="refresh" /> Refresh library
        </button>
      </div>
      {snapshot.environment === "test" && (
        <p className="demo-notice" role="status">
          Demo mode · Simulated games, stream and network measurements
        </p>
      )}
      {!navigator.onLine && (
        <p className="inline-error" role="status">
          You are offline. Reconnect before launching a game.
        </p>
      )}
      {snapshot.cloud.status === "loading" && <CloudSkeleton />}
      {snapshot.cloud.status === "ready" && snapshot.cloud.hydrating && (
        <p className="demo-notice" role="status">
          Loading more games… You can play or search the games already
          available.
        </p>
      )}
      {query.trim() && search?.status === "loading" && (
        <p className="demo-notice" role="status">
          Searching all cloud games…
        </p>
      )}
      {query.trim() && search?.status === "error" && (
        <p className="inline-error" role="status">
          {search.error}
        </p>
      )}
      {(snapshot.cloud.status === "unavailable" ||
        snapshot.cloud.status === "error") && (
        <div className="cloud-unavailable" role="status">
          <span className="cloud-symbol">
            <Icon name="cloud" />
          </span>
          <div>
            <h2>
              {snapshot.cloud.status === "error"
                ? "Your cloud library didn’t load."
                : "Cloud gaming isn’t active here."}
            </h2>
            <p>{snapshot.cloud.error}</p>
          </div>
          <button
            className="secondary-action"
            data-focusable
            data-autofocus
            onClick={() => void window.afterglideCloud.refreshCloudTitles()}
          >
            <Icon name="refresh" /> Check again
          </button>
        </div>
      )}

      {snapshot.cloud.status === "ready" && selected && !query.trim() && (
        <article className="cloud-feature">
          <GameArtwork title={selected} featured />
          <div className="cloud-feature-copy">
            <h2>{selected.name}</h2>
            <p>{selected.publisher}</p>
            <span>
              <Icon name="controller" /> Controller input
            </span>
          </div>
          <button
            className="primary-action cloud-play"
            data-focusable
            data-autofocus
            disabled={!navigator.onLine}
            onClick={() => void onPlay(selected.id)}
          >
            <Icon name="play" />{" "}
            {selected.recentlyPlayed ? "Play again" : "Play from cloud"}{" "}
            <ControllerHint label="A" />
          </button>
        </article>
      )}

      {snapshot.cloud.status === "ready" && (
        <div className="cloud-library">
          <div className="cloud-library-title">
            <h2>
              {query
                ? "Search results"
                : recentOnly
                  ? "Recently played games"
                  : "All cloud games"}
            </h2>
            <span aria-live="polite">
              {visibleTitles.length < filtered.length
                ? `Showing ${visibleTitles.length} of ${filtered.length}`
                : `${filtered.length} ${filtered.length === 1 ? "title" : "titles"}`}
            </span>
          </div>
          {filtered.length === 0 ? (
            <p className="cloud-empty">
              {query
                ? search?.status !== "ready"
                  ? `Checking all cloud games for “${query}”…`
                  : `No games match “${query}”.`
                : recentOnly
                  ? "No recently played games yet. Choose All games to explore."
                  : "No cloud games are currently available for this account."}
            </p>
          ) : (
            <>
              <div className="game-grid">
                {visibleTitles.map((title) => (
                  <button
                    key={title.id}
                    className={title.id === selected?.id ? "selected" : ""}
                    data-focusable
                    aria-pressed={title.id === selected?.id}
                    onClick={(event) => {
                      if (event.detail === 0 && title.id === selected?.id)
                        void onPlay(title.id);
                      else
                        void window.afterglideCloud.selectCloudTitle(title.id);
                    }}
                    onDoubleClick={() => void onPlay(title.id)}
                    aria-label={`${title.name}, ${title.publisher}`}
                  >
                    <GameArtwork title={title} />
                    <strong>{title.name}</strong>
                    <span>{title.publisher}</span>
                  </button>
                ))}
              </div>
              {visibleTitles.length < filtered.length && (
                <button
                  className="secondary-action cloud-load-more"
                  data-focusable
                  onClick={() =>
                    setVisibleCount((count) => count + CLOUD_PAGE_SIZE)
                  }
                >
                  {`Show ${Math.min(
                    CLOUD_PAGE_SIZE,
                    filtered.length - visibleCount,
                  )} more games`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function GameArtwork({
  title,
  featured = false,
}: {
  title: CloudTitle;
  featured?: boolean;
}) {
  return title.imageUrl ? (
    <img
      className={featured ? "featured-art" : "game-art"}
      src={title.imageUrl}
      alt=""
      loading={featured ? "eager" : "lazy"}
      referrerPolicy="no-referrer"
    />
  ) : (
    <div
      className={`${featured ? "featured-art" : "game-art"} game-art-fallback`}
      aria-hidden="true"
    >
      <Icon name="cloud" />
      <span>{title.name.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}

function CloudSkeleton() {
  return (
    <div className="cloud-skeleton" aria-label="Loading cloud games">
      <div />
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}

function ConnectingScreen({
  snapshot,
  onCancel,
}: {
  snapshot: AppSnapshot;
  onCancel: () => void;
}) {
  useControllerNavigation(
    true,
    "connecting",
    snapshot.settings.preferredControllerId,
  );
  useBackAction(onCancel);
  const stages = ["provisioning", "authorizing", "negotiating"];
  const stageLabels = ["Capacity", "Secure", "Video"];
  const current = Math.max(0, stages.indexOf(snapshot.session.phase));
  return (
    <main
      className={`connecting-screen ${snapshot.settings.reducedMotion ? "reduced-motion" : ""}`}
    >
      <header>
        <BrandLockup />
        <span>{snapshot.session.targetName}</span>
      </header>
      <div className="connection-visual" aria-hidden="true">
        <div className="orbit orbit-a" />
        <div className="orbit orbit-b" />
        <div className="orbit orbit-c" />
        <div className="connection-core">
          <Icon name="cloud" />
        </div>
      </div>
      <section className="connection-copy" aria-live="polite">
        <DemoNotice environment={snapshot.environment} />

        <h1>{snapshot.session.label}</h1>
        <p>{snapshot.session.detail}</p>
        <div className="progress-track">
          <span style={{ width: `${snapshot.session.progress}%` }} />
        </div>
        <div className="stage-list">
          {stageLabels.map((label, index) => (
            <span
              key={label}
              className={
                index < current ? "done" : index === current ? "current" : ""
              }
            >
              <i>{index < current ? <Icon name="check" /> : index + 1}</i>
              {label}
            </span>
          ))}
        </div>
      </section>
      <button
        className="text-action connection-cancel"
        data-focusable
        data-autofocus
        onClick={onCancel}
      >
        Cancel
      </button>
    </main>
  );
}

function StreamView({
  snapshot,
  descriptor,
  online,
  recoveryState,
  onExit,
}: {
  snapshot: AppSnapshot;
  descriptor: StreamDescriptor;
  online: boolean;
  recoveryState: RecoveryState;
  onExit: () => Promise<void>;
}) {
  const [overlay, setOverlay] = useState(true);
  const [performanceVisible, setPerformanceVisible] = useState(
    snapshot.settings.showPerformance,
  );
  const [telemetry, setTelemetry] = useState(snapshot.telemetry);
  const [performanceAnnouncement, setPerformanceAnnouncement] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [controlsCaptured, setControlsCaptured] = useState(false);
  const [controllerNotice, setControllerNotice] = useState("");
  const overlayRef = useRef(true);
  const performanceVisibleRef = useRef(snapshot.settings.showPerformance);
  const latestTelemetry = useRef(snapshot.telemetry);
  const controlsCapturedRef = useRef(false);
  const streamEventsEnabled = useRef(true);
  const interruptionReported = useRef<string | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const focusFrame = useRef<number | undefined>(undefined);
  const controllerNoticeTimer = useRef<number | undefined>(undefined);
  const scheduleHide = useCallback(() => {
    clearTimeout(timer.current);
    if (snapshot.session.phase !== "streaming" || controlsCapturedRef.current)
      return;
    timer.current = window.setTimeout(() => {
      if (controlsCapturedRef.current) return;
      if (root.current?.contains(document.activeElement)) {
        root.current?.focus({ preventScroll: true });
      }
      overlayRef.current = false;
      setOverlay(false);
    }, 4_000);
  }, [snapshot.session.phase]);
  const reveal = useCallback(() => {
    overlayRef.current = true;
    setOverlay(true);
    scheduleHide();
  }, [scheduleHide]);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    cancelAnimationFrame(focusFrame.current ?? 0);
    focusFrame.current = undefined;
    overlayRef.current = false;
    setOverlay(false);
    if (root.current?.contains(document.activeElement))
      root.current?.focus({ preventScroll: true });
  }, []);
  const captureControls = useCallback((focusFirst = false) => {
    clearTimeout(timer.current);
    controlsCapturedRef.current = true;
    setControlsCaptured(true);
    overlayRef.current = true;
    setOverlay(true);
    if (focusFirst) {
      cancelAnimationFrame(focusFrame.current ?? 0);
      focusFrame.current = window.requestAnimationFrame(() => {
        focusFrame.current = undefined;
        if (!controlsCapturedRef.current) return;
        header.current
          ?.querySelector<HTMLButtonElement>("[data-autofocus]")
          ?.focus();
      });
    }
  }, []);
  const closeControls = useCallback(() => {
    controlsCapturedRef.current = false;
    setControlsCaptured(false);
    hide();
  }, [hide]);
  const toggleControls = useCallback(() => {
    if (controlsCapturedRef.current) closeControls();
    else captureControls(true);
  }, [captureControls, closeControls]);
  const toggleOverlay = useCallback(() => {
    if (controlsCapturedRef.current) closeControls();
    else captureControls(true);
  }, [captureControls, closeControls]);
  const togglePerformance = useCallback(() => {
    const visible = !performanceVisibleRef.current;
    performanceVisibleRef.current = visible;
    setPerformanceVisible(visible);
    if (visible) setTelemetry(latestTelemetry.current);
    setPerformanceAnnouncement(
      `Performance stats ${visible ? "shown" : "hidden"}.`,
    );
    setSettingsError("");
    void window.afterglideCloud
      .updateSettings({ showPerformance: visible })
      .catch(() => {
        setSettingsError("Couldn’t save the stats preference. Try again.");
      });
  }, []);
  useControllerNavigation(
    controlsCaptured,
    "stream-controls",
    snapshot.settings.preferredControllerId,
  );
  useEffect(() => {
    reveal();
    const onDesktopControls = (event: Event) =>
      (event as CustomEvent).detail === "show"
        ? captureControls(true)
        : toggleControls();
    window.addEventListener("afterglide-desktop-controls", onDesktopControls);
    const pressedShortcuts = new Set<string>();
    const onKey = (event: KeyboardEvent) => {
      if (isLocalControlShortcut(event.key, "controls")) {
        event.preventDefault();
        if (!event.isTrusted || !pressedShortcuts.has(event.key)) {
          if (event.key === "F10") toggleControls();
          else toggleOverlay();
        }
        if (event.isTrusted) pressedShortcuts.add(event.key);
      } else if (isLocalControlShortcut(event.key, "performance")) {
        event.preventDefault();
        if (!event.isTrusted || !pressedShortcuts.has(event.key))
          togglePerformance();
        if (event.isTrusted) pressedShortcuts.add(event.key);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const buttons = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>(
            "button:not([disabled])",
          ) ?? [],
        );
        if (!controlsCapturedRef.current) {
          captureControls(true);
          return;
        }
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const direction = event.shiftKey ? -1 : 1;
        buttons[
          (current + direction + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressedShortcuts.delete(event.key);
    };
    const clearPressedShortcuts = () => pressedShortcuts.clear();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearPressedShortcuts);
    window.addEventListener("pointermove", reveal);
    return () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(focusFrame.current ?? 0);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPressedShortcuts);
      window.removeEventListener("pointermove", reveal);
      window.removeEventListener(
        "afterglide-desktop-controls",
        onDesktopControls,
      );
    };
  }, [reveal, toggleControls, toggleOverlay, togglePerformance]);

  useEffect(() => {
    const onGamepadAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "controls")
        toggleControls();
    };
    let chordReleased = false;
    let activeGamepadIndex: number | undefined;
    let frame = 0;
    const poll = () => {
      const gamepad = selectController(
        navigator.getGamepads(),
        snapshot.settings.preferredControllerId,
        activeGamepadIndex,
      );
      activeGamepadIndex = gamepad?.index;
      const pressed = Boolean(
        gamepad?.buttons[10]?.pressed && gamepad.buttons[11]?.pressed,
      );
      if (!pressed) chordReleased = true;
      else if (chordReleased) {
        toggleControls();
        return;
      }
      frame = requestAnimationFrame(poll);
    };
    window.addEventListener("afterglide-gamepad", onGamepadAction);
    if (
      controlsCaptured &&
      snapshot.settings.controllerMenuShortcut === "stick-chord"
    )
      frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("afterglide-gamepad", onGamepadAction);
    };
  }, [
    snapshot.settings.controllerMenuShortcut,
    snapshot.settings.preferredControllerId,
    controlsCaptured,
    toggleControls,
  ]);

  useEffect(() => {
    streamEventsEnabled.current = true;
    return () => {
      streamEventsEnabled.current = false;
    };
  }, []);

  const exitStream = useCallback(async () => {
    streamEventsEnabled.current = false;
    await onExit();
  }, [onExit]);

  const onConnected = useCallback(() => {
    if (!streamEventsEnabled.current) return;
    void window.afterglideCloud.reportStreamEvent(
      descriptor.sessionId,
      "connected",
    );
  }, [descriptor.sessionId]);
  const onInterrupted = useCallback(() => {
    if (
      !streamEventsEnabled.current ||
      interruptionReported.current === descriptor.sessionId
    )
      return;
    interruptionReported.current = descriptor.sessionId;
    void window.afterglideCloud.reportStreamEvent(
      descriptor.sessionId,
      "interrupted",
    );
  }, [descriptor.sessionId]);
  const onError = useCallback(
    (message: string) => {
      if (!streamEventsEnabled.current) return;
      void window.afterglideCloud.reportStreamEvent(
        descriptor.sessionId,
        "failed",
        message,
      );
    },
    [descriptor.sessionId],
  );
  const onTelemetry = useCallback((value: AppSnapshot["telemetry"]) => {
    if (!streamEventsEnabled.current) return;
    latestTelemetry.current = value;
    if (performanceVisibleRef.current) setTelemetry(value);
    window.afterglideCloud.updateTelemetry(value);
  }, []);
  const onControllerStatus = useCallback((status: ControllerStatus) => {
    clearTimeout(controllerNoticeTimer.current);
    const message =
      status.state === "disconnected"
        ? `${status.label} disconnected · game input released`
        : status.state === "switched"
          ? `Now using ${status.label}`
          : `${status.label} ready`;
    setControllerNotice(message);
    controllerNoticeTimer.current = window.setTimeout(
      () => setControllerNotice(""),
      status.state === "disconnected" ? 5_000 : 3_000,
    );
  }, []);
  const onControlsShortcut = useCallback(
    () => toggleControls(),
    [toggleControls],
  );

  useEffect(() => () => clearTimeout(controllerNoticeTimer.current), []);

  useEffect(() => {
    latestTelemetry.current = snapshot.telemetry;
    setTelemetry(snapshot.telemetry);
  }, [descriptor.sessionId]);

  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-keyshortcuts={LOCAL_CONTROL_SHORTCUTS.controls.join(" ")}
      className={`stream-view ${overlay ? "overlay-visible" : ""} ${
        controlsCaptured ? "controls-captured" : ""
      } ${snapshot.settings.reducedMotion ? "reduced-motion" : ""}`}
    >
      <StreamSurface
        descriptor={descriptor}
        reducedMotion={snapshot.settings.reducedMotion}
        keyboardControls={snapshot.settings.keyboardControls}
        reserveControlChord={
          snapshot.settings.controllerMenuShortcut === "stick-chord"
        }
        controllerSettings={snapshot.settings}
        playbackSettings={snapshot.settings}
        inputSuspended={
          controlsCaptured || !online || snapshot.session.phase === "recovering"
        }
        onConnected={onConnected}
        onInterrupted={onInterrupted}
        onError={onError}
        onTelemetry={onTelemetry}
        onControllerStatus={onControllerStatus}
        onControlsShortcut={onControlsShortcut}
      />
      <div className="stream-vignette" />
      {descriptor.mock && !controlsCaptured && (
        <p className="stream-demo-label">
          Demo · Simulated video and network measurements
        </p>
      )}
      {controllerNotice && (
        <div className="controller-notice" role="status">
          <Icon name="controller" /> {controllerNotice}
        </div>
      )}
      <header
        ref={header}
        className="stream-header"
        aria-hidden={!overlay}
        onPointerDown={() => captureControls()}
        onFocus={() => captureControls()}
      >
        <BrandWord />
        <div className="stream-console">
          <span className="live-dot" /> {descriptor.displayName}
        </div>
        <div className="stream-header-actions">
          <button
            data-focusable
            data-autofocus
            aria-label={
              performanceVisible
                ? "Hide performance stats"
                : "Show performance stats"
            }
            aria-keyshortcuts={LOCAL_CONTROL_SHORTCUTS.performance.join(" ")}
            aria-pressed={performanceVisible}
            tabIndex={overlay ? 0 : -1}
            onClick={togglePerformance}
          >
            <Icon name="pulse" />{" "}
            {performanceVisible ? "Hide stats" : "Show stats"}
          </button>
          <button
            data-focusable
            aria-label="Leave Xbox stream"
            tabIndex={overlay ? 0 : -1}
            onClick={() => void exitStream()}
          >
            <Icon name="power" /> End session
          </button>
        </div>
      </header>
      {controlsCaptured && (
        <QuickSettings
          settings={snapshot.settings}
          fullscreen={snapshot.fullscreen}
        />
      )}
      {settingsError && (
        <p className="stream-settings-error" role="alert">
          {settingsError}
        </p>
      )}
      {snapshot.session.phase === "recovering" && !controlsCaptured && (
        <div className="recovery-panel" role="status">
          <span className="waiting-dot" />
          <div>
            <strong>
              {recoveryState.status === "offline"
                ? "You’re offline"
                : snapshot.session.label}
            </strong>
            <small>
              {recoveryState.status === "offline"
                ? "Reconnect to your network to try again."
                : "Trying a new Xbox streaming session. Game progress may not be preserved."}
            </small>
          </div>
        </div>
      )}
      {performanceVisible && (
        <div className="performance-strip" aria-label="Stream performance">
          <Metric
            label="VIDEO"
            value={`${Math.round(telemetry.framesPerSecond)} FPS`}
          />
          <Metric
            label="PING"
            value={`${Math.round(telemetry.roundTripMs)} MS`}
          />
          <Metric
            label="QUALITY"
            value={telemetry.resolution.replace(" × ", "×")}
          />
          <Metric
            label="NETWORK"
            value={telemetry.networkQuality.toUpperCase()}
          />
        </div>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {performanceAnnouncement}
      </p>
      <footer className="stream-controls">
        {controlsCaptured ? (
          <span className="input-captured-status" role="status">
            <i />{" "}
            {descriptor.mock
              ? "Demo · Simulated stream · Game input paused"
              : "Afterglide Cloud controls · game input paused"}
          </span>
        ) : (
          <span>
            {snapshot.settings.controllerMenuShortcut === "stick-chord" ? (
              <>
                <ControllerHint label="L3" wide /> +{" "}
                <ControllerHint label="R3" wide /> Controls
              </>
            ) : (
              <>
                <ControllerHint label="F10" wide /> Keyboard controls
              </>
            )}
          </span>
        )}
        <div className="stream-shortcuts">
          {controlsCaptured ? (
            <>
              <span>
                <ControllerHint label="A" /> /{" "}
                <ControllerHint label="Enter" wide /> Select
              </span>
              <span>
                <ControllerHint label="B" /> /{" "}
                <ControllerHint label="Esc / F10" wide /> Close
              </span>
            </>
          ) : (
            <>
              <span>
                <ControllerHint label="☰" /> + <ControllerHint label="◫" />{" "}
                Xbox
              </span>
              <span>
                <ControllerHint
                  label={
                    snapshot.settings.controllerMenuShortcut === "steam-input"
                      ? "F9"
                      : "F3"
                  }
                  wide
                />{" "}
                Stats
              </span>
              <span>
                <ControllerHint label="Esc" wide /> Controls
              </span>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}

function RecoveryScreen({
  environment,
  state,
  online,
  preferredControllerId,
  onRetry,
  onExit,
}: {
  environment: AppSnapshot["environment"];
  state: RecoveryState;
  online: boolean;
  preferredControllerId: string;
  onRetry: () => void;
  onExit: () => void;
}) {
  useControllerNavigation(true, "recovery", preferredControllerId);
  useEffect(() => {
    const back = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", back);
    return () => window.removeEventListener("keydown", back);
  }, [onExit]);
  const exhausted = state.status === "exhausted";
  return (
    <main className="error-screen recovery-screen">
      <BrandLockup />
      <section>
        <DemoNotice environment={environment} />

        <h1>
          {exhausted
            ? "Automatic retries paused"
            : !online
              ? "You’re offline"
              : "Restoring the stream"}
        </h1>
        <p role="status">
          {exhausted
            ? "Three attempts didn’t restore a lasting connection. Check your network before trying again."
            : !online
              ? "Reconnect to your network. No attempts will start while you’re offline."
              : `Starting a new Xbox streaming session · attempt ${Math.min(3, state.attempts + (state.status === "waiting" ? 1 : 0))} of 3.`}
        </p>
        <p>
          Retrying starts a new Xbox streaming session. Game progress may not be
          preserved.
        </p>
        <div className="error-actions">
          {exhausted && (
            <button
              className="primary-action"
              data-focusable
              disabled={!online}
              onClick={onRetry}
            >
              Try again
            </button>
          )}
          <button
            className="secondary-action"
            data-focusable
            data-autofocus
            onClick={onExit}
          >
            End session
          </button>
        </div>
      </section>
    </main>
  );
}

function SessionErrorScreen({
  snapshot,
  onRetry,
  onBack,
}: {
  snapshot: AppSnapshot;
  onRetry: () => void;
  onBack: () => void;
}) {
  useControllerNavigation(
    true,
    undefined,
    snapshot.settings.preferredControllerId,
  );
  useBackAction(onBack);
  const backLabel = "Back to cloud games";
  return (
    <main className="error-screen">
      <BrandLockup />
      <section>
        <DemoNotice environment={snapshot.environment} />
        <div className="error-symbol">
          <Icon name="warning" />
        </div>

        <h1>{snapshot.session.label}</h1>
        <p>{snapshot.session.detail}</p>
        <small>Reference: {snapshot.session.errorCode ?? "UNKNOWN"}</small>
        <div className="error-actions">
          {snapshot.session.recoverable && (
            <button className="primary-action" data-focusable onClick={onRetry}>
              <Icon name="refresh" /> Try again <ControllerHint label="A" />
            </button>
          )}
          <button className="secondary-action" data-focusable onClick={onBack}>
            <Icon name="back" /> {backLabel}
          </button>
        </div>
      </section>
    </main>
  );
}

function DiagnosticsPage({ snapshot }: { snapshot: AppSnapshot }) {
  const [exportStatus, setExportStatus] = useState("");
  const [exportError, setExportError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportReport = async () => {
    setExporting(true);
    setExportError(false);
    setExportStatus("");
    try {
      const saved = await window.afterglideCloud.exportPerformanceReport();
      setExportStatus(
        saved ? "Performance report saved." : "Export cancelled.",
      );
    } catch {
      setExportError(true);
      setExportStatus("Couldn’t save the performance report. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const health =
    snapshot.hardware.acceleration === "enabled" ? "Ready" : "Check driver";
  return (
    <section className="page utility-page">
      <DemoNotice environment={snapshot.environment} />
      <div className="page-heading">
        <h1>System health</h1>
        <p>
          Afterglide Cloud checks the path that matters for cloud streaming.
        </p>
      </div>
      <div className="health-summary">
        <div className="health-ring">
          <span>
            {snapshot.hardware.acceleration === "enabled" ? "✓" : "!"}
          </span>
        </div>
        <div>
          <p>STREAMING READINESS</p>
          <h2>{health}</h2>
          <span>
            {snapshot.hardware.acceleration === "enabled"
              ? "Hardware video decode is available."
              : "Chromium may use a limited decode path."}
          </span>
        </div>
      </div>
      <div className="diagnostic-grid">
        <DiagnosticRow
          icon="cloud"
          label="Session"
          value={snapshot.session.label}
        />
        <DiagnosticRow
          icon="display"
          label="Received resolution"
          value={snapshot.telemetry.resolution}
        />
        <DiagnosticRow
          icon="pulse"
          label="Received frame rate"
          value={
            snapshot.telemetry.updatedAt
              ? `${snapshot.telemetry.framesPerSecond.toFixed(1)} fps`
              : "Measured during play"
          }
        />
        <DiagnosticRow
          icon="wifi"
          label="Packet loss"
          value={
            snapshot.telemetry.updatedAt
              ? `${snapshot.telemetry.packetLossPercent.toFixed(2)}%`
              : "Measured during play"
          }
        />
        <DiagnosticRow
          icon="wifi"
          label="Received bitrate"
          value={
            snapshot.telemetry.updatedAt
              ? `${snapshot.telemetry.bitrateMbps.toFixed(2)} Mbps`
              : "Measured during play"
          }
        />
        {(
          [
            ["Frame interval p95", snapshot.telemetry.frameIntervalP95Ms, "ms"],
            ["Frame interval p99", snapshot.telemetry.frameIntervalP99Ms, "ms"],
            ["Dropped frames", snapshot.telemetry.framesDropped, ""],
            ["Video freezes", snapshot.telemetry.freezeCount, ""],
            ["Time frozen", snapshot.telemetry.freezeDurationMs, "ms"],
            ["Last recovery", snapshot.telemetry.recoveryMs, "ms"],
          ] as const
        ).map(([label, value, unit]) => (
          <DiagnosticRow
            key={label}
            icon="pulse"
            label={label}
            value={
              value === undefined
                ? "Unavailable"
                : `${unit ? value.toFixed(1) : value}${unit ? ` ${unit}` : ""}`
            }
          />
        ))}
        <DiagnosticRow
          icon="display"
          label="Video decode"
          value={snapshot.hardware.videoDecode}
          state={
            snapshot.hardware.acceleration === "enabled" ? "good" : "attention"
          }
        />
        <DiagnosticRow
          icon="pulse"
          label="Last round trip"
          value={
            snapshot.telemetry.updatedAt
              ? `${Math.round(snapshot.telemetry.roundTripMs)} ms`
              : "Measured during play"
          }
        />
        <DiagnosticRow
          icon="display"
          label="Stream decoder"
          value={
            snapshot.telemetry.updatedAt
              ? snapshot.telemetry.videoDecoder
              : "Measured during play"
          }
        />
        <DiagnosticRow
          icon="pulse"
          label="Decode time per frame"
          value={
            snapshot.telemetry.decodeMs === undefined
              ? "Not reported"
              : `${snapshot.telemetry.decodeMs.toFixed(1)} ms`
          }
        />
        <DiagnosticRow
          icon="pulse"
          label="Video buffer delay"
          value={
            snapshot.telemetry.jitterBufferMs === undefined
              ? "Not reported"
              : `${snapshot.telemetry.jitterBufferMs.toFixed(1)} ms`
          }
        />
        <DiagnosticRow
          icon="wifi"
          label="Input send queue"
          value={
            snapshot.telemetry.inputQueueBytes === undefined
              ? "Measured during play"
              : `${snapshot.telemetry.inputQueueBytes} bytes`
          }
        />
        <DiagnosticRow
          icon="wifi"
          label="Last route"
          value={
            snapshot.telemetry.updatedAt
              ? snapshot.telemetry.connection
              : "Measured during play"
          }
        />
        <DiagnosticRow
          icon="shield"
          label="Credential storage"
          value={snapshot.hardware.credentialStorage.backend}
          state={snapshot.hardware.secureStorage ? "good" : "attention"}
        />
      </div>
      <p className="credential-note">
        <Icon name="shield" /> {snapshot.hardware.credentialStorage.detail}
      </p>
      <button
        className="secondary-action refresh-health"
        data-focusable
        disabled={exporting}
        onClick={() => void exportReport()}
      >
        {exporting ? "Saving report…" : "Export performance report"}
      </button>
      <p role={exportError ? "alert" : "status"}>{exportStatus}</p>
      <button
        className="secondary-action refresh-health"
        data-focusable
        data-autofocus
        onClick={() => void window.afterglideCloud.refreshCloudTitles()}
      >
        <Icon name="refresh" /> Refresh cloud library
      </button>
    </section>
  );
}

function SettingsPage({
  snapshot,
  onReviewSetup,
}: {
  snapshot: AppSnapshot;
  onReviewSetup: () => void;
}) {
  const update = (settings: Partial<AppSettings>) =>
    void window.afterglideCloud.updateSettings(settings);
  const controllers = useControllerDiagnostics();
  const controllerIds = Array.from(
    new Map(
      controllers.map((controller) => [controller.id, controller]),
    ).values(),
  );
  const preferredId = snapshot.settings.preferredControllerId;
  const activeTuning =
    (preferredId
      ? snapshot.settings.controllerProfiles.find(
          (profile) => profile.id === preferredId,
        )
      : undefined) ?? snapshot.settings.controllerDefaults;
  const hasDeviceProfile = Boolean(
    preferredId &&
    snapshot.settings.controllerProfiles.some(
      (profile) => profile.id === preferredId,
    ),
  );
  const updateControllerTuning = (change: Partial<ControllerTuning>) => {
    if (!preferredId) {
      update({
        controllerDefaults: {
          ...snapshot.settings.controllerDefaults,
          ...change,
        },
      });
      return;
    }
    const profiles = snapshot.settings.controllerProfiles.filter(
      (profile) => profile.id !== preferredId,
    );
    profiles.push({ id: preferredId, ...activeTuning, ...change });
    update({ controllerProfiles: profiles });
  };
  const resetControllerProfile = () =>
    update({
      controllerProfiles: snapshot.settings.controllerProfiles.filter(
        (profile) => profile.id !== preferredId,
      ),
    });
  return (
    <section className="page utility-page settings-page">
      <DemoNotice environment={snapshot.environment} />
      <div className="page-heading">
        <h1>Settings</h1>
        <p>Controller and playback preferences for Windows and macOS.</p>
      </div>
      <div className="settings-list">
        <SettingRow
          icon="display"
          title="Stream quality"
          detail="Xbox negotiates resolution, frame rate and bitrate for your account, region and connection. Actual values appear in the performance overlay."
        >
          <span>Automatic · Xbox managed</span>
        </SettingRow>
        <SettingRow
          icon="pulse"
          title="Performance overlay"
          detail="Show received frame rate and network round trip while playing. Toggle with F3 or F9."
        >
          <Toggle
            checked={snapshot.settings.showPerformance}
            label="Performance overlay"
            onChange={(value) => update({ showPerformance: value })}
          />
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Input polling"
          detail="Responsive is the default. These are requested timer intervals, not measured latency guarantees. Change this only when comparing hardware performance."
        >
          <div className="segmented" role="group" aria-label="Input polling">
            <button
              data-focusable
              aria-pressed={snapshot.settings.inputPolling === "responsive"}
              className={
                snapshot.settings.inputPolling === "responsive" ? "active" : ""
              }
              onClick={() => update({ inputPolling: "responsive" })}
            >
              Responsive · 4 ms
            </button>
            <button
              data-focusable
              aria-pressed={snapshot.settings.inputPolling === "efficient"}
              className={
                snapshot.settings.inputPolling === "efficient" ? "active" : ""
              }
              onClick={() => update({ inputPolling: "efficient" })}
            >
              Efficient · 8 ms
            </button>
          </div>
        </SettingRow>
        <SettingRow
          icon="controller"
          title="In-stream controls"
          detail="Choose whether L3 + R3 opens Afterglide Cloud or passes through to Xbox."
        >
          <div
            className="segmented controller-shortcut"
            role="group"
            aria-label="In-stream controller shortcut"
          >
            {(
              [
                ["stick-chord", "L3 + R3"],
                ["steam-input", "Pass through"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-focusable
                aria-pressed={
                  snapshot.settings.controllerMenuShortcut === value
                }
                className={
                  snapshot.settings.controllerMenuShortcut === value
                    ? "active"
                    : ""
                }
                onClick={() => update({ controllerMenuShortcut: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Keyboard controls"
          detail="Use a keyboard as an Xbox controller during a stream."
        >
          <Toggle
            checked={snapshot.settings.keyboardControls}
            label="Keyboard controls"
            onChange={(value) => update({ keyboardControls: value })}
          />
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Active controller"
          detail="Automatic follows the last controller you use; choose one to lock input and tuning to it."
        >
          <div
            className="segmented controller-device-options"
            role="group"
            aria-label="Active controller"
          >
            <button
              data-focusable
              aria-pressed={!preferredId}
              className={!preferredId ? "active" : ""}
              onClick={() => update({ preferredControllerId: "" })}
            >
              Automatic — last active
            </button>
            {preferredId &&
              !controllerIds.some(
                (controller) => controller.id === preferredId,
              ) && (
                <button disabled aria-pressed="true" className="active">
                  {friendlyControllerName(preferredId)} — disconnected
                </button>
              )}
            {controllerIds.map((controller) => (
              <button
                key={controller.id}
                data-focusable
                aria-pressed={preferredId === controller.id}
                className={preferredId === controller.id ? "active" : ""}
                onClick={() => update({ preferredControllerId: controller.id })}
              >
                {controller.name} — slot {controller.index + 1}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Vibration"
          detail={`${preferredId ? "This controller’s" : "Default"} rumble strength. Unsupported devices ignore it.`}
        >
          <div
            className="segmented controller-tuning"
            role="group"
            aria-label="Vibration"
          >
            {(
              [
                ["off", "Off"],
                ["low", "Low"],
                ["full", "Full"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-focusable
                aria-pressed={activeTuning.rumble === value}
                className={activeTuning.rumble === value ? "active" : ""}
                onClick={() => updateControllerTuning({ rumble: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="pulse"
          title="Stick response"
          detail="Increase the deadzone if a resting stick drifts."
        >
          <div
            className="segmented controller-tuning"
            role="group"
            aria-label="Stick response"
          >
            {(
              [
                [0.04, "Tight"],
                [0.08, "Standard"],
                [0.12, "Relaxed"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-focusable
                aria-label={`${label} ${Math.round(value * 100)} percent deadzone`}
                aria-pressed={activeTuning.stickDeadzone === value}
                className={activeTuning.stickDeadzone === value ? "active" : ""}
                onClick={() => updateControllerTuning({ stickDeadzone: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="pulse"
          title="Trigger response"
          detail="Short and Quick reach a full pull earlier for worn or short-travel triggers."
        >
          <div
            className="segmented controller-tuning"
            role="group"
            aria-label="Trigger response"
          >
            {(
              [
                [1, "Full"],
                [0.75, "Short"],
                [0.5, "Quick"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-focusable
                aria-pressed={activeTuning.triggerRange === value}
                className={activeTuning.triggerRange === value ? "active" : ""}
                onClick={() => updateControllerTuning({ triggerRange: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Face buttons"
          detail="Remap the two face-button pairs for accessibility or controller conventions."
        >
          <div
            className="segmented controller-layout"
            role="group"
            aria-label="Face button mapping"
          >
            {(
              [
                ["standard", "Standard"],
                ["swap-ab", "Swap A/B"],
                ["swap-xy", "Swap X/Y"],
                ["swap-both", "Swap both"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-focusable
                aria-pressed={activeTuning.buttonLayout === value}
                className={activeTuning.buttonLayout === value ? "active" : ""}
                onClick={() => updateControllerTuning({ buttonLayout: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <ControllerDiagnostics
          controllers={controllers}
          preferredId={preferredId}
          profiledIds={snapshot.settings.controllerProfiles.map(
            (profile) => profile.id,
          )}
          onResetProfile={
            preferredId && hasDeviceProfile ? resetControllerProfile : undefined
          }
        />
        <ControllerGuide shortcut={snapshot.settings.controllerMenuShortcut} />
        {snapshot.settings.keyboardControls && <KeyboardGuide />}
        <SettingRow
          icon="settings"
          title="Reduce motion"
          detail="Replace moving transitions with quiet fades."
        >
          <Toggle
            checked={snapshot.settings.reducedMotion}
            label="Reduce motion"
            onChange={(value) => update({ reducedMotion: value })}
          />
        </SettingRow>
        <SettingRow
          icon="display"
          title="Launch fullscreen"
          detail="Start in fullscreen on this computer."
        >
          <Toggle
            checked={snapshot.settings.launchFullscreen}
            label="Launch fullscreen"
            onChange={(value) => update({ launchFullscreen: value })}
          />
        </SettingRow>
        <SettingRow
          icon="shield"
          title="Credential storage"
          detail={snapshot.hardware.credentialStorage.detail}
        >
          <span
            className={`setting-status ${
              snapshot.hardware.secureStorage ? "good" : "attention"
            }`}
          >
            {snapshot.hardware.credentialStorage.backend}
          </span>
        </SettingRow>
        <SettingRow
          icon="refresh"
          title="Software updates"
          detail="This local preview has no release feed. Updates will be enabled after a separate project release source is approved."
        >
          <span>Local preview</span>
        </SettingRow>
        <SettingRow
          icon="check"
          title="First-run check"
          detail="Review Xbox, credential storage, and controller readiness again."
        >
          <button
            className="secondary-action compact-action"
            data-focusable
            onClick={onReviewSetup}
          >
            Review setup
          </button>
        </SettingRow>
      </div>
      <div className="account-row">
        <div>
          <span>MICROSOFT ACCOUNT</span>
          <strong>
            {snapshot.auth.status === "signed-in"
              ? "Xbox account connected"
              : "Sign in from Library to access cloud games."}
          </strong>
        </div>
        {snapshot.auth.status === "signed-in" && (
          <button
            className="text-action danger-action"
            data-focusable
            onClick={() => void window.afterglideCloud.signOut()}
          >
            Sign out
          </button>
        )}
      </div>
    </section>
  );
}

function ControllerDiagnostics({
  controllers,
  preferredId,
  profiledIds,
  onResetProfile,
}: {
  controllers: ControllerDiagnostic[];
  preferredId: string;
  profiledIds: string[];
  onResetProfile?: () => void;
}) {
  return (
    <aside
      className="controller-diagnostics"
      aria-label="Connected controller diagnostics"
    >
      <div className="controller-diagnostics-heading">
        <div>
          <strong>Controller check</strong>
          <span>
            {controllers.length === 0
              ? "Connect or wake a controller to inspect it."
              : `${controllers.length} controller${controllers.length === 1 ? "" : "s"} detected · input updates live`}
          </span>
        </div>
        {onResetProfile && (
          <button
            className="text-action"
            data-focusable
            onClick={onResetProfile}
          >
            Reset this profile
          </button>
        )}
      </div>
      {controllers.length > 0 && (
        <div className="controller-diagnostics-grid">
          {controllers.map((controller) => {
            const selected = preferredId === controller.id;
            const axes = controller.axes
              .slice(0, 4)
              .map((axis) => axis.toFixed(2))
              .join(" · ");
            return (
              <article
                key={`${controller.id}:${controller.index}`}
                className={selected ? "selected" : ""}
                title={controller.id}
              >
                <div className="controller-card-title">
                  <span className="controller-ready-dot" />
                  <strong>{controller.name}</strong>
                  <small>Slot {controller.index + 1}</small>
                </div>
                <dl>
                  <div>
                    <dt>Device</dt>
                    <dd title={controller.id}>{controller.id}</dd>
                  </div>
                  <div>
                    <dt>Input</dt>
                    <dd>
                      {controller.pressed.length > 0
                        ? controller.pressed.join(" + ")
                        : "Waiting for input"}
                    </dd>
                  </div>
                  <div>
                    <dt>Axes</dt>
                    <dd>{axes || "None"}</dd>
                  </div>
                  <div>
                    <dt>Support</dt>
                    <dd>
                      {controller.mapping} · {controller.buttons} buttons ·{" "}
                      {controller.rumble ? "Rumble ready" : "No browser rumble"}
                    </dd>
                  </div>
                </dl>
                <div className="controller-card-badges">
                  {selected && <span>LOCKED</span>}
                  {profiledIds.includes(controller.id) && <span>PROFILE</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <small className="controller-diagnostics-note">
        Automatic mode locks to the last active controller. If it disconnects,
        Afterglide Cloud releases every Xbox input before switching.
      </small>
    </aside>
  );
}

function KeyboardGuide() {
  return (
    <aside className="keyboard-guide" aria-label="Keyboard game controls">
      <div>
        <strong>Keyboard game controls</strong>
        <span>These keys are sent to the game while streaming.</span>
      </div>
      <div className="keyboard-guide-keys">
        {KEYBOARD_CONTROL_GUIDE.map(({ keys, action }) => (
          <span key={keys}>
            <ControllerHint label={keys} wide /> {action}
          </span>
        ))}
      </div>
      <small>
        <ControllerHint label="Esc / F10" wide /> controls ·{" "}
        <ControllerHint label="F3 / F9" wide /> performance stats
      </small>
    </aside>
  );
}

function ControllerGuide({
  shortcut,
}: {
  shortcut: AppSettings["controllerMenuShortcut"];
}) {
  const controls = [
    ...CONTROLLER_CONTROL_GUIDE.slice(0, 2),
    shortcut === "stick-chord"
      ? { keys: "L3 + R3", action: "Afterglide Cloud controls" }
      : { keys: "F10", action: "Afterglide Cloud controls" },
    ...CONTROLLER_CONTROL_GUIDE.slice(2),
  ];
  return (
    <aside
      className="keyboard-guide controller-guide"
      aria-label="Controller controls"
    >
      <div>
        <strong>Controller controls</strong>
        <span>
          Afterglide Cloud pauses game input while its controls are open.
        </span>
      </div>
      <div className="keyboard-guide-keys">
        {controls.map(({ keys, action }) => (
          <span key={keys}>
            <ControllerHint label={keys} wide /> {action}
          </span>
        ))}
      </div>
    </aside>
  );
}

function BrandMark({ size = "normal" }: { size?: "normal" | "large" }) {
  return (
    <div
      className={`brand-mark ${size}`}
      role="img"
      aria-label="Afterglide Cloud"
    >
      <svg viewBox="0 0 512 512" aria-hidden="true">
        <path
          d="M96 334 220 113h72l124 221h-78l-21-42H195l-21 42H96Zm132-106h56l-28-59-28 59Z"
          fill="currentColor"
        />
        <path
          d="M143 390h226"
          stroke="currentColor"
          strokeWidth="26"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function BrandWord() {
  return (
    <div className="brand-word">
      AFTER<span>GLIDE</span>
      <small> CLOUD</small>
    </div>
  );
}
function BrandLockup() {
  return (
    <div className="brand-lockup">
      <BrandMark />
      <BrandWord />
    </div>
  );
}

function WelcomeVisual() {
  return (
    <div className="welcome-visual" aria-hidden="true">
      <div className="visual-orbit" />
      <div className="cloud-desktop">
        <div className="cloud-desktop-screen">
          <div className="screen-horizon" />
          <span>CLOUD GAMING</span>
          <Icon name="cloud" />
        </div>
      </div>
      <div className="cloud-controller">
        <Icon name="controller" />
      </div>
      <div className="signal-path">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function Step({
  number,
  label,
  detail,
}: {
  number: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="welcome-step">
      <span>{number}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ControllerHint({
  label,
  wide = false,
}: {
  label: string;
  wide?: boolean;
}) {
  return <kbd className={wide ? "wide" : ""}>{label}</kbd>;
}

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`rail-button ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      data-focusable
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiagnosticRow({
  icon,
  label,
  value,
  state = "neutral",
}: {
  icon: IconName;
  label: string;
  value: string;
  state?: "good" | "attention" | "neutral";
}) {
  return (
    <div className="diagnostic-row">
      <div className={`diagnostic-icon ${state}`}>
        <Icon name={icon} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingRow({
  icon,
  title,
  detail,
  children,
}: {
  icon: IconName;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <Icon name={icon} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      data-focusable
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function isConnecting(snapshot: AppSnapshot): boolean {
  return ["provisioning", "authorizing"].includes(snapshot.session.phase);
}
