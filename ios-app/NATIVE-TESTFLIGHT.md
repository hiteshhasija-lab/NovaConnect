# Native iOS implementation and TestFlight release gates

## Targets

- `NovaConnect`: original WKWebView client, unchanged and still available.
- `NovaConnectNative`: SwiftUI application, bundle `com.novaconnect.native`, version 0.1.0 (6). This separate ID avoids replacing the working phone installation during development.
- `NovaConnectNativeTests`: native contracts/security/formatting tests.

Generate the project from `project.yml` with XcodeGen. No new third-party packages were added. The native target links no WebKit code and uses NavigationStack, TabView, native forms, Lists, file importer, Quick Look, and URLSession.

## Implemented initial native scope

- HTTPS server configuration, JSON login, session restoration from Keychain, server logout.
- Direct/group conversation list and creation through People search.
- Message history and pagination; text/file sending; quote replies in the same conversation; reactions; own-message edit/delete; attachment download and Quick Look.
- Membership-filtered team/channel navigation and channel messaging, with server authorization enforced.
- Foreground Socket.IO text-event connection with heartbeat responses/reconnection; refresh after reconnect; background disconnect; presence selection.
- Account/status message; light/dark/system mode; scheduled meeting list; activity/read acknowledgement; Gemini conversation.
- Native safe-area/keyboard layout, dynamic system fonts and accessible control labels.

## Server companion change — deployed in v1.0.156

`src/mobileSession.js`, mounted at `/api/mobile`, provides login/session/logout using the existing Express session store. Login rotates the session ID; active status and role are revalidated; responses are no-store; password hashes are never returned. Login is covered by the existing auth rate limiter. Existing web authentication and endpoints are preserved. No database migration is required.

The mobile endpoint was deployed with user authorization to NOVAAPP01 in v1.0.156 (5dec405). Production health returned 200; unauthenticated session returned 401; an empty login returned 400. Authenticated phone testing still requires the user to sign in.

## Transport and session security

The native client requires HTTPS and normal platform certificate validation. Build 2 bundles the verified public mkcert lab CA for novaconnect.lab.sps and 10.0.0.102 only. The URLSession delegate validates the chain, hostname and validity dates with SecTrustEvaluateWithError using that CA as an explicit anchor. Other hosts retain default iOS trust. No system-wide trust is changed, and no private CA key is included. Remove this deployment-specific anchor when moving to a public-CA production hostname. The default native hostname is `novaconnect.lab.sps` and is editable before sign-in. LAN/VPN connectivity and DNS must work on each tester's phone.

Passwords are used for login only, never saved. Session cookies are stored in Keychain with `AfterFirstUnlockThisDeviceOnly`. API redirects are rejected to avoid carrying credentials to a different server. Consequently, cross-origin object-storage download redirects are not supported by this initial client.

## Remaining implementation and validation before a full-feature beta

- Native SFU/WebRTC calling, meetings/lobbies, screen broadcast extension, recordings, captions, whiteboard, breakout rooms, device/media handling and CallKit.
- APNs device registration, server notification delivery, background/incoming-call handling. The current socket works only while foregrounded; it is not push notification support.
- Meeting scheduling/invitation management, join-link workflows and calendar editing.
- Complete team/channel creation/deletion, membership roles and moderation, admin/user settings.
- Message forwarding, full server search, pinned/scheduled messages, old thread navigation, report/block controls, rich message metadata and workflow approval cards.
- Native decommission messages use existing server trigger logic, but interactive approval/confirmation cards are not implemented. Do not use this preview as the sole operational client.
- Large attachment streaming/progress, S3 redirect support, richer media rendering.
- End-to-end tests against the staging server with two accounts, revoked permissions, network loss/reconnect, keyboard/VoiceOver/Dynamic Type, compact iPhone/iPad and both appearances. Current unit tests do not establish that parity.
- App Store privacy disclosures covering account information, messages, attachments and diagnostics. Privacy manifest currently declares this target's UserDefaults use; complete the full product review before distribution.

## TestFlight prerequisites

The user confirmed they are **not enrolled** in the paid Apple Developer Program. Distribution is blocked until enrollment and App Store Connect access are ready. Do not enroll, pay, accept agreements, or invite testers on the user's behalf without the required authorization.

After implementation/validation:
1. Confirm a paid team, app identifier, App Store Connect record and distribution signing.
2. Finalize privacy policy/support URL, export compliance answers, beta description and review instructions. Do not guess legal answers.
3. Provide a reachable review/test environment and test account; an inaccessible LAN-only server is insufficient for external review.
4. Increment the native build number and archive `NovaConnectNative` in Release for generic iOS.
5. Validate/upload through Xcode Organizer, then configure internal testing; external testing may require beta review.

Official references:
- https://developer.apple.com/testflight/
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/

This is an initial native implementation, **not a TestFlight-ready release or full feature replacement**. The server API was committed, pushed and deployed. Native client source is tracked in the Phase 1 commit; the development preview was installed alongside the wrapper on the user’s iPhone. No TestFlight upload has occurred.

## Native UI build 3

Teams-style compact chat list with All/Unread/Favorites/Groups filters, latest-message ordering, dates, presence avatars and unread dots. Activity/Chat/Teams/People/More bottom navigation opens on Chat. Profile and new-chat shortcuts are in the chat header. Conversation screens hide the bottom tabs, use an inline title, adaptive message surfaces, a paper-plane send control, a multiline composer and horizontal reaction scrolling. Blue/cyan branding, user-approved message alignment, native safe areas, dark mode and certificate validation are preserved. This update does not add calling or push support.

## Phase 1 — build 4

Stabilization includes generation-guarded socket reconnection, queued timeline refreshes, deduplicated pagination and refresh through retained history after reconnect. Permission errors no longer incorrectly expire a session; expiration notifications identify the originating client. Transient restoration failures preserve stored sessions. Text drafts survive navigation within the signed-in session, and editing preserves the unsent draft. Incoming messages no longer force scrolling while reading older history; a jump-to-latest control is available. Attachment downloads use a dedicated protected temporary cache, cleared on logout, and uploads use the file MIME type.

Regression coverage adds overlapping history, reconnect gaps, invalid pagination, forbidden versus expired sessions, and attachment path containment. These are deterministic simulator tests, not two-account production validation.

Still required to close Phase 1: two-account send/reply/edit/delete/reaction checks, real network loss and session expiry, revoked channel access, and physical-device keyboard, long-message, attachment, VoiceOver, large text, and light/dark appearance checks. Drafts are memory-only; app termination does not preserve them. No server deployment, remote push, or TestFlight upload is part of this build.

## Build 5 — unread correction

Reading a native DM now sends the read receipt and clears the separate `is_unread` preference through the existing server APIs. A regression test verifies both requests and the Boolean preference payload. All 14 simulator tests passed; the signed iPhone build succeeded. No server changes are required.

User confirmed build 4 light/dark mode, keyboard, attachments, two-account messaging, replies, edits, deletion and reactions. Unread correction awaits user verification in build 5. Native calling remains pending; the absence of a call button reflects missing media/signaling support, not a hidden existing feature.

## Build 6 — sender names in chat previews

Last-message previews show `You: …` for the signed-in user's messages and the author's name for other messages, in direct and group chats. Reply previews use the reply text rather than the quoted original. Deleted messages retain the author prefix without exposing their former content; attachment-only messages show `Attachment`. Empty conversations retain `No messages yet`. Existing API author fields are used; no server changes are needed. All 15 simulator tests passed.
