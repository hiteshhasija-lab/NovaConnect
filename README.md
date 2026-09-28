# NovaConnect

A team chat and collaboration app — the "chat core" of a Microsoft Teams–style product: teams, channels, direct messages, threads, reactions, file sharing, @mentions, and live presence.

## Stack

- Node.js + Express, EJS server-rendered shell, Bootstrap 5
- Postgres via `knex`, session auth with bcrypt-hashed passwords (same pattern as NovaDesk ITSM)
- Socket.IO for real-time messaging, typing indicators, and presence — sharing the Express session, so a socket is authenticated the same way as an HTTP request

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The database is created and seeded automatically on first run with demo users, two teams, channels, and a DM.

## Demo logins

| Username | Password   | Role   |
|----------|------------|--------|
| admin    | admin123   | admin  |
| jdoe     | member123  | member |
| bsmith   | member123  | member |
| mchen    | member123  | member |
| rpatel   | member123  | member |

## What's here (chat core)

- **Teams & channels** — public and private channels, owners can add/remove members, browse-and-join or create-a-team flow.
- **Direct messages** — 1:1 and group DMs.
- **Real-time messaging** — Socket.IO, shares the Express session for auth. Typing indicators, live presence (online/away/busy/DND, auto-online on connect).
- **Threads** — reply-in-thread on any message, separate from the main channel flow.
- **Reactions** — quick emoji reactions, toggle on click.
- **@Mentions** — autocomplete in the composer; mentioned users get an in-app notification (Activity tab), live-updated over the socket.
- **File sharing** — attach a file to any message (channel or DM), 15MB limit, a denylist on executable extensions.
- **Admin** — `/admin/users`: role changes, activate/deactivate accounts.

## What's not here yet

This is the messaging core, not a full Teams parity build — no group audio/video calls, no meeting conferencing, no third-party app/bot ecosystem, no compliance/eDiscovery tooling. Those are large, separate subsystems in real Teams and weren't in scope for this pass.

## Notes

- Deep-links work: `/app/channel/:id` and `/app/dm/:id` are shareable URLs into a specific conversation.
- Presence tracks live socket connections; chat unread, favorite, mute and hidden preferences are persisted per participant. There is no per-message read receipt UI.
- This is a self-contained local app — reset by deleting the `data/` folder (uploaded files) and dropping the `novaconnect` Postgres database.


## Calls and meetings

All calls — 1:1 chats, group chats and channel "Meet now" meetings — and meeting-link meetings send
their audio and video through the **mediasoup SFU** on the server, not browser to browser.

- **Where things live:** `src/sfu.js` (rooms, transports, producers/consumers, recording,
  active-speaker detection); `src/group-calls.js` (who is in which call, ringing, channel posts,
  "Call ended / Missed call" posts); `src/meet-signaling.js` (meeting lobby, the `sfu:*` media
  events and the in-call extras for any call room); `src/callPosts.js` (posting into a chat or
  channel). In the browser: `public/js/sfu-client.js` (send/receive session), `group-calls.js`
  (call panel), `meet-room.js` (meeting page), `call-extras.js` (raise hand, reactions, chat,
  participants, active speaker — shared by both).
- **Behaviour:** a 1:1 call rings the other person and ends when either hangs up; a group-chat
  call rings everyone and anyone in the chat can join while it runs; a channel meeting rings nobody
  and is announced in the channel. Camera/screen can be shared (the screen is a separate stream, so
  the camera keeps going); camera-off and mute are shown to everyone; in-call chat from a chat or
  channel is saved there. The same person may join the same call from two devices.
- **Call state is in memory** (one Node process). A restart ends running calls; stale "Started a
  meeting" posts are rewritten to "Meeting ended" on startup.
