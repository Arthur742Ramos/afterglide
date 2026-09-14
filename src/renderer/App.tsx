import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppSnapshot,
  CloudTitle,
  ControllerTuning,
  StreamDescriptor,
  XboxConsole,
} from "../shared/contracts";
import { Icon, type IconName } from "./icons";
import { useControllerNavigation } from "./hooks/use-controller-navigation";
import {
  CONTROLLER_CONTROL_GUIDE,
  KEYBOARD_CONTROL_GUIDE,
  LOCAL_CONTROL_SHORTCUTS,
  STEAM_INPUT_CONTROL_GUIDE,
  isLocalControlShortcut,
} from "./stream/input-schema";
import { StreamSurface } from "./stream/StreamSurface";
import {
  friendlyControllerName,
  selectController,
} from "./stream/controller-input";
import type { ControllerStatus } from "./stream/stream-engine";

type Page = "home" | "cloud" | "diagnostics" | "settings";
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

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | undefined>(undefined);
  const [page, setPage] = useState<Page>("home");
  const [descriptor, setDescriptor] = useState<StreamDescriptor | undefined>(
    undefined,
  );
  const recovery = useRef<string | undefined>(undefined);

  useEffect(() => {
    void window.afterglide.getSnapshot().then(setSnapshot);
    return window.afterglide.onSnapshot(setSnapshot);
  }, []);

  const signedIn = snapshot?.auth.status === "signed-in";
  const inStream = Boolean(descriptor) && snapshot?.session.phase !== "error";
  const focusScope =
    page === "home"
      ? `${page}:${snapshot?.consolesStatus}`
      : page === "cloud"
        ? `${page}:${snapshot?.cloud.status}`
        : page;
  useControllerNavigation(
    Boolean(
      snapshot &&
      signedIn &&
      snapshot.settings.onboardingComplete &&
      !inStream &&
      !isConnecting(snapshot),
    ),
    focusScope,
    snapshot?.settings.preferredControllerId,
  );

  useEffect(() => {
    const onBack = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !signedIn || descriptor || !snapshot)
        return;
      if (isConnecting(snapshot)) void window.afterglide.stopStream();
      else if (page !== "home") setPage("home");
    };
    window.addEventListener("keydown", onBack);
    return () => window.removeEventListener("keydown", onBack);
  }, [signedIn, descriptor, page, snapshot]);

  const startStream = useCallback(async (consoleId: string) => {
    try {
      const stream = await window.afterglide.startStream(consoleId);
      setDescriptor(stream);
    } catch {
      // The main-process snapshot contains the safe, actionable error.
    }
  }, []);

  const startCloudStream = useCallback(async (titleId: string) => {
    try {
      const stream = await window.afterglide.startCloudStream(titleId);
      setDescriptor(stream);
    } catch {
      // The main-process snapshot contains the safe, actionable error.
    }
  }, []);

  const retryStream = useCallback(async () => {
    setDescriptor(undefined);
    try {
      const stream = await window.afterglide.retryStream();
      setDescriptor(stream);
    } catch {
      // The error screen updates through the snapshot subscription.
    }
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.session.phase !== "recovering" || !descriptor) {
      if (snapshot?.session.phase !== "recovering")
        recovery.current = undefined;
      return;
    }
    if (recovery.current === descriptor.sessionId) return;
    recovery.current = descriptor.sessionId;
    const timer = window.setTimeout(() => void retryStream(), 700);
    return () => clearTimeout(timer);
  }, [snapshot, descriptor, retryStream]);

  if (!snapshot || snapshot.auth.status === "restoring") return <BootScreen />;
  if (
    snapshot.auth.status === "signed-out" ||
    snapshot.auth.status === "error"
  ) {
    return (
      <WelcomeScreen
        error={snapshot.auth.error}
        onSignIn={() => void window.afterglide.beginSignIn()}
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
          void window.afterglide.updateSettings({ onboardingComplete: true })
        }
      />
    );
  }
  if (snapshot.session.phase === "error") {
    return (
      <SessionErrorScreen
        snapshot={snapshot}
        onRetry={() => void retryStream()}
        onBack={() => void window.afterglide.stopStream()}
      />
    );
  }
  if (
    descriptor &&
    ["negotiating", "streaming", "recovering"].includes(snapshot.session.phase)
  ) {
    return (
      <StreamView
        snapshot={snapshot}
        descriptor={descriptor}
        onExit={async () => {
          await window.afterglide.stopStream();
          setDescriptor(undefined);
        }}
      />
    );
  }
  if (isConnecting(snapshot))
    return (
      <ConnectingScreen
        snapshot={snapshot}
        onCancel={() => void window.afterglide.stopStream()}
      />
    );

  return (
    <Shell snapshot={snapshot} page={page} onPage={setPage}>
      {page === "home" && <HomePage snapshot={snapshot} onPlay={startStream} />}
      {page === "cloud" && (
        <CloudPage snapshot={snapshot} onPlay={startCloudStream} />
      )}
      {page === "diagnostics" && <DiagnosticsPage snapshot={snapshot} />}
      {page === "settings" && <SettingsPage snapshot={snapshot} />}
    </Shell>
  );
}

