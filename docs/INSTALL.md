# Install Afterglide on Steam Deck or Linux

Afterglide `0.3.0-alpha.1` is an early Linux x86_64 preview. It is useful for
testing the complete app flow, while live Xbox service compatibility and Steam
Deck performance still need real-account and hardware verification.

## One-command install

In Steam Deck Desktop Mode, open **Konsole** and run:

```bash
curl -fsSL https://github.com/Arthur742Ramos/afterglide/releases/download/v0.3.0-alpha.1/install-steam-deck.sh | bash
```

The installer runs only for your user account. It downloads the AppImage and
published checksum over HTTPS, verifies the AppImage with SHA-256, then installs
the app, icon, launcher entry, and `afterglide` command under `~/.local`. It does
not use `sudo`, Node.js, or npm.

Run the same command again to replace the installed build with the release
version. Afterglide also checks the project's GitHub releases in the background;
when a newer compatible build exists, open it from the banner or Settings.

To remove the files created by the installer:

```bash
bash <(curl -fsSL https://github.com/Arthur742Ramos/afterglide/releases/download/v0.3.0-alpha.1/install-steam-deck.sh) --uninstall
```

## Install the AppImage with Dolphin

1. Open the [Afterglide 0.3.0 alpha 1 release](https://github.com/Arthur742Ramos/afterglide/releases/tag/v0.3.0-alpha.1).
2. Download `Afterglide-0.3.0-alpha.1-x86_64.AppImage` and `SHA256SUMS`.
3. Optional but recommended: in Konsole, open the download folder and run
   `sha256sum --check --ignore-missing SHA256SUMS`.
4. In Dolphin, create `Applications` in your Home folder and move the AppImage
   there.
5. Open **Properties → Permissions**, enable **Is executable**, then open the
   AppImage.

The AppImage route launches Afterglide without adding its desktop icon or command.
The one-command installer adds those integrations automatically.

## Add Afterglide to Gaming Mode

1. In desktop Steam, choose **Games → Add a Non-Steam Game to My Library**.
2. Select **Afterglide** from the application list. If it is absent, choose
   **Browse**, press **Ctrl+H** to show hidden folders, and select
   `/home/deck/.local/bin/afterglide`. For the manual route, select the AppImage.
3. Open the new library entry's **Properties** and keep the name **Afterglide**.
4. In **Controller Settings → Edit Layout**, keep the **Gamepad** template.
5. Optional: map **L4 to F10** for Afterglide's stream controls and **R4 to F9**
   for performance stats.
6. Return to Gaming Mode and launch Afterglide from **Library → Non-Steam**.

The first successful sign-in opens a short readiness check for console remote
features, secure credential storage, and controller detection. Every item can be
reviewed later, and setup can always be skipped.

## Sign-in storage on Linux

Afterglide saves Microsoft refresh credentials only when Electron detects a real
OS encryption backend. KDE Wallet and Secret Service keyrings are supported.
If Health or Settings says **Session memory only**, enable and unlock KDE Wallet
or a Secret Service keyring, quit Afterglide, and launch it again. You can still
play for the current session while storage is unavailable, but you will need to
sign in again after restarting the app.

## Build from source

Source development requires Node.js 24 or newer:

```bash
git clone https://github.com/Arthur742Ramos/afterglide.git
cd afterglide
npm ci
npm run dev
```

Use `npm run package:linux` on Linux to build an AppImage and tarball in
`release/`.
