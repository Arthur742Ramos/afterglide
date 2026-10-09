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
import type { HardwareInfo } from "../shared/contracts";

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
  return getCredentialStorageInfo().secure;
}

export function getCredentialStorageInfo(): {
  secure: boolean;
  storage: HardwareInfo["credentialStorage"];
} {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      secure: false,
      storage: {
        backend: "Unavailable",
        detail:
          process.platform === "linux"
            ? "Unlock KDE Wallet or a Secret Service keyring, then restart Afterglide."
            : "Unlock the operating system credential store, then restart Afterglide.",
      },
    };
  }

  if (process.platform === "darwin") {
    return {
      secure: true,
      storage: {
        backend: "macOS Keychain",
        detail: "Your sign-in can be restored securely on this Mac.",
      },
    };
  }
  if (process.platform === "win32") {
    return {
      secure: true,
      storage: {
        backend: "Windows credential encryption",
        detail: "Your sign-in can be restored securely on this PC.",
      },
    };
  }

  const selectedBackend = (
    safeStorage as typeof safeStorage & {
      getSelectedStorageBackend?: () => string;
    }
  ).getSelectedStorageBackend?.();
  if (!selectedBackend || selectedBackend === "basic_text") {
    return {
      secure: false,
      storage: {
        backend:
          selectedBackend === "basic_text"
            ? "Session memory only"
            : "Linux keyring unavailable",
        detail:
          "Enable and unlock KDE Wallet or a Secret Service keyring, then restart Afterglide.",
      },
    };
  }

  const names: Record<string, string> = {
    gnome_libsecret: "Secret Service keyring",
    kwallet: "KDE Wallet",
    kwallet5: "KDE Wallet 5",
    kwallet6: "KDE Wallet 6",
  };
  return {
    secure: true,
    storage: {
      backend: names[selectedBackend] ?? selectedBackend,
      detail: "Your sign-in can be restored securely on this device.",
    },
  };
}
