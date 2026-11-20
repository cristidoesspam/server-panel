# Server panel (Android)

A window onto the Minecraft server panel that runs on the laptop (`panel`).
A WebView app with no libraries: it tries the saved addresses in order (home Wi-Fi `192.168.1.20:8790`, then
Tailscale `100.64.0.5:8790`) and shows the panel. What it adds to a plain browser:

- file picker for uploads (mods, world zips, files),
- downloads (world backup, files) into the phone's Downloads folder, with the sign-in cookie,
- a "can't reach it" screen with Try again / Change address,
- Back goes to the Overview tab first, then leaves,
- opens any link that is not the panel in the normal browser.

The panel is plain `http://` on purpose (home network / Tailscale only), so the app allows cleartext traffic
but only ever loads the addresses you set.

Build: `gradlew.bat assembleRelease --offline` -> `app/build/outputs/apk/release/app-release.apk`
(signed with this machine's debug key; copy to `dist/ServerPanel-<version>.apk`).
Install: `adb install -r dist/ServerPanel-1.0.apk` or open the .apk on the phone (allow installs from this source).
