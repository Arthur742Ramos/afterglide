import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings } from "../shared/contracts";
import { defaultSettings } from "../shared/contracts";

interface StoredPreferences {
  selectedConsoleId?: string;
  settings?: Partial<AppSettings>;
}

export class SettingsStore {
  private state: StoredPreferences = {};

  constructor(private readonly path: string) {
    try {
      this.state = JSON.parse(readFileSync(path, "utf8")) as StoredPreferences;
    } catch {
      this.state = {};
    }
  }

  get settings(): AppSettings {
    const settings = { ...defaultSettings, ...this.state.settings };
    return {
      ...settings,
      controllerMenuShortcut:
        settings.controllerMenuShortcut === "steam-input"
          ? "steam-input"
          : "stick-chord",
    };
  }

  get selectedConsoleId(): string | undefined {
    return this.state.selectedConsoleId;
  }

  updateSettings(update: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.settings, ...update };
    this.save();
    return this.settings;
  }

  setSelectedConsole(id: string | undefined): void {
    this.state.selectedConsoleId = id;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}
