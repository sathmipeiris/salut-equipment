# Install it like an app (phone, tablet, desktop)

The staff page is a **Progressive Web App (PWA)**. Staff install it from the browser onto the home screen / desktop; it then opens full-screen with its own icon, starts even with no signal, and updates itself whenever the server is updated. No app store, no APK, no fee.

## The one requirement: HTTPS
Browsers only offer "Install" on a **secure address** (`https://…`, or `http://localhost` on the same computer). A plain `http://192.168.x.x:3000` address works as a normal web page but will **not** offer installation, camera scanning or offline mode. Free ways to get HTTPS (verify current terms before relying on them):

| Option | Notes |
|---|---|
| Cloudflare Tunnel | Gives an `https://` address that reaches the office computer, no router changes. Also lets staff on job sites use the same address. |
| Tailscale (with HTTPS enabled) | Private network between company devices; good if the app should *not* be on the public internet. |
| Reverse proxy + certificate on a domain you own | Most conventional; a domain name usually costs a small yearly fee. |

When running behind HTTPS set `COOKIE_SECURE=1` and `TRUST_PROXY=1` (see the README).

## How staff install it

| Device | Steps |
|---|---|
| **Android (Chrome)** | Open the address → tap the blue **Install** button on the home screen (or Chrome menu ⋮ → *Install app*). |
| **iPhone / iPad (Safari)** | Open the address in **Safari** → Share button → **Add to Home Screen**. (iOS does not allow an in-page Install button; the app shows these steps instead.) |
| **Windows / Mac / Chromebook (Chrome or Edge)** | Click the blue **Install** button, or the install icon at the right of the address bar. |
| **Mac (Safari 17+)** | File → **Add to Dock**. |

Once installed:
- Press-and-hold (Android) or right-click (desktop) the icon for shortcuts: **Sign out** and **Return**.
- It opens even offline; transactions made offline upload automatically on reconnect.
- **Kiosk tablet:** open `https://your-address/?kiosk=1` once, then install. The kiosk setting is remembered on that device.
- To remove it: uninstall like any other app.

## About a real APK (Android file)
I did **not** build an APK, because it needs an Android build toolchain, a signing key and a public HTTPS address, and the PWA above already gives the same result for this app. If SaLUT specifically wants an APK (for example, to push through a device-management system), it can be generated *from* the PWA once it is deployed:

1. Deploy on HTTPS (above).
2. Use **PWABuilder** (pwabuilder.com) or Google's **Bubblewrap** CLI, pointing at the live address, to produce a signed Android package (a Trusted Web Activity).
3. Put the generated `assetlinks.json` in `public/.well-known/` so the app opens without a browser address bar.
4. Install the APK directly on company phones (allow "install unknown apps"), or publish to Google Play (Google charges a one-time developer fee; check the current amount).

The APK is only a thin wrapper around this same web app, so nothing in the code has to change.
