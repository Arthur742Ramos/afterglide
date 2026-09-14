import { useRef, useState } from "react";
import type { AppSettings } from "../../shared/contracts";

export function QuickSettings({ settings }: { settings: AppSettings }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const update = async (patch: Partial<AppSettings>) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await window.afterglide.updateSettings(patch);
    } catch {
      setError("Couldn’t save this setting. Try again.");
    } finally {
      pending.current = false;
      setSaving(false);
    }
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
          <strong>Input polling</strong>
          <p>
            Experimental power comparison.
            <br />
            Savings have not been measured.
          </p>
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
            Responsive <small>4 ms</small>
          </button>
          <button
            data-focusable
            aria-pressed={settings.inputPolling === "efficient"}
            aria-disabled={saving}
            onClick={() => void update({ inputPolling: "efficient" })}
          >
            Efficient <small>8 ms</small>
          </button>
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
