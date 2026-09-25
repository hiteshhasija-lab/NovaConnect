# NovaConnect vs Microsoft Teams — Gap Analysis & Implementation Plan

## Executive Summary

NovaConnect is a **chat-core application** with teams, channels, DMs, threads, reactions, @mentions, file sharing, presence, 1:1 audio/video calls, screen sharing, meeting scheduling, calendar, and an AI assistant. It lacks the **conferencing, telephony, compliance, and extensibility** layers that define Microsoft Teams.

This plan prioritizes **high-impact, achievable increments** that move NovaConnect toward Teams parity without boiling the ocean.

---

## Feature Comparison Matrix

| Capability | NovaConnect (Current) | Microsoft Teams | Gap Severity |
|------------|----------------------|-----------------|--------------|
| **Teams & Channels** | ✅ Public/private channels, join requests, ownership | ✅ + org-wide teams, shared channels, channel moderation | Medium |
| **Direct Messages** | ✅ 1:1, group DMs, add participants, preferences | ✅ + cross-org chat, message recall, sensitivity labels | Low |
| **Messaging** | ✅ Threads, reactions, mentions, GIFs, formatting, scheduled send, translation (configurable) | ✅ + inline reply, message editing history, quoted reply, markdown, announcement posts | Medium |
| **File Sharing** | ✅ 15MB limit, attachment preview, channel/DM assets view | ✅ + SharePoint/OneDrive integration, co-authoring, version history, 250GB+ limits | High |
| **Audio/Video Calls** | ✅ 1:1 WebRTC (audio, video, screen share), incoming call toast, multi-tab handling | ✅ + **group calls (20+), PSTN, call queues, voicemail, call transfer, recording, live captions, background blur, together mode** | Critical |
| **Meetings/Conferencing** | ✅ Schedule meetings (recurring, RSVP, calendar), reusable meet links, **peer-to-peer rooms up to 6** | ✅ + **server-sided MCU/SFU (1000+), lobby, breakout rooms, recording, transcription, whiteboard, PowerPoint Live, large gallery, registration, webinar, town hall** | Critical |
| **Calendar** | ✅ Team events, meeting integration, month view | ✅ + Exchange/Outlook sync, delegate access, meeting insights, suggested times, time zones | High |
| **Presence** | ✅ Online/away/busy/dnd/brb/offline, status message, auto-online | ✅ + calendar-based (in a meeting, presenting), OOF, location, duration, per-device | Medium |
| **Search** | ✅ Per-conversation search, 50 results, literal match | ✅ + **global search (KQL), filters, message hover preview, people/files tabs, eDiscovery** | High |
| **Notifications** | ✅ In-app activity feed, mention/DM/channel invite, desktop (opt-in), sound | ✅ + **granular per-channel/chat rules, priority access, missed activity email, mobile push, banner/feed control** | Medium |
| **Admin/Compliance** | ✅ User management, role toggle, activate/deactivate, chat reports | ✅ + **eDiscovery, legal hold, retention policies, DLP, info barriers, audit log, guest access controls, conditional access, naming policies, usage reports** | Critical |
| **Extensibility** | ✅ Incoming webhook (`/api/integrations`), Gemini AI assistant | ✅ + **Apps platform (tabs, bots, messaging extensions, connectors, meeting extensions), AppSource, custom apps, Power Platform, Graph API** | Critical |
| **Telephony** | ❌ None | ✅ **Phone System, calling plans, Direct Routing, Operator Connect, voicemail, auto-attendant, call park** | Critical |
| **Security/Identity** | ✅ Session auth, bcrypt, HTTPS/WSS, block users | ✅ + **MFA, Conditional Access, Azure AD join, sensitivity labels, message encryption, guest lifecycle** | High |
| **Accessibility** | Basic semantic HTML, keyboard nav in menus | ✅ + **WCAG 2.1 AA, screen reader optimized, high contrast, live captions, sign language view** | Medium |
| **Mobile** | Responsive web only | ✅ **Native iOS/Android, offline sync, push, share extension, Intune MAM** | High |

---

## Architecture Assessment

### Current Stack
- **Backend**: Node.js/Express, Knex/PostgreSQL, Socket.IO (single-process)
- **Frontend**: Server-rendered EJS + vanilla JS modules, Bootstrap 5, Bootstrap Icons
- **Real-time**: Socket.IO rooms per channel/DM/user, shared Express session
- **Media**: Peer-to-peer WebRTC (1:1 calls, 6-person mesh rooms)
- **Auth**: Session cookies, bcrypt, no MFA/OIDC
- **Deployment**: Single Node process, file-based sessions, local certs for HTTPS

