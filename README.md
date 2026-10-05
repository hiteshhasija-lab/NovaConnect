# NovaConnect

A team chat and collaboration app — the "chat core" of a Microsoft Teams–style product: teams, channels, direct messages, threads, reactions, file sharing, @mentions, and live presence.

## Stack

- Node.js + Express, EJS server-rendered shell, Bootstrap 5
- Postgres via `knex`, session auth with bcrypt-hashed passwords (same pattern as NovaDesk ITSM)
- Socket.IO for real-time messaging, typing indicators, and presence — sharing the Express session, so a socket is authenticated the same way as an HTTP request

## Run it (development)

Needs Node.js 22, Postgres 16 and Redis on this machine (Meilisearch optional, for search).

```bash
npm install
PGPASSWORD=… SEED_DEMO=true npm run dev
```

Then open http://localhost:3000. On first start NovaConnect creates its tables (migrations apply
themselves) and, with `SEED_DEMO=true`, a demo workspace: sample users, two teams, channels and a DM.
Database settings: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (defaults
`localhost`, `5432`, `novaconnect`, none, `novaconnect`).

## Demo logins (`SEED_DEMO=true` only)

| Username | Password   | Role   |
|----------|------------|--------|
| admin    | admin123   | admin  |
| jdoe     | member123  | member |
| bsmith   | member123  | member |
| mchen    | member123  | member |
| rpatel   | member123  | member |

Never use the demo workspace on a real install: everyone knows these passwords.

## Fresh install (server)

One server running NovaConnect, Postgres, Redis and Meilisearch with Docker Compose or Podman
Compose (`compose.yaml`). Nothing here is specific to the NOVAAPP01 lab.

**You need:** Docker with the compose plugin, or Podman with `podman compose`; the server's IP
address (or a DNS name) that users' browsers reach; a TLS certificate for that name or IP.

1. **Get the code:** `git clone https://github.com/hiteshhasija-lab/NovaConnect.git && cd NovaConnect`
2. **Settings:** `cp .env.example .env`, then fill in every value under "Required". Generate each
   secret with `openssl rand -hex 32`. Set `MEDIASOUP_ANNOUNCED_IP` to the server's IP as browsers
   reach it, and `ADMIN_USERNAME` / `ADMIN_PASSWORD` for the first admin account.
3. **Certificate:** put the private key and certificate in `certs/key.pem` and `certs/cert.pem`.
   Browsers only allow camera and microphone on https, so calls need this. For a lab, `mkcert`
   makes one (`mkcert -key-file certs/key.pem -cert-file certs/cert.pem <ip-or-name>`), and each
   device must trust mkcert's root certificate. Without a certificate the app runs on http only.
4. **Firewall:** open TCP 80 and 443 (or `NOVACONNECT_HTTP_PORT` / `NOVACONNECT_HTTPS_PORT`) and
   **UDP 40000–49999** (call and meeting media).
5. **Start:** `docker compose up -d --build` (or `podman compose up -d --build`). The first build
   takes a few minutes. Then open `https://<server>` and sign in as the admin.

On first start NovaConnect creates its database tables and the admin account. The NovaDesk
integration, AI features and S3 storage stay off until their settings are filled in.

**Upgrading:** `git pull` then `docker compose up -d --build`. New database migrations apply
themselves when NovaConnect starts; back up first (below). If one fails, NovaConnect stops instead
of running on a half-updated database, and `docker compose logs novaconnect` says why.

**Backups:** the database is the `pgdata` volume, uploads and recordings the `uploads` volume.
For example: `docker compose exec postgres pg_dump -U novaconnect -Fc novaconnect > novaconnect.dump`.

**Host notes**
- *Rootless Podman:* binding ports 80/443 needs `sysctl net.ipv4.ip_unprivileged_port_start=0`
  (or use ports above 1024). Reserve the media range so nothing else takes a port from it
  (`net.ipv4.ip_local_reserved_ports=40000-49999`), or the pod can fail to start after a reboot.
- *Docker:* publishing 10,000 UDP ports through Docker's userland proxy is slow and heavy; set
  `"userland-proxy": false` in `/etc/docker/daemon.json`.
- *SELinux (RHEL, Fedora):* `compose.yaml` mounts `certs/` with `:z` so the container can read it.
  Don't mount this whole folder into other containers with `:Z`: that relabels it for one container
  and locks the others out of their data.

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
- Development reset: delete the `data/` folder (uploaded files) and drop the `novaconnect` Postgres database; the next start recreates the tables.


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
- **Capacity (measured 2026-09-29, 1.0.124, NOVAAPP01: 2 cores):** a 10-person group call, everyone
  receiving everyone at 720p, used ~15% of a core in the mediasoup worker and ~20% in rootless
  Podman's user-space networking (`pasta`, which carries every RTP packet), with the VM ~80% idle;
  42 Mbit/s out with synthetic video (real cameras send ~1–1.5 Mbit/s each at 720p, so expect
  roughly double). With small tiles, simulcast cut outgoing traffic by 65% (6 people: 14.3 → 5.0
  Mbit/s). Since 1.0.126 there is one mediasoup worker per core (`MEDIASOUP_WORKERS` overrides),
  each on its own slice of the UDP range, and each new room goes to the least busy one (two
  5-person meetings: one per worker, ~8% of a core each). A single call stays on one worker.
  `pasta` is left in place for now (decided 2026-09-29): at ~20% of a core per 10 people it
  becomes the limit around 40–50 people; host networking for the pod is the fix then.
- **Call state is in memory** (one Node process). A restart ends running calls; stale "Started a
  meeting" posts are rewritten to "Meeting ended" on startup.
- **Network:** browsers need **HTTPS** for camera, microphone and screen sharing. Media flows over
  UDP 40000–49999 to `MEDIASOUP_ANNOUNCED_IP` (the address clients can reach). The older
  browser-to-browser 1:1 calls (`src/calls.js`, `WEBRTC_ICE_SERVERS`) and the `sfu-signaling.js`
  prototype were removed in 1.0.118; `public/js/calls.js` now only holds the call panel's
  Maximize/Full screen controls and `setCallToggle`.

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
The Meet sidebar opens reusable meeting links, standalone scheduling, join by ID/link, and upcoming invitations. Signed-in active users with a link may enter a room. Everyone first waits in a lobby until the meeting owner admits them; audio and video go through the SFU like calls (see Calls and meetings). Microphone and camera access begins only after joining. The owner can record; the meeting chat is kept after the meeting and readable from the Meet page by the owner and anyone who was let in. Anonymous guests are not supported.
