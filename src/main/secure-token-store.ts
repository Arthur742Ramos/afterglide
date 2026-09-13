import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { TokenStore } from "xal-node";

/**
 * Keeps Microsoft refresh tokens outside the renderer and persists them only
 * through Electron's operating-system-backed safeStorage encryption.
 */
export class SecureTokenStore extends TokenStore {
  constructor(private readonly path: string) {
    super();
  }

  load(): boolean {
    if (!canPersistSecurely()) return false;
    try {
      const encrypted = readFileSync(this.path);
      return this.loadJson(safeStorage.decryptString(encrypted));
    } catch {
      return false;
    }
  }

  save(): void {
    if (!canPersistSecurely()) return;
    const serialized = JSON.stringify({
      userToken: this._userToken?.data,
      sisuToken: this._sisuToken?.data,
      jwtKeys: this._jwtKeys,
    });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, safeStorage.encryptString(serialized), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }

  removeAll(): void {
    this._userToken = undefined;
    this._sisuToken = undefined;
    this._jwtKeys = undefined;
    rmSync(this.path, { force: true });
  }
}

export function canPersistSecurely(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  const backend = (
    safeStorage as typeof safeStorage & {
      getSelectedStorageBackend?: () => string;
    }
  ).getSelectedStorageBackend?.();
  return backend !== "basic_text";
}