### Scaling Constraints
| Constraint | Current | Teams Requirement |
|------------|---------|-------------------|
| Socket.IO | Single process, in-memory rooms | Redis adapter + sticky sessions |
| WebRTC | Mesh (O(n²)), max 6 | SFU/MCU, 1000+ |
| Database | Single PG, no read replicas | Multi-region, read replicas |
| File storage | Local `data/` | S3/Blob + CDN |
| Background jobs | In-process scheduler | Distributed queue (BullMQ/Redis) |
| Auth | Session cookie | OIDC/JWT + MFA |

---

## Phased Implementation Plan

### Phase 1 — Foundations (Weeks 1–4)
**Goal**: Make the architecture horizontally scalable and production-hardened.

| Task | Details | Effort |
|------|---------|--------|
| 1.1 Redis-backed Socket.IO | Add `@socket.io/redis-adapter`, publish/subscribe across workers, sticky sessions via load balancer cookie | M |
| 1.2 Session store → Redis | Replace `session-file-store` with `connect-redis`, shared secret via env | S |
| 1.3 Structured logging & metrics | Pino + OpenTelemetry (traces, metrics, logs), `/health` already exists | S |
| 1.4 Configuration management | Validate all env vars at startup (zod), document required/production vs dev | S |
| 1.5 Database migrations | Replace `initSchema()` idempotent creates with versioned migrations (node-pg-migrate or knex migrate) | M |
| 1.6 File storage abstraction | Introduce `storage` interface (local/S3), migrate `upload.js`, add CDN URL rewriting | M |
| 1.7 Rate limiting & hardening | `express-rate-limit` on auth/api, helmet, CSP, referrer-policy, HSTS | S |
| 1.8 CI/CD pipeline | GitHub Actions: lint, test, build Docker image, deploy to staging/prod with health checks | M |

**Deliverable**: Horizontally scalable Node cluster behind LB, Redis-backed sessions/sockets, observable, migratable DB, object storage.

---

### Phase 2 — Group Calling & Conferencing Core (Weeks 5–12)
**Goal**: Replace peer-to-peer mesh with an SFU; support group calls and scheduled meetings with real media.

| Task | Details | Effort |
|------|---------|--------|
| 2.1 SFU selection & integration | **Recommendation**: mediasoup (Node, active, used by Jitsi, Daily). Alternative: Janus, Kurento, or managed (LiveKit, Daily.co, Twilio Video). Self-hosted mediasoup gives control and no per-minute cost. | L |
| 2.2 Signaling redesign | Extend `meet-signaling.js` → SFU join/leave, produce/consume tracks, simulcast, SVC, data channels for chat/whiteboard | L |
| 2.3 Group call UI | New call panel (grid layout, active speaker, pin, raise hand, reactions, chat, participants roster, settings) | M |
| 2.4 Meeting join flow | Lobby (admit/deny), pre-join device preview, join audio/video muted by default | M |
| 2.5 Recording (MVP) | Server-side composition (mediasoup recorder → ffmpeg → MP4 → object storage), organizer-only, retention config | L |
| 2.6 Screen share in groups | Present tab/window/screen as separate video track, "presentation" mode in UI | M |
| 2.7 Breakout rooms (v2) | Organizer creates rooms, assigns participants, timer, broadcast message, close rooms | L |
| 2.8 Live captions (v2) | Web Speech API client-side or server-side (Whisper.cpp), toggle per user | M |
| 2.9 Together mode / Large gallery (v2) | Canvas composition on client, 7×7 grid, virtual backgrounds | M |

**Milestones**:
- Week 6: 1:1 calls migrated to SFU (parity + reliability)
- Week 9: Group calls (3–20) working end-to-end
- Week 12: Scheduled meetings use SFU, recording MVP, lobby

---

### Phase 3 — Teams Parity Features (Weeks 13–24)
**Goal**: Close the functional gaps for daily collaboration.

