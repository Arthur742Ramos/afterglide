import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  AppSnapshot,
  StreamDescriptor,
  XboxConsole,
} from "../shared/contracts";
import { Icon, type IconName } from "./icons";
import { useControllerNavigation } from "./hooks/use-controller-navigation";
import { StreamSurface } from "./stream/StreamSurface";

type Page = "home" | "diagnostics" | "settings";

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
  useControllerNavigation(
    Boolean(snapshot && signedIn && !inStream && !isConnecting(snapshot)),
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
        <p className="eyebrow">XBOX REMOTE PLAY FOR STEAM DECK</p>
        <h1>
          Your Xbox.
          <br />
          <span>Wherever you land.</span>
        </h1>
        <p className="welcome-lede">
          Sign in once, pick up your Deck, and play from your own console
          without reaching for a keyboard.
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
          label="Find your Xbox"
          detail="Ready and waiting on your account"
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
  useControllerNavigation(true);

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
          <div className="network-ready">
            <Icon name="wifi" />
            <span>Network ready</span>
          </div>
        </header>
        {children}
        <footer className="controller-footer">
          <span>
            <ControllerHint label="A" /> Select
          </span>
          <span>
            <ControllerHint label="B" /> Back
          </span>
          <span className="footer-version">v{snapshot.version}</span>
        </footer>
      </div>
    </main>
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
        <p className="eyebrow">GOOD EVENING</p>
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
      <div className="stage-signal" />
      <div className="console-glyph">
        <Icon name="console" />
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
  const console = snapshot.consoles.find(
    (item) => item.id === snapshot.session.consoleId,
  );
  const stages = ["waking", "provisioning", "authorizing", "negotiating"];
  const current = Math.max(0, stages.indexOf(snapshot.session.phase));
  return (
    <main
      className={`connecting-screen ${snapshot.settings.reducedMotion ? "reduced-motion" : ""}`}
    >
      <header>
        <BrandLockup />
        <span>{console?.name}</span>
      </header>
      <div className="connection-visual" aria-hidden="true">
        <div className="orbit orbit-a" />
        <div className="orbit orbit-b" />
        <div className="orbit orbit-c" />
        <div className="connection-core">
          <Icon name="console" />
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
          {["Wake", "Reserve", "Secure", "Video"].map((label, index) => (
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
  const timer = useRef<number | undefined>(undefined);
  const reveal = useCallback(() => {
    setOverlay(true);
    clearTimeout(timer.current);
    if (snapshot.session.phase === "streaming")
      timer.current = window.setTimeout(() => setOverlay(false), 4_000);
  }, [snapshot.session.phase]);
  useEffect(() => {
    reveal();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay((value) => !value);
      else reveal();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointermove", reveal);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", reveal);
    };
  }, [reveal]);

  const onConnected = useCallback(
    () =>
      void window.afterglide.reportStreamEvent(
        descriptor.sessionId,
        "connected",
      ),
    [descriptor.sessionId],
  );
  const onInterrupted = useCallback(
    () =>
      void window.afterglide.reportStreamEvent(
        descriptor.sessionId,
        "interrupted",
      ),
    [descriptor.sessionId],
  );
  const onError = useCallback(
    (message: string) =>
      void window.afterglide.reportStreamEvent(
        descriptor.sessionId,
        "failed",
        message,
      ),
    [descriptor.sessionId],
  );
  const onTelemetry = useCallback(
    (value: AppSnapshot["telemetry"]) =>
      void window.afterglide.updateTelemetry(value),
    [],
  );

  const selected = snapshot.consoles.find(
    (console) => console.id === descriptor.consoleId,
  );
  const telemetry = snapshot.telemetry;
  return (
    <main className={`stream-view ${overlay ? "overlay-visible" : ""}`}>
      <StreamSurface
        descriptor={descriptor}
        reducedMotion={snapshot.settings.reducedMotion}
        keyboardControls={snapshot.settings.keyboardControls}
        onConnected={onConnected}
        onInterrupted={onInterrupted}
        onError={onError}
        onTelemetry={onTelemetry}
      />
      <div className="stream-vignette" />
      <header className="stream-header">
        <BrandWord />
        <div className="stream-console">
          <span className="live-dot" /> {selected?.name ?? "Xbox"}
        </div>
        <button aria-label="Leave remote play" onClick={() => void onExit()}>
          <Icon name="power" /> End session
        </button>
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
      {(snapshot.settings.showPerformance || overlay) && (
        <div className="performance-strip">
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
          <Metric label="ROUTE" value={telemetry.connection.toUpperCase()} />
        </div>
      )}
      <footer className="stream-controls">
        <span>
          <ControllerHint label="☰" /> + <ControllerHint label="◫" /> Xbox
          button
        </span>
        <span>
          Press <ControllerHint label="Esc" wide /> to show controls
        </span>
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
  useControllerNavigation(true);
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
            <Icon name="back" /> Back to consoles
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
          value={
            snapshot.hardware.secureStorage
              ? "OS encryption active"
              : "Session only"
          }
          state={snapshot.hardware.secureStorage ? "good" : "attention"}
        />
      </div>
      <button
        className="secondary-action refresh-health"
        data-focusable
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
  return (
    <section className="page utility-page settings-page">
      <div className="page-heading">
        <p className="eyebrow">PREFERENCES</p>
        <h1>Tuned for the handheld.</h1>
        <p>Automatic choices stay strong. Change only what helps your setup.</p>
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
          detail="Show live frame rate and latency while playing."
        >
          <Toggle
            checked={snapshot.settings.showPerformance}
            label="Performance overlay"
            onChange={(value) => update({ showPerformance: value })}
          />
        </SettingRow>
        <SettingRow
          icon="controller"
          title="Keyboard controls"
          detail="Map keyboard keys to Xbox input during a stream."
        >
          <Toggle
            checked={snapshot.settings.keyboardControls}
            label="Keyboard controls"
            onChange={(value) => update({ keyboardControls: value })}
          />
        </SettingRow>
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
          detail="Open directly in a Gaming Mode-friendly view."
        >
          <Toggle
            checked={snapshot.settings.launchFullscreen}
            label="Launch fullscreen"
            onChange={(value) => update({ launchFullscreen: value })}
          />
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

function BrandMark({ size = "normal" }: { size?: "normal" | "large" }) {
  return (
    <div className={`brand-mark ${size}`} aria-label="Afterglide">
      <span>A</span>
      <i />
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
