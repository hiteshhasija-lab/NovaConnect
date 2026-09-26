# NovaConnect for iOS

A native SwiftUI shell around the NovaConnect web app (WKWebView) — the iOS counterpart of
`electron-app/`. It doesn't bundle the server; it points at your NovaConnect deployment.

- Default server `http://10.0.0.102`, set in `project.yml` (`NOVACONNECT_DEFAULT_SERVER_URL`).
  Users can change it from the "Can't reach NovaConnect" screen; a changed address is saved.
- "Can't reach NovaConnect" screen with Try again / Change server, including a 15 s timeout
  for addresses with nothing behind them (those connections hang rather than fail).
- Camera/mic granted to the configured server's pages only; links that open a new window go
  to Safari; a self-signed certificate is trusted for the configured server only.

## Building

The Xcode project is generated from `project.yml`:

```
brew install xcodegen
cd ios-app
xcodegen generate
open NovaConnect.xcodeproj
```

## Notes

- **Local Network permission:** iOS asks "Allow NovaConnect to find devices on your local
  network?" the first time it connects to a LAN address like `10.0.0.102`; it must be allowed.
- **Simulator:** iOS Simulator apps run on the Mac and are subject to the Mac's Local Network
  rules, which can refuse them LAN access with no way to allow it ("No route to host"). To test
  in the Simulator, relay through loopback, e.g. forward `localhost:8102` → `10.0.0.102:80`, and
  set the app's server to `http://localhost:8102`.
- **Meetings:** iOS only allows camera/microphone on secure (https) pages, so calls need the
  server's `https://` address.
