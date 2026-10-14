import { useRef, useState } from "react";
import type { AppSettings } from "../../shared/contracts";

export function QuickSettings({
  settings,
  fullscreen,
}: {
  settings: AppSettings;
  fullscreen: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const update = async (patch: Partial<AppSettings>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await window.afterglideCloud.updateSettings(patch);
    } catch {
      setError("Couldn’t save this setting. Try again.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const preferredId = settings.preferredControllerId;
  const activeTuning =
    (preferredId
      ? settings.controllerProfiles.find(
          (profile) => profile.id === preferredId,
        )
      : undefined) ?? settings.controllerDefaults;
  const updateRumble = (
    rumble: AppSettings["controllerDefaults"]["rumble"],
  ) => {
    if (!preferredId) {
      void update({
        controllerDefaults: {
          ...settings.controllerDefaults,
          rumble,
        },
      });
      return;
    }
    const profiles = settings.controllerProfiles.filter(
      (profile) => profile.id !== preferredId,
    );
    profiles.push({ id: preferredId, ...activeTuning, rumble });
    void update({ controllerProfiles: profiles });
  };
  return (
    <section
      className="quick-settings"
      aria-labelledby="quick-settings-title"
      aria-busy={saving}
    >
      <div className="quick-settings-heading">
        <h2 id="quick-settings-title">Quick settings</h2>
        <span>Changes apply without reconnecting</span>
      </div>
      <div className="quick-setting-row">
        <div>
          <strong>Fullscreen</strong>
          <p>Use the full display for your game.</p>
        </div>
        <div className="quick-setting-actions">
          <button
            data-focusable
            onClick={() =>
              void window.afterglideCloud
                .setFullscreen(!fullscreen)
                .catch(() => setError("Couldn't change fullscreen. Try again."))
            }
          >
            {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          </button>
        </div>
      </div>
      <div className="quick-setting-row">
        <strong>
          Volume <span>{Math.round(settings.volume * 100)}%</span>
        </strong>
        <div className="quick-setting-actions" role="group" aria-label="Volume">
          <button
            data-focusable
            aria-label="Decrease volume"
            aria-disabled={saving || settings.volume === 0}
            onClick={() =>
              void update({
                volume: Math.max(
                  0,
                  Math.round((settings.volume - 0.1) * 10) / 10,
                ),
              })
            }
          >
            −
          </button>
          <button
            data-focusable
            aria-label="Increase volume"
            aria-disabled={saving || settings.volume === 1}
            onClick={() =>
              void update({
                volume: Math.min(
                  1,
                  Math.round((settings.volume + 0.1) * 10) / 10,
                ),
              })
            }
          >
            +
          </button>
          <button
            data-focusable
            aria-pressed={settings.muted}
            aria-disabled={saving}
            onClick={() => void update({ muted: !settings.muted })}
          >
            {settings.muted ? "Unmute" : "Mute"}
          </button>
        </div>
      </div>
      <div className="quick-setting-row">
        <div>
          <strong>Picture</strong>
          <p>Fill crops the edges of the picture.</p>
        </div>
        <div
          className="quick-setting-actions"
          role="group"
          aria-label="Picture size"
        >
          <button
            data-focusable
            aria-pressed={settings.videoFit === "fit"}
            aria-disabled={saving}
            onClick={() => void update({ videoFit: "fit" })}
          >
            Fit
          </button>
          <button
            data-focusable
            aria-pressed={settings.videoFit === "fill"}
            aria-disabled={saving}
            onClick={() => void update({ videoFit: "fill" })}
          >
            Fill
          </button>
        </div>
      </div>
      <div className="quick-setting-row">
        <div>
          <strong>Stream smoothness</strong>
          <p>
            Smooth adds buffering and may increase input delay. Experimental.
          </p>
        </div>
        <div
          className="quick-setting-actions"
          role="group"
          aria-label="Stream smoothness"
        >
          {(["automatic", "smooth"] as const).map((mode) => (
            <button
              key={mode}
              data-focusable
              aria-pressed={settings.playbackMode === mode}
              aria-disabled={saving}
              onClick={() => void update({ playbackMode: mode })}
            >
              {mode === "smooth" ? "Smooth" : "Automatic"}
            </button>
          ))}
        </div>
      </div>
      <div className="quick-setting-row">
        <div>
          <strong>Input polling</strong>
          <p>Requested controller timer interval.</p>
        </div>
        <div
          className="quick-setting-actions"
          role="group"
          aria-label="Input polling"
        >
          <button
            data-focusable
            aria-pressed={settings.inputPolling === "responsive"}
            aria-disabled={saving}
            onClick={() => void update({ inputPolling: "responsive" })}
          >
            4 ms
          </button>
          <button
            data-focusable
            aria-pressed={settings.inputPolling === "efficient"}
            aria-disabled={saving}
            onClick={() => void update({ inputPolling: "efficient" })}
          >
            8 ms
          </button>
        </div>
      </div>
      <div className="quick-setting-row">
        <div>
          <strong>Vibration</strong>
          <p>Controller rumble intensity.</p>
        </div>
        <div
          className="quick-setting-actions"
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
              aria-disabled={saving}
              onClick={() => updateRumble(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="quick-settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