function BootScreen() {
  return (
    <main className="boot-screen" aria-live="polite">
      <BrandMark size="large" />
      <div className="boot-line">
        <span />
      </div>
      <p>Preparing your flight deck</p>
    </main>
  );
}

function WelcomeScreen({
  error,
  onSignIn,
}: {
  error?: string;
  onSignIn: () => void;
}) {
  useControllerNavigation(true);
  return (
    <main className="welcome-screen">
      <div className="welcome-topline">
        <BrandLockup />
        <span className="independent-label">Open source · Independent</span>
      </div>
      <section className="welcome-copy">
        <p className="eyebrow">XBOX STREAMING, YOUR WAY</p>
        <h1>
          Your Xbox.
          <br />
          <span>Wherever you land.</span>
        </h1>
        <p className="welcome-lede">
          Play from your own console or Xbox Cloud Gaming in a controller-first
          experience that feels at home on Steam Deck and desktop.
        </p>
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
          Afterglide.
        </p>
      </section>
      <WelcomeVisual />
      <div className="welcome-steps" aria-label="How Afterglide works">
        <Step
          number="01"
          label="Sign in"
          detail="Link securely with Microsoft"
        />
        <Step
          number="02"
          label="Choose where to play"
          detail="Your console or cloud library"
        />
        <Step
          number="03"
          label="Play"
          detail="Video, audio, and controls together"
        />
      </div>
      <p className="legal-line">
        Afterglide is not affiliated with Microsoft, Xbox, Valve, or Steam.
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

  return (
    <main className="auth-screen">
      <div className="auth-header">
        <BrandLockup />
        <span className="secure-label">
          <Icon name="shield" /> Secure Microsoft sign-in
        </span>
      </div>
      <section className="auth-card">
        <div className="auth-index">
          <span>1</span>
        </div>
        <div>
          <p className="eyebrow">ON YOUR PHONE OR ANOTHER DEVICE</p>
          <h1>Open the Microsoft link</h1>
          <p>We’ll wait here while you connect your Xbox account.</p>
          <button
            className="secondary-action"
            data-focusable
            data-autofocus
            disabled={!code}
            onClick={() =>
              code && void window.afterglide.openExternal(code.verificationUrl)
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
          <p className="eyebrow">ENTER THIS ONE-TIME CODE</p>
          <button
            className="device-code"
            data-focusable
            disabled={!code}
            aria-label={`Copy code ${code?.code ?? ""}`}
            onClick={async () => {
              if (!code) return;
              await window.afterglide.copyText(code.code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }}
          >
            <span>{code?.code ?? "••••••"}</span>
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <p className="code-caption">
            {copied ? "Copied to clipboard" : "Select the code to copy"} ·
            Expires in {remaining}
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
        onClick={() => void window.afterglide.cancelSignIn()}
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
  const selectedConsole = snapshot.consoles.find(
    (console) => console.id === snapshot.selectedConsoleId,
  );
  const readyConsole = [selectedConsole, ...snapshot.consoles].find(
    (console) => console?.remotePlayEnabled && console.remoteManagementEnabled,
  );
  const cloudReady =
    snapshot.cloud.status === "ready" && snapshot.cloud.available;
  const consoleCheck =
    snapshot.consolesStatus === "loading" || snapshot.cloud.status === "loading"
      ? {
          state: "checking" as const,
          title: "Checking where you can play",
          detail: "Console and cloud discovery are still running.",
        }
      : readyConsole && cloudReady
        ? {
            state: "ready" as const,
            title: readyConsole.name,
            detail: "Your console and cloud library are ready.",
          }
        : readyConsole
          ? {
              state: "ready" as const,
              title: readyConsole.name,
              detail:
                snapshot.cloud.status === "unavailable"
                  ? "Console play is ready. Cloud play is unavailable for this account or region."
                  : "Console play is ready. Cloud availability could not be confirmed.",
            }
          : cloudReady
            ? {
                state: "ready" as const,
                title: "Cloud library ready",
                detail:
                  "Cloud play is available. No remote-play-ready console was found yet.",
              }
            : snapshot.consoles.length > 0
              ? {
                  state: "attention" as const,
                  title: "Remote features need attention",
                  detail:
                    "Enable Xbox remote features, or continue if you only want cloud play later.",
                }
              : {
                  state: "attention" as const,
                  title: "No console found yet",
                  detail:
                    "You can continue now and refresh from Home after your Xbox is ready.",
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
          <p className="eyebrow">ONE QUICK CHECK</p>
          <h1>Ready for your first stream.</h1>
          <p>
            These are the three things worth checking. You can change or recheck
            them later in Settings and Health.
          </p>
        </div>
        <div className="readiness-checks" aria-live="polite">
          <ReadinessCheck
            icon="console"
            label="Play destinations"
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
            Continue to Afterglide <ControllerHint label="A" />
          </button>
          <span>Nothing here blocks setup.</span>
        </div>
      </section>
      <p className="legal-line">
        Afterglide is not affiliated with Microsoft, Xbox, Valve, or Steam.
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
            icon="home"
            label="Home"
            active={page === "home"}
            onClick={() => onPage("home")}
          />
          <RailButton
            icon="cloud"
            label="Cloud"
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
                    void window.afterglide.openExternal(
                      snapshot.update.releaseUrl!,
                    )
                  }
                >
                  <Icon name="refresh" /> Update {snapshot.update.version}
                </button>
              )}
            <div className="account-ready">
              <Icon name="shield" />
              <span>Account connected</span>
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
  const [visibleCount, setVisibleCount] = useState(CLOUD_PAGE_SIZE);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = snapshot.cloud.titles.find(
    (title) => title.id === snapshot.cloud.selectedTitleId,
  );
  const filtered = snapshot.cloud.titles.filter((title) =>
    `${title.name} ${title.publisher}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visibleTitles = filtered.slice(0, visibleCount);

  useEffect(() => setVisibleCount(CLOUD_PAGE_SIZE), [query]);

  return (
    <section className="page cloud-page">
      <div className="cloud-heading">
        <div className="page-heading">
          <p className="eyebrow">XBOX CLOUD GAMING</p>
          <h1>Your library. Ready anywhere.</h1>
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

      {snapshot.cloud.status === "loading" && <CloudSkeleton />}
      {(snapshot.cloud.status === "unavailable" ||
        snapshot.cloud.status === "error") && (
        <div className="cloud-unavailable" role="status">
          <span className="cloud-symbol">
            <Icon name="cloud" />
          </span>
          <div>
            <p className="eyebrow">
              {snapshot.cloud.status === "error"
                ? "COULDN’T LOAD LIBRARY"
                : "CLOUD UNAVAILABLE"}
            </p>
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
            onClick={() => void window.afterglide.refreshCloudTitles()}
          >
            <Icon name="refresh" /> Check again
          </button>
        </div>
      )}

      {snapshot.cloud.status === "ready" && selected && (
        <article className="cloud-feature">
          <GameArtwork title={selected} featured />
          <div className="cloud-feature-copy">
            <p className="eyebrow">
              {selected.recentlyPlayed ? "RECENTLY PLAYED" : "SELECTED GAME"}
            </p>
            <h2>{selected.name}</h2>
            <p>{selected.publisher}</p>
            <span>
              <Icon name="controller" /> Controller ready
            </span>
          </div>
          <button
            className="primary-action cloud-play"
            data-focusable
            data-autofocus
            onClick={() => void onPlay(selected.id)}
          >
            <Icon name="play" /> Play from cloud <ControllerHint label="A" />
          </button>
        </article>
      )}

      {snapshot.cloud.status === "ready" && (
        <div className="cloud-library">
          <div className="cloud-library-title">
            <h2>{query ? "Search results" : "All cloud games"}</h2>
            <span aria-live="polite">
              {visibleTitles.length < filtered.length
                ? `Showing ${visibleTitles.length} of ${filtered.length}`
                : `${filtered.length} ${filtered.length === 1 ? "title" : "titles"}`}
            </span>
          </div>
          {filtered.length === 0 ? (
            <p className="cloud-empty">
              {query
                ? `No games match “${query}”.`
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
                      else void window.afterglide.selectCloudTitle(title.id);
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

function HomePage({
  snapshot,
  onPlay,
}: {
  snapshot: AppSnapshot;
  onPlay: (consoleId: string) => Promise<void>;
}) {
  const selected = snapshot.consoles.find(
    (console) => console.id === snapshot.selectedConsoleId,
  );
  return (
    <section className="page home-page">
      <div className="page-heading">
        <p className="eyebrow">READY WHEN YOU ARE</p>
        <h1>
          {selected ? "Pick up where you left off." : "Let’s find your Xbox."}
        </h1>
        <p>
          {selected
            ? "Your console is ready when you are."
            : "Remote-play consoles on this account appear here."}
        </p>
      </div>

      {snapshot.consolesStatus === "loading" && <ConsoleSkeleton />}
      {snapshot.consolesStatus === "error" && (
        <div className="discovery-error" role="alert">
          <Icon name="warning" />
          <div>
            <h2>We couldn’t refresh your consoles</h2>
            <p>{snapshot.consolesError}</p>
          </div>
          <button
            className="secondary-action"
            data-focusable
            data-autofocus
            onClick={() => void window.afterglide.refreshConsoles()}
          >
            <Icon name="refresh" /> Try again
          </button>
        </div>
      )}
      {snapshot.consolesStatus === "ready" &&
        snapshot.consoles.length === 0 && <EmptyConsoles />}
      {selected && (
        <>
          <ConsoleStage
            console={selected}
            onPlay={() => void onPlay(selected.id)}
          />
          {snapshot.consoles.length > 1 && (
            <div className="console-switcher" aria-label="Choose a console">
              <span>YOUR CONSOLES</span>
              <div>
                {snapshot.consoles.map((console) => (
                  <button
                    data-focusable
                    className={console.id === selected.id ? "selected" : ""}
                    key={console.id}
                    onClick={() =>
                      void window.afterglide.selectConsole(console.id)
                    }
                  >
                    <span className={`power-dot ${console.power}`} />
                    {console.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ConsoleStage({
  console,
  onPlay,
}: {
  console: XboxConsole;
  onPlay: () => void;
}) {
  const ready = console.remotePlayEnabled;
  const powerLabel =
    console.power === "on"
      ? "Powered on"
      : console.power === "standby"
        ? "Ready from standby"
        : "Wake available";
  return (
    <article className="console-stage">
      <div
        className={`console-sculpture ${console.model.includes("Series S") ? "series-s" : "series-x"}`}
        aria-hidden="true"
      >
        <div className="console-object">
          <span className="console-vent" />
          <i className="console-power" />
          <span className="console-slot" />
        </div>
        <div className="console-plinth" />
      </div>
      <div className="console-copy">
        <div className="console-kicker">
          <span className={`power-dot ${console.power}`} /> {powerLabel}
        </div>
        <h2>{console.name}</h2>
        <p>{console.model}</p>
        <div className="console-facts">
          <span>
            <Icon name="wifi" />{" "}
            {console.wirelessWarning
              ? "Wireless console"
              : "Connection looks good"}
          </span>
          <span>
            <Icon name={ready ? "check" : "warning"} />{" "}
            {ready ? "Remote play enabled" : "Remote play is off"}
          </span>
        </div>
      </div>
      <button
        className="primary-action play-action"
        data-focusable
        data-autofocus
        disabled={!ready}
        onClick={onPlay}
      >
        <Icon name="play" />
        <span>{console.power === "on" ? "Play now" : "Wake & play"}</span>
        <ControllerHint label="A" />
      </button>
      {!ready && (
        <p className="stage-warning">
          Enable remote features on your Xbox under Settings › Devices &
          connections.
        </p>
      )}
    </article>
  );
}

function ConnectingScreen({
  snapshot,
  onCancel,
}: {
  snapshot: AppSnapshot;
  onCancel: () => void;
}) {
  const cloud = snapshot.session.source === "cloud";
  const stages = cloud
    ? ["provisioning", "authorizing", "negotiating"]
    : ["waking", "provisioning", "authorizing", "negotiating"];
  const stageLabels = cloud
    ? ["Capacity", "Secure", "Video"]
    : ["Wake", "Reserve", "Secure", "Video"];
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
          <Icon name={cloud ? "cloud" : "console"} />
        </div>
      </div>
      <section className="connection-copy" aria-live="polite">
        <p className="eyebrow">CONNECTING</p>
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
      <button className="text-action connection-cancel" onClick={onCancel}>
        Cancel
      </button>
    </main>
  );
}

function StreamView({
  snapshot,
  descriptor,
  onExit,
}: {
  snapshot: AppSnapshot;
  descriptor: StreamDescriptor;
  onExit: () => Promise<void>;
}) {
  const [overlay, setOverlay] = useState(true);
  const [performanceVisible, setPerformanceVisible] = useState(
    snapshot.settings.showPerformance,
  );
  const [performanceAnnouncement, setPerformanceAnnouncement] = useState("");
  const [controlsCaptured, setControlsCaptured] = useState(false);
  const [controllerNotice, setControllerNotice] = useState("");
  const overlayRef = useRef(true);
  const performanceVisibleRef = useRef(snapshot.settings.showPerformance);
  const controlsCapturedRef = useRef(false);
  const streamEventsEnabled = useRef(true);
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
      if (header.current?.contains(document.activeElement)) {
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
    if (header.current?.contains(document.activeElement))
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
    if (overlayRef.current) {
      if (controlsCapturedRef.current) closeControls();
      else hide();
    } else captureControls(true);
  }, [captureControls, closeControls, hide]);
  const togglePerformance = useCallback(() => {
    const visible = !performanceVisibleRef.current;
    performanceVisibleRef.current = visible;
    setPerformanceVisible(visible);
    setPerformanceAnnouncement(
      `Performance stats ${visible ? "shown" : "hidden"}.`,
    );
    void window.afterglide.updateSettings({ showPerformance: visible });
  }, []);
  useControllerNavigation(
    controlsCaptured,
    `stream:${performanceVisible ? "stats" : "no-stats"}`,
    snapshot.settings.preferredControllerId,
  );
  useEffect(() => {
    reveal();
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
          header.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
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
    };
  }, [reveal, toggleControls, toggleOverlay, togglePerformance]);

  useEffect(() => {
    const onGamepadAction = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "controls")
        toggleControls();
    };
    let chordPressed = false;
    let activeGamepadIndex: number | undefined;
    let frame = 0;
    const poll = () => {
      const gamepad = selectController(
        navigator.getGamepads(),
        snapshot.settings.preferredControllerId,
        activeGamepadIndex,
      );
      activeGamepadIndex = gamepad?.index;
      const pressed =
        snapshot.settings.controllerMenuShortcut === "stick-chord" &&
        Boolean(gamepad?.buttons[10]?.pressed && gamepad.buttons[11]?.pressed);
      if (pressed && !chordPressed) toggleControls();
      chordPressed = pressed;
      frame = requestAnimationFrame(poll);
    };
    window.addEventListener("afterglide-gamepad", onGamepadAction);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("afterglide-gamepad", onGamepadAction);
    };
  }, [
    snapshot.settings.controllerMenuShortcut,
    snapshot.settings.preferredControllerId,
    toggleControls,
  ]);

  useEffect(
    () => () => {
      streamEventsEnabled.current = false;
    },
    [],
  );

  const exitStream = useCallback(async () => {
    streamEventsEnabled.current = false;
    await onExit();
  }, [onExit]);

  const onConnected = useCallback(() => {
    if (!streamEventsEnabled.current) return;
    void window.afterglide.reportStreamEvent(descriptor.sessionId, "connected");
  }, [descriptor.sessionId]);
  const onInterrupted = useCallback(() => {
    if (!streamEventsEnabled.current) return;
    void window.afterglide.reportStreamEvent(
      descriptor.sessionId,
      "interrupted",
    );
  }, [descriptor.sessionId]);
  const onError = useCallback(
    (message: string) => {
      if (!streamEventsEnabled.current) return;
      void window.afterglide.reportStreamEvent(
        descriptor.sessionId,
        "failed",
        message,
      );
    },
    [descriptor.sessionId],
  );
  const onTelemetry = useCallback((value: AppSnapshot["telemetry"]) => {
    if (!streamEventsEnabled.current) return;
    void window.afterglide.updateTelemetry(value);
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

  useEffect(() => () => clearTimeout(controllerNoticeTimer.current), []);

  const telemetry = snapshot.telemetry;
  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-keyshortcuts={LOCAL_CONTROL_SHORTCUTS.controls.join(" ")}
      className={`stream-view ${overlay ? "overlay-visible" : ""} ${
        controlsCaptured ? "controls-captured" : ""
      }`}
    >
      <StreamSurface
        descriptor={descriptor}
        reducedMotion={snapshot.settings.reducedMotion}
        keyboardControls={snapshot.settings.keyboardControls}
        reserveControlChord={
          snapshot.settings.controllerMenuShortcut === "stick-chord"
        }
        controllerSettings={snapshot.settings}
        inputSuspended={controlsCaptured}
        onConnected={onConnected}
        onInterrupted={onInterrupted}
        onError={onError}
        onTelemetry={onTelemetry}
        onControllerStatus={onControllerStatus}
      />
      <div className="stream-vignette" />
      {controllerNotice && (
        <div className="controller-notice" role="status">
          <Icon name="controller" /> {controllerNotice}
        </div>
      )}
      <header ref={header} className="stream-header" aria-hidden={!overlay}>
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
      {snapshot.session.phase === "recovering" && (
        <div className="recovery-panel" role="status">
          <span className="waiting-dot" />
          <div>
            <strong>{snapshot.session.label}</strong>
            <small>{snapshot.session.detail}</small>
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
            label="LATENCY"
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
            <i /> Afterglide controls · game input paused
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
                <ControllerHint label="F10" wide /> Steam Input controls
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
  const backLabel =
    snapshot.session.source === "cloud"
      ? "Back to cloud games"
      : "Back to consoles";
  return (
    <main className="error-screen">
      <BrandLockup />
      <section>
        <div className="error-symbol">
          <Icon name="warning" />
        </div>
        <p className="eyebrow">CONNECTION ENDED</p>
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
  const health =
    snapshot.hardware.acceleration === "enabled" ? "Ready" : "Check driver";
  return (
    <section className="page utility-page">
      <div className="page-heading">
        <p className="eyebrow">SYSTEM HEALTH</p>
        <h1>Ready before you play.</h1>
        <p>Afterglide checks the path that matters for smooth remote play.</p>
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
        data-autofocus
        onClick={() => void window.afterglide.refreshConsoles()}
      >
        <Icon name="refresh" /> Refresh console check
      </button>
    </section>
  );
}

function SettingsPage({ snapshot }: { snapshot: AppSnapshot }) {
  const update = (settings: Partial<AppSettings>) =>
    void window.afterglide.updateSettings(settings);
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
  const updateDetail =
    snapshot.update.status === "available"
      ? `Version ${snapshot.update.version} is ready on GitHub.`
      : snapshot.update.status === "checking"
        ? "Checking the official GitHub releases now."
        : snapshot.update.status === "current"
          ? `Version ${snapshot.version} is current.`
          : snapshot.update.status === "error"
            ? (snapshot.update.error ?? "The update check failed.")
            : "Check the official GitHub releases for a newer build.";
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
      <div className="page-heading">
        <p className="eyebrow">PREFERENCES</p>
        <h1>Tuned to how you play.</h1>
        <p>Fast on a handheld. Comfortable at a desk. Make it yours.</p>
      </div>
      <div className="settings-list">
        <SettingRow
          icon="display"
          title="Stream resolution"
          detail="1080p is sharper when your network has room."
        >
          <div className="segmented">
            {[720, 1080].map((resolution) => (
              <button
                key={resolution}
                data-focusable
                data-autofocus={
                  snapshot.settings.resolution === resolution ? true : undefined
                }
                className={
                  snapshot.settings.resolution === resolution ? "active" : ""
                }
                onClick={() => update({ resolution: resolution as 720 | 1080 })}
              >
                {resolution}p
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          icon="pulse"
          title="Performance overlay"
          detail="Show live frame rate and latency while playing. Toggle with F3 or Steam Input’s F9 binding."
        >
          <Toggle
            checked={snapshot.settings.showPerformance}
            label="Performance overlay"
            onChange={(value) => update({ showPerformance: value })}
          />
        </SettingRow>
        <SettingRow
          icon="controller"
          title="In-stream controls"
          detail="Choose whether L3 + R3 opens Afterglide or passes through to Xbox."
        >
          <div
            className="segmented controller-shortcut"
            role="group"
            aria-label="In-stream controller shortcut"
          >
            {(
              [
                ["stick-chord", "L3 + R3"],
                ["steam-input", "Steam Input"],
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
          <select
            className="controller-select"
            data-focusable
            aria-label="Active controller"
            value={preferredId}
            onChange={(event) =>
              update({ preferredControllerId: event.currentTarget.value })
            }
          >
            <option value="">Automatic · last active</option>
            {preferredId &&
              !controllerIds.some(
                (controller) => controller.id === preferredId,
              ) && (
                <option value={preferredId}>
                  {friendlyControllerName(preferredId)} · disconnected
                </option>
              )}
            {controllerIds.map((controller) => (
              <option key={controller.id} value={controller.id}>
                {controller.name} · slot {controller.index + 1}
              </option>
            ))}
          </select>
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
          detail="Start in a focused view on desktop or Gaming Mode."
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
          detail={updateDetail}
        >
          <button
            className="secondary-action compact-action"
            data-focusable
            disabled={snapshot.update.status === "checking"}
            onClick={() =>
              snapshot.update.status === "available" &&
              snapshot.update.releaseUrl
                ? void window.afterglide.openExternal(
                    snapshot.update.releaseUrl,
                  )
                : void window.afterglide.checkForUpdates()
            }
          >
            {snapshot.update.status === "available"
              ? "Open release"
              : snapshot.update.status === "checking"
                ? "Checking…"
                : "Check now"}
            {snapshot.update.status === "available" && <Icon name="external" />}
          </button>
        </SettingRow>
        <SettingRow
          icon="check"
          title="First-run check"
          detail="Review Xbox, credential storage, and controller readiness again."
        >
          <button
            className="secondary-action compact-action"
            data-focusable
            onClick={() => update({ onboardingComplete: false })}
          >
            Review setup
          </button>
        </SettingRow>
      </div>
      <div className="account-row">
        <div>
          <span>MICROSOFT ACCOUNT</span>
          <strong>Xbox account connected</strong>
        </div>
        <button
          className="text-action danger-action"
          data-focusable
          onClick={() => void window.afterglide.signOut()}
        >
          Sign out
        </button>
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
        Afterglide releases every Xbox input before switching.
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
      ? { keys: "L3 + R3", action: "Afterglide controls" }
      : { keys: "F10", action: "Afterglide controls" },
    ...CONTROLLER_CONTROL_GUIDE.slice(2),
  ];
  return (
    <aside
      className="keyboard-guide controller-guide"
      aria-label="Controller controls"
    >
      <div>
        <strong>Controller controls</strong>
        <span>Afterglide pauses game input while its controls are open.</span>
      </div>
      <div className="keyboard-guide-keys">
        {controls.map(({ keys, action }) => (
          <span key={keys}>
            <ControllerHint label={keys} wide /> {action}
          </span>
        ))}
      </div>
      <div className="steam-input-tip">
        <div>
          <strong>Steam Input-ready</strong>
          <span>
            In Steam, open Controller Settings → Edit Layout and keep the
            Gamepad template. Map any spare button or Deck paddle to these
            keyboard keys:
          </span>
        </div>
        <div className="keyboard-guide-keys">
          {STEAM_INPUT_CONTROL_GUIDE.map(({ keys, action }) => (
            <span key={keys}>
              <ControllerHint label={keys} wide /> {action}
            </span>
          ))}
        </div>
        <small>
          {shortcut === "steam-input"
            ? "L3 + R3 passes through to the Xbox in this mode."
            : "F9 and F10 stay local and never reach the Xbox."}
        </small>
      </div>
    </aside>
  );
}

function BrandMark({ size = "normal" }: { size?: "normal" | "large" }) {
  return (
    <div className={`brand-mark ${size}`} role="img" aria-label="Afterglide">
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
      <div className="visual-deck">
        <div className="deck-screen">
          <div className="screen-horizon" />
          <span>REMOTE PLAY</span>
        </div>
        <i className="stick left" />
        <i className="stick right" />
        <b className="deck-a">A</b>
      </div>
      <div className="visual-console">
        <i />
        <span />
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

function ConsoleSkeleton() {
  return (
    <div className="console-stage skeleton" aria-label="Finding consoles">
      <div />
      <div>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function EmptyConsoles() {
  return (
    <div className="empty-consoles">
      <Icon name="console" />
      <h2>No remote-play consoles found</h2>
      <p>
        On your Xbox, open Settings › Devices & connections › Remote features,
        then enable remote features.
      </p>
      <button
        className="primary-action"
        data-focusable
        data-autofocus
        onClick={() => void window.afterglide.refreshConsoles()}
      >
        <Icon name="refresh" /> Check again <ControllerHint label="A" />
      </button>
    </div>
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
  return ["waking", "provisioning", "authorizing"].includes(
    snapshot.session.phase,
  );
}
