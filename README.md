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

This is the messaging core, not a full Teams parity build — no audio/video calls or screen share (needs a media/SFU server), no calendar/meetings, no third-party app/bot ecosystem, no compliance/eDiscovery tooling. Those are large, separate subsystems in real Teams and weren't in scope for this pass.

## Notes

- Deep-links work: `/app/channel/:id` and `/app/dm/:id` are shareable URLs into a specific conversation.
- Presence and unread badges are in-memory for the current session — they reset on a server restart / page load, there's no persisted read-cursor yet.
- This is a self-contained local app — reset by deleting the `data/` folder (uploaded files) and dropping the `novaconnect` Postgres database.
