import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppSettings } from "../shared/contracts";
import {
  normalizeAppSettings,
  sanitizeSettingsUpdate,
} from "../shared/controller-settings";

interface StoredPreferences {
  selectedTitleId?: string;
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
    return normalizeAppSettings(this.state.settings);
  }

  get selectedTitleId(): string | undefined {
    return this.state.selectedTitleId;
  }

  updateSettings(update: Partial<AppSettings>): AppSettings {
    const current = this.settings;
    this.state.settings = {
      ...current,
      ...sanitizeSettingsUpdate(update, current),
    };
    this.save();
    return this.settings;
  }

  setSelectedTitle(id: string | undefined): void {
    this.state.selectedTitleId = id;
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