- **Network:** browsers need **HTTPS** for camera, microphone and screen sharing. Media flows over
  UDP 40000–49999 to `MEDIASOUP_ANNOUNCED_IP` (the address clients can reach). `public/js/calls.js`
  and `src/calls.js` are the older browser-to-browser calls, kept only for pages that haven't
  reloaded since 1.0.105 (plus the call panel's Maximize/Full screen controls); `WEBRTC_ICE_SERVERS`
  applies only to those.

## Releasing

Releases go through the upgrade pipeline on NOVAAPP01 (`~/novaconnect-upgrades/upgrade-novaconnect.sh`).
From a developer machine, after bumping `src/version.js` and `package.json` together, committing
and pushing:

```bash
scripts/release.sh 1.0.110 "Why this release." "One line for the release notes." "path/file.js: what changed." "..."
```

It refuses to run unless local HEAD is `origin/main` and both version files match, builds the
release directory (overlay tarball from `git archive`, manifest, notes, checksums), runs `--check`
then `--yes` (health check and automatic rollback), prints the post-deploy checklist and updates
`STABLE-RELEASE.json`. Overlay releases only: new dependencies need `localhost/novaconnect:base`
rebuilt first, and schema changes need `"databaseChanges": true`. SSH key, user and hosts can be
overridden with `NOVACONNECT_SSH_KEY`, `NOVACONNECT_SSH_USER`, `NOVACONNECT_HOSTS`.


## Chat header, meetings and concerns

The direct-message header provides icon controls for video, audio, Add People, conversation search, and More. Add People creates a new group including the current chat members and selected active users; it preserves the existing conversation. People can be found by name, username or email (phone numbers are not stored).

Conversation search searches persisted message bodies and thread replies, excludes deleted messages, returns 50 matches at a time, and requires conversation membership. Search treats punctuation and wildcard characters literally.

The More menu provides:

- Open in new window (Command/Ctrl+O while focused outside an input).
- Schedule meeting: a full editor with selected-time-zone dates, all-day events, up to 52 daily/weekly/monthly occurrences, attendees, location, rich text, RSVP and Busy/Free options. Invitations appear in NovaConnect Activity and attendee calendars; they are not external email/calendar invitations. Attendees can respond, and the organizer can cancel an occurrence. This does not add group video conferencing.
- Screen sharing (Command/Ctrl+Shift+E): starts a one-to-one video call with a selected screen, or replaces the video source during an existing audio/video call. Browser permission is required each time. Stop sharing restores the camera if available. System audio is not captured.
- Mark as unread, Favorite and Mute: per-user preferences persist and synchronize across tabs. Muting suppresses the conversation's unread badge; it does not block calls or remove messages.
- Report a concern: category and optional details are stored with the reporter, chat and timestamp. Administrators review reports at `/admin/reports`, linked from Manage Users. Reports are not transmitted to external services.
- Delete: hides the chat from your own list after confirmation, preserving everyone’s messages. New messages bring it back; opening the conversation explicitly restores it.

Database initialization applies additive participant-preference columns and creates `meetings`, `meeting_attendees` and `chat_reports`; notifications gain a meeting reference. Back up the database before deploying. The previous application can run with these extra tables/columns left in place during an image rollback.

Validation: `node --test test/*.test.js`. An isolated PostgreSQL database and Chrome sessions were used to verify UI actions, access control, persistence, search, group membership, meeting notifications/calendar/RSVP and administrator reports. Simulated browser media tests verified audio/video and screen sharing; real-device/cross-network validation still depends on browser permissions and relay configuration.

### Interface spacing standard
New controls use the compact three-dot menu as their reference. Shared sizing and spacing tokens live in `public/css/ui-density.css`; implementation guidance is in `AGENTS.md`. Single-line controls use a 36px minimum height, with content-driven growth for multi-line rows.

### Meet hub
The Meet sidebar opens reusable meeting links, standalone scheduling, join by ID/link, and upcoming invitations. Signed-in active users with a link may enter a room. Rooms support up to six participants using peer-to-peer WebRTC; microphone and camera access begins only after joining. The same `WEBRTC_ICE_SERVERS` configuration used by calls supplies TURN/STUN for rooms. Without TURN, connections across some networks may fail. Anonymous guests, recording, and large conferences are not supported.