| Area | Tasks | Effort |
|------|-------|--------|
| **Messaging** | Inline reply UI, quoted reply, announcement post type, markdown shortcuts, edit history view, message recall (admin/configurable), sensitivity labels (UI + metadata) | M |
| **Files** | S3/Blob storage, >15MB (configurable), thumbnail generation, Office preview (Office Online Viewer / OnlyOffice), versioning, "Open in SharePoint" stub | L |
| **Search** | Global search endpoint (full-text via PG `tsvector` or Meilisearch/Typesense), KQL-ish syntax, filters (from:, in:, before:/after:, has:file), result highlighting, people/files tabs | M |
| **Calendar** | Exchange/Outlook sync (Graph API), delegate access, meeting insights (attendee status, conflicts), time zone picker, recurring event exceptions | L |
| **Presence** | Calendar-derived states (in a meeting, presenting, OOF), per-device presence, "set duration" (30m, 1h, today, this week), location | M |
| **Notifications** | Per-channel/chat notification rules (all/mentions/none), priority access (VIP), missed-activity email digest, mobile push (FCM/APNs via web-push) | M |
| **Admin/Compliance** | eDiscovery search (admin UI + export), retention policies (auto-delete), legal hold, DLP regex rules, audit log (immutable append-only table), guest invite flow with approval, naming policy enforcement | L |
| **Extensibility** | App manifest schema, tab iframe sandbox (CSP), bot framework (webhook + proactive), messaging extensions (compose/command), meeting extensions (side panel), AppSource-like catalog page, Graph API subset (`/api/graph/*`) | L |

---

### Phase 4 — Telephony & Enterprise Voice (Weeks 25–36)
**Goal**: PSTN connectivity and PBX features.

| Task | Details | Effort |
|------|---------|--------|
| 4.1 SIP gateway | Integrate Kamailio/FreeSWITCH or use Twilio/Telnyx/Plivo for PSTN termination/origination | L |
| 4.2 Phone System | User phone numbers, call routing, voicemail (record → transcription → email/activity), call history | L |
| 4.3 Calling plans / Direct Routing | Abstraction for multiple carriers, least-cost routing, emergency calling (E911/RAY BAUM) | L |
| 4.4 Auto-attendant / Call queues | IVR menu, business hours, queue with music/announcements, agent opt-in/out, reporting | M |
| 4.5 Call park, transfer, delegate | Park orbit, blind/consultative transfer, manager-delegate ring group | M |
| 4.6 Teams-certified devices | Provisioning protocol (DHCP option 43 / XML config) for Yealink/Poly/AudioCodes | M |

---

### Phase 5 — Security, Identity & Governance (Weeks 37–44)
| Task | Details | Effort |
|------|---------|--------|
| 5.1 OIDC/SAML + MFA | Integrate Keycloak/Authentik or Azure AD/Entra ID, TOTP/WebAuthn, conditional access policies | L |
| 5.2 Sensitivity labels | Label taxonomy, mandatory labeling, encryption (AIP-compatible), content marking | M |
| 5.3 Information barriers | Segment user groups, block communication/search across segments | M |
| 5.4 Guest lifecycle | Invitation email, redemption, access reviews, expiration, guest-specific policies | M |
| 5.5 Audit & compliance center | Unified audit log viewer, search, export, alert rules | M |

---

### Phase 6 — Native Mobile & Accessibility (Weeks 45–52)
| Task | Details | Effort |
|------|---------|--------|
| 6.1 React Native / Expo app | Shared TypeScript types, API client, offline-first (WatermelonDB/Realm), push (expo-notifications) | L |
| 6.2 Share extension | iOS/Android share sheet → post to channel/DM | S |
| 6.3 WCAG 2.1 AA audit | axe-core CI, focus management, ARIA, color contrast, keyboard traps, live regions | M |
| 6.4 High contrast / reduced motion | CSS media queries, theme tokens already support | S |
| 6.5 Sign language view (meetings) | Pin interpreter video, spotlight | M |

---

## Technical Decisions & Recommendations

| Decision | Recommendation | Rationale |
|----------|----------------|-----------|
| **SFU** | mediasoup (self-hosted) | Mature, TypeScript, used in production at scale, no per-minute cost, full control |
| **Search engine** | Meilisearch (embedded) or Typesense | Fast, typo-tolerant, filtered search, simpler than Elasticsearch |
| **Object storage** | S3-compatible (MinIO local, AWS/GCS/Azure prod) | Industry standard, CDN-friendly, multipart upload |
| **Background jobs** | BullMQ + Redis | Reliable, delayed/retry, priority, metrics, works with existing Redis |
| **Migrations** | node-pg-migrate | Pure SQL, versioned, rollback, integrates with Knex pool |
| **Observability** | OpenTelemetry → Tempo/Loki/Prometheus (Grafana stack) | Vendor-neutral, correlates traces/logs/metrics |
| **Auth provider** | Keycloak (self-hosted) or Entra ID (managed) | Standards-based, MFA, SCIM, device trust, conditional access |
| **Mobile** | Expo (React Native) | Single codebase, OTA updates, native modules when needed |
| **Office preview** | OnlyOffice Document Server (self-hosted) or Microsoft Office Online Viewer (public URLs) | Render docx/xlsx/pptx in-browser without download |

