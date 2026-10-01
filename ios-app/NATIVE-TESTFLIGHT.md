# Native iOS implementation and TestFlight release gates

## Targets

- `NovaConnect`: original WKWebView client, unchanged and still available.
- `NovaConnectNative`: SwiftUI application, bundle `com.novaconnect.native`, version 0.1.0 (30). This separate ID avoids replacing the working phone installation during development.
- `NovaConnectNativeTests`: native contracts/security/formatting tests.

Generate the project from `project.yml` with XcodeGen. Native audio calls use the MIT-licensed mediasoup-client-swift 0.13.2 package and its WebRTC framework. The native target links no WebKit code and uses NavigationStack, TabView, native forms, Lists, file importer, Quick Look, and URLSession.

## Implemented initial native scope

- HTTPS server configuration, JSON login, session restoration from Keychain, server logout.
- Direct/group conversation list and creation through People search.
- Message history and pagination; text/file sending; quote replies in the same conversation; reactions; own-message edit/delete; attachment download and Quick Look.
- Membership-filtered team/channel navigation and channel messaging, with server authorization enforced.
- Foreground Socket.IO text-event connection with heartbeat responses/reconnection; refresh after reconnect; background disconnect when no call is active; presence selection.
- Account/status message; light/dark/system mode; scheduled meeting list; activity/read acknowledgement; Gemini conversation.
- Native safe-area/keyboard layout, dynamic system fonts and accessible control labels.

## Server companion change — deployed in v1.0.156

`src/mobileSession.js`, mounted at `/api/mobile`, provides login/session/logout using the existing Express session store. Login rotates the session ID; active status and role are revalidated; responses are no-store; password hashes are never returned. Login is covered by the existing auth rate limiter. Existing web authentication and endpoints are preserved. No database migration is required.

The mobile endpoint was deployed with user authorization to NOVAAPP01 in v1.0.156 (5dec405). Production health returned 200; unauthenticated session returned 401; an empty login returned 400. Authenticated phone testing still requires the user to sign in.

## Transport and session security

The native client requires HTTPS and normal platform certificate validation. Build 2 bundles the verified public mkcert lab CA for novaconnect.lab.sps and 10.0.0.102 only. The URLSession delegate validates the chain, hostname and validity dates with SecTrustEvaluateWithError using that CA as an explicit anchor. Other hosts retain default iOS trust. No system-wide trust is changed, and no private CA key is included. Remove this deployment-specific anchor when moving to a public-CA production hostname. The default native hostname is `novaconnect.lab.sps` and is editable before sign-in. LAN/VPN connectivity and DNS must work on each tester's phone.

Passwords are used for login only, never saved. Session cookies are stored in Keychain with `AfterFirstUnlockThisDeviceOnly`. API redirects are rejected to avoid carrying credentials to a different server. Consequently, cross-origin object-storage download redirects are not supported by this initial client.

## Remaining implementation and validation before a full-feature beta

- Native video, meetings/lobbies, screen broadcast extension, recordings, captions, whiteboard, breakout rooms, and full device/media controls. Audio and CallKit are implemented as of build 18; device acceptance is still pending.
- APNs/PushKit device registration and server notification delivery. A suspended app cannot receive new calls yet. Active calls use background audio as of build 18; this does not wake the app for a new call.
- Meeting scheduling/invitation management, join-link workflows and calendar editing.
- Complete team/channel creation/deletion, membership roles and moderation, admin/user settings.
- Message forwarding, full server search, pinned/scheduled messages, old thread navigation, report/block controls, rich message metadata and workflow approval cards.
- Native decommission cards are implemented in build29; physical workflow acceptance remains pending. Existing server authorization and NovaDesk workflow rules govern actions.
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

## Build 7 — tighter message spacing

Reduced the vertical gap between timeline messages from 12 to 8 points for direct, group and channel conversations. Font sizes and internal bubble padding remain unchanged.

## Build 8 — automatic presence selection

Selecting a presence sends the change immediately; the Update status button is removed. The picker follows server presence updates, prevents overlapping sends, and restores the confirmed status with an error if sending fails. The separate status-message save action remains unchanged.

## Build 9 — avatar badge spacing

Presence badges sit outside the lower-right avatar edge with reserved layout space and a background ring. Initials scale with avatar size, preventing the compact chat-header profile badge from covering them or adjacent text.

Build 9 also reduces message gaps from 8 to 6 points, preserving text sizes and internal bubble padding.

## Build 10 — non-overlapping presence and 4-point message gaps

Presence now occupies its own fixed-width space beside the avatar, instead of an overlay, preventing overlap with initials or neighboring profile text. Timeline message gaps are 4 points.

The in-app Build section reads CFBundleShortVersionString and CFBundleVersion from the installed bundle, so subsequent builds display their actual version automatically.

## Build 11 — correct chat-list density

