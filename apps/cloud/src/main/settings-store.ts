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
    const settings = {
      ...current,
      ...sanitizeSettingsUpdate(update, current),
    };
    if (JSON.stringify(settings) === JSON.stringify(current)) return current;
    this.save({ ...this.state, settings });
    return this.settings;
  }

  setSelectedTitle(id: string | undefined): void {
    if (this.state.selectedTitleId === id) return;
    this.save({ ...this.state, selectedTitleId: id });
  }

  private save(next: StoredPreferences): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    // Publish memory only after the atomic disk commit succeeds.
    this.state = next;
  }
}