---

## Resource Estimate (Engineering Weeks)

| Phase | Backend | Frontend | DevOps/Infra | QA | Total |
|-------|---------|----------|--------------|-----|-------|
| 1 Foundations | 6 | 2 | 6 | 2 | 16 |
| 2 Group Calling/SFU | 18 | 10 | 4 | 6 | 38 |
| 3 Teams Parity | 24 | 18 | 4 | 8 | 54 |
| 4 Telephony | 20 | 8 | 6 | 6 | 40 |
| 5 Security/Gov | 14 | 6 | 4 | 4 | 28 |
| 6 Mobile/Access | 8 | 20 | 4 | 6 | 38 |
| **Total** | **90** | **64** | **28** | **32** | **~214 eng-weeks** |

≈ **4–5 engineers × 12 months** for full parity. Phases 1–3 (core conferencing + parity) ≈ **6–8 months** with 3–4 engineers.

---

## Quick Wins (Do First, < 2 Weeks Each)

1. **Redis Socket.IO adapter** — unblocks horizontal scaling for real-time
2. **Meilisearch global search** — high user visibility, low backend churn
3. **S3 storage + >15MB uploads** — removes daily friction
4. **Per-channel notification rules** — top user request, small scope
5. **Message recall (soft delete + tombstone)** — safety/compliance baseline
6. **Meeting join lobby** — prevents unwanted guests, reuses signaling
7. **OIDC login (Keycloak dev instance)** — proves auth migration path

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SFU self-hosting operational burden | Medium | High | Start with managed (LiveKit Cloud) for dev/staging; migrate to self-hosted mediasoup when traffic justifies |
| WebRTC browser compatibility | Low | High | Test matrix (Chrome/FF/Safari/Edge, desktop/mobile); fallback to TURN relay |
| PostgreSQL full-text search scaling | Medium | Medium | Meilisearch/Typesense offloads; PG `tsvector` fine to ~10M messages |
| Migration from session cookies to JWT/OIDC | Medium | Medium | Dual-support period; feature flag per endpoint |
| Mobile app scope creep | High | Medium | Define MVP (chat, calls, meetings, notifications) — defer tabs/bots |
| Compliance feature creep | High | High | Build eDiscovery/retention as generic policy engine, not one-off features |

---

## Suggested Next Steps

1. **Approve Phase 1 scope** — provision Redis, add adapters, migrate sessions
2. **Spike SFU** — 1 week: deploy mediasoup + minimal join/leave + 1:1 call parity test
3. **Set up Meilisearch** — index existing messages, add global search endpoint + UI
4. **Create migration tooling** — baseline current schema, generate first versioned migration
5. **Draft OIDC integration spec** — decide Keycloak vs Entra ID, map roles/claims

---

## Appendix: Current NovaConnect Code Map (Key Files)

| Area | Files |
|------|-------|
| Server entry | `src/server.js` |
| DB schema & seed | `src/db.js` |
| Real-time (Socket.IO) | `src/realtime.js` |
| 1:1 Calls | `src/calls.js`, `public/js/calls.js` |
| Meet signaling (mesh) | `src/meet-signaling.js`, `public/js/meet-room.js` |
| Meet hub (links/schedule) | `src/routes/meet.js`, `src/routes/meetings.js`, `public/js/meet-hub.js` |
| Chat routes | `src/routes/messages.js`, `src/routes/dm.js`, `src/routes/teams.js` |
| Calendar | `src/routes/calendar.js` |
| AI | `src/routes/ai.js` |
| Auth/middleware | `src/middleware/auth.js` |
| Workspace shell | `views/workspace.ejs`, `public/js/workspace.js` |
| Chat header (DM actions) | `public/js/chat-header.js` |
| Channel tools | `public/js/channel-tools.js` |
| Theme & density | `public/css/theme-blue-cyan.css`, `public/css/ui-density.css`, `public/css/style.css` |