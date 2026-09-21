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


## Direct-message calling

Open a one-to-one direct message and select **Call** (audio) or **Video**. The other person must have NovaConnect open. They can accept or decline; either participant can mute, switch their camera off during a video call, or end the call. Incoming calls appear across the recipient's open workspace tabs; answering one dismisses the others. Unanswered calls expire after 30 seconds. Calls end when the participating tab disconnects, reloads, or leaves the workspace.

Calls use browser WebRTC for media and authenticated Socket.IO events for signaling. Membership and active accounts are checked on the server, and signaling is restricted to the originating and answering tabs. No recording or persistent call history is added. This first version supports two people, not group/channel calls. Call state is in memory: run one Node process; multi-instance deployment needs shared call coordination and a Socket.IO adapter before enabling calls across instances.

### Deployment

- Use a trusted **HTTPS** URL (localhost is suitable for local testing). Browsers require a secure context and permission to access the microphone/camera.
- Configure `WEBRTC_ICE_SERVERS` as a JSON array of RTCIceServer objects in the app process/container environment. It defaults to `[]`, suitable only when peers can connect directly (for example on the same network).
- For calls across NAT/firewalls, supply your organization's STUN and TURN service. Example shape (replace these placeholders):

  ```text
  WEBRTC_ICE_SERVERS=[{"urls":"stun:relay.example.com:3478"},{"urls":["turn:relay.example.com:3478","turns:relay.example.com:5349"],"username":"call-user","credential":"temporary-turn-credential"}]
  ```

  ICE configuration is sent only to authenticated active users. TURN credentials must be client-usable relay credentials; never put administrative secrets here. Short-lived credentials are preferable for production (this static configuration must be rotated externally). Relay provisioning is separate from the app code.
- No new npm dependencies or schema changes are required; include the updated `src`, `views`, and `public` files in the usual release overlay.

### Validation

Run `node --test test/calls.test.js`. Before deploying, use two accounts in separate browsers over HTTPS: verify audio/video in both directions, reject/cancel, no-answer timeout, mute/camera toggles, busy handling, answering across multiple tabs, and disconnect cleanup. Repeat from different networks with TURN configured. Automated signaling tests do not replace a real microphone/camera and network test.


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
