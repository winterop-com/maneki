# Signing the desktop apps

How to set up code signing for Maneki's desktop builds. This is a **one-time
setup**: once the repo secrets exist, every `v*` tag automatically builds,
signs, notarizes, and publishes the desktop apps — no per-release steps.

The signed app is the **Tauri macOS** build (the primary). Linux/Windows and
the Electron builds ship unsigned for now.

The release workflow that consumes all of this is
[`.github/workflows/desktop-release.yml`](.github/workflows/desktop-release.yml).

---

## 1. macOS: code signing + notarization

Prerequisite: an active **Apple Developer Program** membership ($99/yr). Do
everything below on your Mac.

### 1.1 Create a "Developer ID Application" certificate

Xcode is easiest:

> Xcode → Settings → Accounts → select your team → **Manage Certificates…** →
> **+** → **Developer ID Application**

This installs the certificate **and its private key** into your *login*
keychain. (Alternatively, create it at developer.apple.com → Certificates,
uploading a CSR from Keychain Access → Certificate Assistant → *Request a
Certificate from a Certificate Authority*.)

### 1.2 Export it as a `.p12`

> Keychain Access → *login* keychain → **My Certificates** → right-click
> *"Developer ID Application: Your Name (TEAMID)"* → **Export…** →
> save as `maneki-cert.p12` → set an **export password** (you'll need it).

Make sure you export the entry that has a disclosure triangle (cert **+**
private key), not a bare certificate.

### 1.3 Collect the six values

```bash
# Signing identity + team id — copy the full "Developer ID Application: ..." line:
security find-identity -v -p codesigning
```

| Secret                       | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY`     | the full `Developer ID Application: Your Name (TEAMID)` string         |
| `APPLE_TEAM_ID`              | the 10-character code in that string's parentheses                    |
| `APPLE_CERTIFICATE`          | base64 of `maneki-cert.p12` (piped in step 1.4)                       |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password from step 1.2                              |
| `APPLE_ID`                   | your Apple ID email                                                   |
| `APPLE_PASSWORD`             | an **app-specific** password (next line)                             |

App-specific password (for notarization — **not** your Apple ID password):

> appleid.apple.com → **Sign-In and Security → App-Specific Passwords → +** →
> name it `maneki-notarize` → copy the `xxxx-xxxx-xxxx-xxxx`.

### 1.4 Add them as repo secrets

Values never leave your machine — `gh` sends them straight to GitHub:

```bash
base64 -i maneki-cert.p12 | gh secret set APPLE_CERTIFICATE --repo winterop-com/maneki
gh secret set APPLE_CERTIFICATE_PASSWORD --repo winterop-com/maneki   # the .p12 export password
gh secret set APPLE_SIGNING_IDENTITY     --repo winterop-com/maneki   # "Developer ID Application: ..."
gh secret set APPLE_TEAM_ID              --repo winterop-com/maneki   # the 10-char id
gh secret set APPLE_ID                   --repo winterop-com/maneki   # your Apple ID email
gh secret set APPLE_PASSWORD             --repo winterop-com/maneki   # the app-specific password
```

`gh secret set NAME` prompts for the value if you don't pipe it in.

### 1.5 Done

```bash
rm maneki-cert.p12      # no longer needed; it's in GitHub secrets now
```

The next `v*` tag's Tauri macOS build is signed + notarized automatically. If
the secrets are absent the build still succeeds — just unsigned.

---

## 2. Tauri auto-updater signing (optional, for later)

Tauri's updater downloads + installs new releases in-app. It uses a **second,
separate** key (minisign — nothing to do with Apple) to sign the update
artifacts so the app trusts them.

> Not wired into the app yet — this is the key setup for when we add the
> updater plugin.

```bash
# Generate the keypair (set a password when prompted):
npx @tauri-apps/cli signer generate -w ~/.tauri/maneki-updater.key
```

It prints a **private** key and a **public** key.

| What                                  | Where it goes                                                  |
| ------------------------------------- | -------------------------------------------------------------- |
| private key (contents of the file)    | secret `TAURI_SIGNING_PRIVATE_KEY`                             |
| the password you set                  | secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                    |
| public key                            | `desktop/tauri/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY          --repo winterop-com/maneki < ~/.tauri/maneki-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo winterop-com/maneki
```

The release workflow then emits a signed `latest.json` the installed app polls
to find updates. (Plumbing the updater plugin + endpoint is a follow-up task.)

---

## Notes

- **Rotation:** to roll a key, repeat the relevant section and overwrite the
  secrets. The Developer ID cert is valid for 5 years.
- **Local builds:** `make build` (and `make desktop-tauri-build`) auto-discover
  the Developer ID from your login keychain, so the local `.app` / `.dmg` come
  out **signed** with no setup. To also **notarize** locally, copy `.env.example`
  to `.env` (gitignored) and fill in `APPLE_ID`, `APPLE_PASSWORD` (app-specific),
  `APPLE_TEAM_ID` — the Makefile sources it. Without those the build still
  succeeds, just signed-but-not-notarized (you'll see a "skipping notarization"
  warning).
- Keep the `.p12` and the updater private key out of git (they're not, and the
  repo has push-protection + secret scanning on).