User clarified that reduced spacing applies between conversations in the chat list, not messages within a conversation. Chat-row vertical padding is reduced from 7 to 2 points per edge (4 points total custom padding). Timeline message spacing is restored to its original 12 points. Text sizes and preview content are unchanged.

## Build 12 — compact chat rows and direct status picker

Chat rows now use explicit 3-point top/bottom list insets without extra vertical padding. The chat-header profile button opens a dedicated live-status sheet; selecting an option sends the presence immediately. Errors remain visible in the sheet. More remains available separately.

## Build 13 — chat-list spacing adjustment

Chat-row top/bottom insets increased slightly from 3 to 5 points per edge. Message spacing inside conversations is unchanged.

## Build 14 — profile pictures (requires companion server deployment)

More → Change profile picture uses the system photo picker, converts the selection to a JPEG up to 1024 pixels per side, and uploads through the authenticated profile-photo endpoint. Native avatars load through the authenticated API session and refresh after the current user uploads. Other users’ changed pictures refresh when avatar views reload.

Web My Profile accepts JPEG/PNG up to 5 MB. Photos are stored under LOCAL_UPLOAD_ROOT/profile-photos (default data/uploads/profile-photos), with one atomically replaced file per user. This directory must be persisted and included in backups; shared deployments must share that volume. This photo storage is local even when chat attachments use S3. No database migration or new dependency. Native channels already share the DM left/right layout.

Build 14 compiled for iPhone; installation is held for the companion server deployment. Upload and photo display need authenticated user acceptance testing after deployment.

## Build 15 — slightly roomier chat list

Conversation-row insets increased from 5 to 7 points at the top and bottom. Message spacing inside conversations and font sizes remain unchanged.

## Build 16 — foreground native audio-call preview

Chat headers expose audio calling through existing gcall and SFU signaling. Incoming audio calls while the app is open show Answer/Decline. Native media handles microphone capture, remote audio, mute, speaker and hang-up. Socket requests now support acknowledgments, timeout errors and disconnect cleanup. Returning from the microphone permission prompt does not restart a healthy socket. This is an unverified audio preview until a two-account iPhone/web call confirms both directions.

Calls end when this preview enters the background or loses its live connection. There is no CallKit, push/incoming background ringing, video support or native meeting UI yet. Bluetooth routing and interruptions require physical-device validation. Do not claim full calling parity. No server changes are required for this preview.

Dependency: MIT-licensed VLprojects/mediasoup-client-swift 0.13.2 (revision a3206f704fb2f13390c74df45dba692a1c8a5598), with upstream binary Mediasoup and WebRTC frameworks, pinned by Package.resolved and artifact SHA-256 checksums. See https://github.com/VLprojects/mediasoup-client-swift. Review all bundled WebRTC third-party license/privacy requirements before distribution.

Xcode initially stalled while downloading binary artifacts. Official release archives were downloaded directly and their SHA-256 checksums verified against Package.swift, then placed in SwiftPM's artifact cache. Normal project package resolution subsequently succeeded. The temporary verification project is not required for the app.

## Build 17 — audio producer lookup correction

Pass the sender peer ID from both producer announcements and the initial producer list as `appData.sourcePeerId` when consuming audio. The server requires this alongside the producer ID; omitting it caused “Producer not found.” Device build and 18 simulator tests passed. Installed on both phones; two-way audio still requires device testing. No server changes.

## Build 18 — system call controls and active-call background audio

- Native CallKit incoming/outgoing call UI, answer, decline/end and mute use the existing authenticated signaling. One call at a time; hold/group/DTMF and Recents are disabled because those workflows are not implemented.
- WebRTC uses manual audio coordinated with CallKit activation/deactivation. Added the audio background mode; the app keeps its socket while a call is active and waits for end/decline signaling before closing an idle background connection.
- Removed the unconditional call termination on backgrounding. This is active-call support, not background incoming push support.
- Tests use an injected system provider, covering duplicate rings, cancellation before display, rejected incoming display, invalid calls, system mute/end, and existing call disconnect behavior.
- Physical checks still required: both-direction audio, mute/speaker/Bluetooth, lock during call, switching apps, interruptions and remote/local hang-up.

### Remaining push delivery work and prerequisites

A paid Apple Developer team with Push Notifications enabled, APNs signing key and matching provisioning is required before enabling PushKit. No credentials or push entitlement are included in this Personal Team build.

The server must store user-bound VoIP device tokens through authenticated registration, invalidate them on logout/reassignment and APNs rejection, and send short-lived call notifications only to authorized invitees. Push payloads must identify an actual incoming call and must not include message history or session credentials. The app must report the call to CallKit immediately, reconnect with its existing protected session, validate call membership/state and dismiss ended/answered-elsewhere calls. Add duplicate/stale delivery and logout tests before enabling push. This integration is not implemented or deployed in build 18.

Reference: https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit

## Build 19 — CallKit configuration correction

Added the missing `voip` entry alongside `audio` in UIBackgroundModes. Apple identifies this omission as the common cause of CallKit requesttransaction error 1 (unentitled). Added a regression test that reads the built app bundle, not just the source plist. This does not enable APNs/PushKit delivery; incoming ringing while suspended still requires that separate integration.

## Build 20 — native video-call preview

Separate camera icon beside the audio icon starts video calls in direct/group chats. Incoming video calls use CallKit’s video indication; answering starts with camera off. The caller’s camera starts after microphone/camera permission and media setup. Native WebRTC video tiles show remote streams, names, camera-off placeholders and local preview. Camera on/off, front/back switching, mute, speaker and hang-up are available. Remote screen streams can be viewed; native screen broadcast is not implemented.

Camera capture stops on backgrounding and call end; returning to the app does not automatically re-enable it. Permission denial preserves audio. Existing SFU signaling, memberships and auth remain unchanged, with no server deployment required. Physical two-phone video/audio, camera switching, remote pause, group participants, interruption and background checks remain required. APNs/PushKit, scheduled meeting participation and TestFlight are still separate pending work.

## Build 21 — separate visible call toolbar items

Moved audio and video actions out of a shared ToolbarItem into individual trailing toolbar items. Added accessibility identifiers for both actions. No media or server behavior changed.

## Build 22 — chat header and last seen

Call buttons are explicitly arranged in a compact horizontal toolbar container. Chat identity is leading beside the native back arrow, with current presence or the recorded offline last-seen time beneath it. One-to-one chat participant data refreshes on presence changes and reconnect. Server/web companion 1.0.162 exposes the stored last_seen_at in existing authorized chat responses; deployment is required for mobile timestamps. Group/channel headers do not invent a collective last-seen time.

## Build 23 — readable chat header

Replaced auto-grouped navigation toolbar content with a safe-area header: back control, leading flexible name/subtitle, and two independent circular audio/video buttons with 4pt separation. The name can wrap to two lines; no fixed toolbar capsule constrains it. Native navigation bar is hidden only in the conversation; an explicit dismiss button returns to the chat list.

## Build 24 — shared native glass chrome

Shared Liquid Glass surfaces and glass button styles on iOS26+, with material/bordered fallbacks on iOS17–25. Applies to chat filters, independent call/back controls, composer input/attachment/send, message actions, call controls, sign-in/profile actions and Gemini composer. Native tabs, navigation, menus and sheets retain system glass styling. Message bodies and form content remain solid for readability. Reduce Transparency/increased contrast use opaque surfaces; Reduce Motion disables custom interactive glass. No call, API or messaging behavior changes.

## Build 25 — chat identity avatar

Circular 32pt avatar precedes the chat header name. Direct chats use the existing authenticated profile-photo loader with initials fallback. Group/channel or loading states use title initials. The header omits the separate avatar presence symbol to preserve name width; presence remains below the name. Other avatar placements retain their status badges.

## Build 26 — small chat header spacing adjustments

Header avatar increased from 32pt to 36pt, including initials fallback. Separate audio/video glass buttons now have an 8pt gap instead of 4pt. Other avatar placements and messaging remain unchanged.

## Build 27 — Calendar tab

Bottom navigation is Chat, Calendar, Teams, People, More. Calendar opens the existing scheduled-meetings view; Activity moves under More > Workspace to keep five visible tabs and preserve access. Calendar participation/scheduling capabilities are unchanged.

## Build 28 — restore Activity tab

Restored Activity before Chat, retaining Calendar immediately after Chat and all existing Teams, People and More destinations. Uses native TabView overflow on devices where all six destinations cannot be shown directly.

## Build 29 — native decommission workflow cards

Decode message metadata and render approval/rejection details, Complete/Skip CTASKs, Skip all checks, final destruction/cancellation checkpoint and terminal summary. Resolved approval cards retain full details with Approved/Rejected labels; original message body and separate confirmation messages remain intact. Existing authenticated /api/decom routes receive the same context as web. Busy/submitted controls prevent repeat taps; errors are displayed and status is reloaded from the server rather than fabricated locally. Permanent destruction and power-back-on require confirmation, matching web behavior.

Scoped bot:thinking events render a three-dot processing bubble, cleared by the stop event, disconnect, navigation, or 30-second safety timeout. Reduce Motion shows static dots. Tests cover metadata preservation, numeric IDs, resolved/unknown action rejection, DM/channel action context and summary fields. No live workflow actions were executed during testing. No server deployment is required for these native additions.

## Build 30 — complete workflow warning

Workflow cards expand vertically at their available width. The permanent-destruction warning explicitly allows unlimited lines with vertical intrinsic sizing so its full text remains visible on narrow screens and at larger text sizes. No workflow actions changed.

Build 30 also restores a live presence badge at the bottom-right of the chat header avatar, including profile photos, within its existing footprint. Existing presence events refresh the contact.
