from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.style import WD_STYLE_TYPE
import re

doc = Document()

# ── Styles ──────────────────────────────────────────────────────
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)
style.paragraph_format.space_after = Pt(6)
style.paragraph_format.line_spacing = 1.15

for level in range(1, 4):
    hs = doc.styles[f'Heading {level}']
    hs.font.name = 'Calibri'
    hs.font.color.rgb = RGBColor(0x07, 0x55, 0xD9)
    if level == 1:
        hs.font.size = Pt(22)
        hs.font.bold = True
    elif level == 2:
        hs.font.size = Pt(16)
        hs.font.bold = True
    else:
        hs.font.size = Pt(13)
        hs.font.bold = True

# ── Helper ──────────────────────────────────────────────────────
def add_table(doc, headers, rows, col_widths=None):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Light Grid Accent 1'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    # header
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = h
        for p in cell.paragraphs:
            for r in p.runs:
                r.bold = True
                r.font.size = Pt(9)
    # data
    for ri, row in enumerate(rows):
        for ci, val in enumerate(row):
            cell = table.rows[ri + 1].cells[ci]
            cell.text = str(val)
            for p in cell.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(9)
    if col_widths:
        for i, w in enumerate(col_widths):
            for row in table.rows:
                row.cells[i].width = Cm(w)
    return table

def add_bullet(doc, text, level=0, bold_prefix=None):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.left_indent = Cm(1.27 + level * 0.63)
    if bold_prefix:
        run = p.add_run(bold_prefix)
        run.bold = True
        run.font.size = Pt(11)
        run = p.add_run(text)
        run.font.size = Pt(11)
    else:
        run = p.add_run(text)
        run.font.size = Pt(11)
    return p

# ── Title Page ──────────────────────────────────────────────────
for _ in range(4):
    doc.add_paragraph()

title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = title.add_run('NovaConnect vs Microsoft Teams')
run.bold = True
run.font.size = Pt(28)
run.font.color.rgb = RGBColor(0x07, 0x55, 0xD9)

subtitle = doc.add_paragraph()
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = subtitle.add_run('Gap Analysis & Implementation Plan')
run.font.size = Pt(18)
run.font.color.rgb = RGBColor(0x5F, 0x71, 0x8B)

doc.add_paragraph()
ver = doc.add_paragraph()
ver.alignment = WD_ALIGN_PARAGRAPH.CENTER
run = ver.add_run('Version 1.0 — September 2026')
run.font.size = Pt(12)
run.font.color.rgb = RGBColor(0x5F, 0x71, 0x8B)

doc.add_page_break()

# ── Table of Contents placeholder ───────────────────────────────
doc.add_heading('Table of Contents', level=1)
toc_items = [
    ('1', 'Executive Summary'),
    ('2', 'Feature Comparison Matrix'),
    ('3', 'Architecture Assessment'),
    ('4', 'Phased Implementation Plan'),
    ('5', 'Technical Decisions & Recommendations'),
    ('6', 'Resource Estimate'),
    ('7', 'Quick Wins'),
    ('8', 'Risk Register'),
    ('9', 'Suggested Next Steps'),
    ('10', 'Appendix: Current NovaConnect Code Map'),
]
for num, item in toc_items:
    p = doc.add_paragraph()
    run = p.add_run(f'{num}  {item}')
    run.font.size = Pt(12)

doc.add_page_break()

# ── 1 Executive Summary ─────────────────────────────────────────
doc.add_heading('1  Executive Summary', level=1)
doc.add_paragraph(
    'NovaConnect is a chat-core application with teams, channels, DMs, threads, reactions, '
    '@mentions, file sharing, presence, 1:1 audio/video calls, screen sharing, meeting scheduling, '
    'calendar, and an AI assistant. It lacks the conferencing, telephony, compliance, and extensibility '
    'layers that define Microsoft Teams.'
)
doc.add_paragraph(
    'This plan prioritizes high-impact, achievable increments that move NovaConnect toward Teams parity '
    'without boiling the ocean. The full roadmap spans six phases (~214 engineering-weeks, '
    '≈ 4–5 engineers × 12 months). Phases 1–3 (foundations + group calling + Teams parity) '
    'deliver core conferencing parity in 6–8 months with 3–4 engineers.'
)

# ── 2 Feature Comparison Matrix ────────────────────────────────
doc.add_heading('2  Feature Comparison Matrix', level=1)

headers = ['Capability', 'NovaConnect (Current)', 'Microsoft Teams', 'Gap Severity']
rows = [
    ['Teams & Channels', 'Public/private channels, join requests, ownership',
     'Org-wide teams, shared channels, channel moderation', 'Medium'],
    ['Direct Messages', '1:1, group DMs, add participants, preferences',
     'Cross-org chat, message recall, sensitivity labels', 'Low'],
    ['Messaging', 'Threads, reactions, mentions, GIFs, formatting, scheduled send, translation (configurable)',
     'Inline reply, edit history, quoted reply, markdown, announcement posts', 'Medium'],
    ['File Sharing', '15MB limit, attachment preview, channel/DM assets view',
     'SharePoint/OneDrive integration, co-authoring, version history, 250GB+ limits', 'High'],
    ['Audio/Video Calls', '1:1 WebRTC (audio, video, screen share), incoming call toast, multi-tab handling',
     'Group calls (20+), PSTN, call queues, voicemail, call transfer, recording, live captions, background blur, together mode', 'Critical'],
    ['Meetings/Conferencing', 'Schedule meetings (recurring, RSVP, calendar), reusable meet links, peer-to-peer rooms up to 6',
     'Server-sided MCU/SFU (1000+), lobby, breakout rooms, recording, transcription, whiteboard, PowerPoint Live, large gallery, registration, webinar, town hall', 'Critical'],
    ['Calendar', 'Team events, meeting integration, month view',
     'Exchange/Outlook sync, delegate access, meeting insights, suggested times, time zones', 'High'],
    ['Presence', 'Online/away/busy/dnd/brb/offline, status message, auto-online',
     'Calendar-based (in a meeting, presenting), OOF, location, duration, per-device', 'Medium'],
    ['Search', 'Per-conversation search, 50 results, literal match',
     'Global search (KQL), filters, message hover preview, people/files tabs, eDiscovery', 'High'],
    ['Notifications', 'In-app activity feed, mention/DM/channel invite, desktop (opt-in), sound',
     'Granular per-channel/chat rules, priority access, missed activity email, mobile push, banner/feed control', 'Medium'],
    ['Admin/Compliance', 'User management, role toggle, activate/deactivate, chat reports',
     'eDiscovery, legal hold, retention policies, DLP, info barriers, audit log, guest access controls, conditional access, naming policies, usage reports', 'Critical'],
    ['Extensibility', 'Incoming webhook (/api/integrations), Gemini AI assistant',
     'Apps platform (tabs, bots, messaging extensions, connectors, meeting extensions), AppSource, custom apps, Power Platform, Graph API', 'Critical'],
    ['Telephony', 'None',
     'Phone System, calling plans, Direct Routing, Operator Connect, voicemail, auto-attendant, call park', 'Critical'],
    ['Security/Identity', 'Session auth, bcrypt, HTTPS/WSS, block users',
     'MFA, Conditional Access, Azure AD join, sensitivity labels, message encryption, guest lifecycle', 'High'],
    ['Accessibility', 'Basic semantic HTML, keyboard nav in menus',
     'WCAG 2.1 AA, screen reader optimized, high contrast, live captions, sign language view', 'Medium'],
    ['Mobile', 'Responsive web only',
     'Native iOS/Android, offline sync, push, share extension, Intune MAM', 'High'],
]
add_table(doc, headers, rows, col_widths=[3.5, 5.5, 5.5, 2.5])

doc.add_page_break()

# ── 3 Architecture Assessment ──────────────────────────────────
doc.add_heading('3  Architecture Assessment', level=1)

doc.add_heading('3.1  Current Stack', level=2)
stack_items = [
    ('Backend', 'Node.js/Express, Knex/PostgreSQL, Socket.IO (single-process)'),
    ('Frontend', 'Server-rendered EJS + vanilla JS modules, Bootstrap 5, Bootstrap Icons'),
    ('Real-time', 'Socket.IO rooms per channel/DM/user, shared Express session'),
    ('Media', 'Peer-to-peer WebRTC (1:1 calls, 6-person mesh rooms)'),
    ('Auth', 'Session cookies, bcrypt, no MFA/OIDC'),
    ('Deployment', 'Single Node process, file-based sessions, local certs for HTTPS'),
]
for k, v in stack_items:
    add_bullet(doc, v, bold_prefix=f'{k}: ')

doc.add_heading('3.2  Scaling Constraints', level=2)
constraints = [
    ('Socket.IO', 'Single process, in-memory rooms', 'Redis adapter + sticky sessions'),
    ('WebRTC', 'Mesh (O(n²)), max 6', 'SFU/MCU, 1000+'),
    ('Database', 'Single PG, no read replicas', 'Multi-region, read replicas'),
    ('File storage', 'Local data/', 'S3/Blob + CDN'),
    ('Background jobs', 'In-process scheduler', 'Distributed queue (BullMQ/Redis)'),
    ('Auth', 'Session cookie', 'OIDC/JWT + MFA'),
]
add_table(doc, ['Component', 'Current', 'Teams Requirement'],
          [(c, cur, req) for c, cur, req in constraints],
          col_widths=[3, 6, 6])

# ── 4 Phased Implementation Plan ───────────────────────────────
doc.add_heading('4  Phased Implementation Plan', level=1)

phases = [
    {
        'title': 'Phase 1 — Foundations (Weeks 1–4)',
        'goal': 'Make the architecture horizontally scalable and production-hardened.',
        'tasks': [
            ('1.1', 'Redis-backed Socket.IO', 'Add @socket.io/redis-adapter, publish/subscribe across workers, sticky sessions via load balancer cookie', 'M'),
            ('1.2', 'Session store → Redis', 'Replace session-file-store with connect-redis, shared secret via env', 'S'),
            ('1.3', 'Structured logging & metrics', 'Pino + OpenTelemetry (traces, metrics, logs), /health already exists', 'S'),
            ('1.4', 'Configuration management', 'Validate all env vars at startup (zod), document required/production vs dev', 'S'),
            ('1.5', 'Database migrations', 'Replace initSchema() idempotent creates with versioned migrations (node-pg-migrate or knex migrate)', 'M'),
            ('1.6', 'File storage abstraction', 'Introduce storage interface (local/S3), migrate upload.js, add CDN URL rewriting', 'M'),
            ('1.7', 'Rate limiting & hardening', 'express-rate-limit on auth/api, helmet, CSP, referrer-policy, HSTS', 'S'),
            ('1.8', 'CI/CD pipeline', 'GitHub Actions: lint, test, build Docker image, deploy to staging/prod with health checks', 'M'),
        ],
        'deliverable': 'Horizontally scalable Node cluster behind LB, Redis-backed sessions/sockets, observable, migratable DB, object storage.'
    },
    {
        'title': 'Phase 2 — Group Calling & Conferencing Core (Weeks 5–12)',
        'goal': 'Replace peer-to-peer mesh with an SFU; support group calls and scheduled meetings with real media.',
        'tasks': [
            ('2.1', 'SFU selection & integration', 'Recommendation: mediasoup (Node, active, used by Jitsi, Daily). Alternative: Janus, Kurento, or managed (LiveKit, Daily.co, Twilio Video). Self-hosted mediasoup gives control and no per-minute cost.', 'L'),
            ('2.2', 'Signaling redesign', 'Extend meet-signaling.js → SFU join/leave, produce/consume tracks, simulcast, SVC, data channels for chat/whiteboard', 'L'),
            ('2.3', 'Group call UI', 'New call panel (grid layout, active speaker, pin, raise hand, reactions, chat, participants roster, settings)', 'M'),
            ('2.4', 'Meeting join flow', 'Lobby (admit/deny), pre-join device preview, join audio/video muted by default', 'M'),
            ('2.5', 'Recording (MVP)', 'Server-side composition (mediasoup recorder → ffmpeg → MP4 → object storage), organizer-only, retention config', 'L'),
            ('2.6', 'Screen share in groups', 'Present tab/window/screen as separate video track, "presentation" mode in UI', 'M'),
            ('2.7', 'Breakout rooms (v2)', 'Organizer creates rooms, assigns participants, timer, broadcast message, close rooms', 'L'),
            ('2.8', 'Live captions (v2)', 'Web Speech API client-side or server-side (Whisper.cpp), toggle per user', 'M'),
            ('2.9', 'Together mode / Large gallery (v2)', 'Canvas composition on client, 7×7 grid, virtual backgrounds', 'M'),
        ],
        'milestones': [
            'Week 6: 1:1 calls migrated to SFU (parity + reliability)',
            'Week 9: Group calls (3–20) working end-to-end',
            'Week 12: Scheduled meetings use SFU, recording MVP, lobby',
        ]
    },
    {
        'title': 'Phase 3 — Teams Parity Features (Weeks 13–24)',
        'goal': 'Close the functional gaps for daily collaboration.',
        'areas': [
            ('Messaging', 'Inline reply UI, quoted reply, announcement post type, markdown shortcuts, edit history view, message recall (admin/configurable), sensitivity labels (UI + metadata)', 'M'),
            ('Files', 'S3/Blob storage, >15MB (configurable), thumbnail generation, Office preview (Office Online Viewer / OnlyOffice), versioning, "Open in SharePoint" stub', 'L'),
            ('Search', 'Global search endpoint (full-text via PG tsvector or Meilisearch/Typesense), KQL-ish syntax, filters (from:, in:, before:/after:, has:file), result highlighting, people/files tabs', 'M'),
            ('Calendar', 'Exchange/Outlook sync (Graph API), delegate access, meeting insights (attendee status, conflicts), time zone picker, recurring event exceptions', 'L'),
            ('Presence', 'Calendar-derived states (in a meeting, presenting, OOF), per-device presence, "set duration" (30m, 1h, today, this week), location', 'M'),
            ('Notifications', 'Per-channel/chat notification rules (all/mentions/none), priority access (VIP), missed-activity email digest, mobile push (FCM/APNs via web-push)', 'M'),
            ('Admin/Compliance', 'eDiscovery search (admin UI + export), retention policies (auto-delete), legal hold, DLP regex rules, audit log (immutable append-only table), guest invite flow with approval, naming policy enforcement', 'L'),
            ('Extensibility', 'App manifest schema, tab iframe sandbox (CSP), bot framework (webhook + proactive), messaging extensions (compose/command), meeting extensions (side panel), AppSource-like catalog page, Graph API subset (/api/graph/*)', 'L'),
        ]
    },
    {
        'title': 'Phase 4 — Telephony & Enterprise Voice (Weeks 25–36)',
        'goal': 'PSTN connectivity and PBX features.',
        'tasks': [
            ('4.1', 'SIP gateway', 'Integrate Kamailio/FreeSWITCH or use Twilio/Telnyx/Plivo for PSTN termination/origination', 'L'),
            ('4.2', 'Phone System', 'User phone numbers, call routing, voicemail (record → transcription → email/activity), call history', 'L'),
            ('4.3', 'Calling plans / Direct Routing', 'Abstraction for multiple carriers, least-cost routing, emergency calling (E911/RAY BAUM)', 'L'),
            ('4.4', 'Auto-attendant / Call queues', 'IVR menu, business hours, queue with music/announcements, agent opt-in/out, reporting', 'M'),
            ('4.5', 'Call park, transfer, delegate', 'Park orbit, blind/consultative transfer, manager-delegate ring group', 'M'),
            ('4.6', 'Teams-certified devices', 'Provisioning protocol (DHCP option 43 / XML config) for Yealink/Poly/AudioCodes', 'M'),
        ]
    },
    {
        'title': 'Phase 5 — Security, Identity & Governance (Weeks 37–44)',
        'tasks': [
            ('5.1', 'OIDC/SAML + MFA', 'Integrate Keycloak/Authentik or Azure AD/Entra ID, TOTP/WebAuthn, conditional access policies', 'L'),
            ('5.2', 'Sensitivity labels', 'Label taxonomy, mandatory labeling, encryption (AIP-compatible), content marking', 'M'),
            ('5.3', 'Information barriers', 'Segment user groups, block communication/search across segments', 'M'),
            ('5.4', 'Guest lifecycle', 'Invitation email, redemption, access reviews, expiration, guest-specific policies', 'M'),
            ('5.5', 'Audit & compliance center', 'Unified audit log viewer, search, export, alert rules', 'M'),
        ]
    },
    {
        'title': 'Phase 6 — Native Mobile & Accessibility (Weeks 45–52)',
        'tasks': [
            ('6.1', 'React Native / Expo app', 'Shared TypeScript types, API client, offline-first (WatermelonDB/Realm), push (expo-notifications)', 'L'),
            ('6.2', 'Share extension', 'iOS/Android share sheet → post to channel/DM', 'S'),
            ('6.3', 'WCAG 2.1 AA audit', 'axe-core CI, focus management, ARIA, color contrast, keyboard traps, live regions', 'M'),
            ('6.4', 'High contrast / reduced motion', 'CSS media queries, theme tokens already support', 'S'),
            ('6.5', 'Sign language view (meetings)', 'Pin interpreter video, spotlight', 'M'),
        ]
    },
]

for phase in phases:
    doc.add_heading(phase['title'], level=2)
    if 'goal' in phase:
        doc.add_paragraph(phase['goal'])
    if 'tasks' in phase:
        add_table(doc, ['ID', 'Task', 'Details', 'Effort'],
                  [(t[0], t[1], t[2], t[3]) for t in phase['tasks']],
                  col_widths=[1.5, 4, 10, 1.5])
    if 'areas' in phase:
        add_table(doc, ['Area', 'Tasks', 'Effort'],
                  [(a[0], a[1], a[2]) for a in phase['areas']],
                  col_widths=[3, 13, 1.5])
    if 'milestones' in phase:
        doc.add_paragraph('Milestones:')
        for m in phase['milestones']:
            add_bullet(doc, m)
    if 'deliverable' in phase:
        p = doc.add_paragraph()
        run = p.add_run('Deliverable: ')
        run.bold = True
        p.add_run(phase['deliverable'])

doc.add_page_break()

# ── 5 Technical Decisions ──────────────────────────────────────
doc.add_heading('5  Technical Decisions & Recommendations', level=1)
decisions = [
    ('SFU', 'mediasoup (self-hosted)', 'Mature, TypeScript, used in production at scale, no per-minute cost, full control'),
    ('Search engine', 'Meilisearch (embedded) or Typesense', 'Fast, typo-tolerant, filtered search, simpler than Elasticsearch'),
    ('Object storage', 'S3-compatible (MinIO local, AWS/GCS/Azure prod)', 'Industry standard, CDN-friendly, multipart upload'),
    ('Background jobs', 'BullMQ + Redis', 'Reliable, delayed/retry, priority, metrics, works with existing Redis'),
    ('Migrations', 'node-pg-migrate', 'Pure SQL, versioned, rollback, integrates with Knex pool'),
    ('Observability', 'OpenTelemetry → Tempo/Loki/Prometheus (Grafana stack)', 'Vendor-neutral, correlates traces/logs/metrics'),
    ('Auth provider', 'Keycloak (self-hosted) or Entra ID (managed)', 'Standards-based, MFA, SCIM, device trust, conditional access'),
    ('Mobile', 'Expo (React Native)', 'Single codebase, OTA updates, native modules when needed'),
    ('Office preview', 'OnlyOffice Document Server (self-hosted) or Microsoft Office Online Viewer (public URLs)', 'Render docx/xlsx/pptx in-browser without download'),
]
add_table(doc, ['Decision', 'Recommendation', 'Rationale'],
          decisions, col_widths=[3, 5, 9])

# ── 6 Resource Estimate ────────────────────────────────────────
doc.add_heading('6  Resource Estimate (Engineering Weeks)', level=1)
resource_rows = [
    ('Phase 1 Foundations', 6, 2, 6, 2, 16),
    ('Phase 2 Group Calling/SFU', 18, 10, 4, 6, 38),
    ('Phase 3 Teams Parity', 24, 18, 4, 8, 54),
    ('Phase 4 Telephony', 20, 8, 6, 6, 40),
    ('Phase 5 Security/Gov', 14, 6, 4, 4, 28),
    ('Phase 6 Mobile/Access', 8, 20, 4, 6, 38),
    ('Total', 90, 64, 28, 32, 214),
]
add_table(doc, ['Phase', 'Backend', 'Frontend', 'DevOps/Infra', 'QA', 'Total'],
          resource_rows, col_widths=[4, 2, 2, 2.5, 1.5, 1.5])

doc.add_paragraph('≈ 4–5 engineers × 12 months for full parity. Phases 1–3 (core conferencing + parity) ≈ 6–8 months with 3–4 engineers.')

# ── 7 Quick Wins ───────────────────────────────────────────────
doc.add_heading('7  Quick Wins (Do First, < 2 Weeks Each)', level=1)
wins = [
    'Redis Socket.IO adapter — unblocks horizontal scaling for real-time',
    'Meilisearch global search — high user visibility, low backend churn',
    'S3 storage + >15MB uploads — removes daily friction',
    'Per-channel notification rules — top user request, small scope',
    'Message recall (soft delete + tombstone) — safety/compliance baseline',
    'Meeting join lobby — prevents unwanted guests, reuses signaling',
    'OIDC login (Keycloak dev instance) — proves auth migration path',
]
for w in wins:
    add_bullet(doc, w)

# ── 8 Risk Register ────────────────────────────────────────────
doc.add_heading('8  Risk Register', level=1)
risks = [
    ('SFU self-hosting operational burden', 'Medium', 'High',
     'Start with managed (LiveKit Cloud) for dev/staging; migrate to self-hosted mediasoup when traffic justifies'),
    ('WebRTC browser compatibility', 'Low', 'High',
     'Test matrix (Chrome/FF/Safari/Edge, desktop/mobile); fallback to TURN relay'),
    ('PostgreSQL full-text search scaling', 'Medium', 'Medium',
     'Meilisearch/Typesense offloads; PG tsvector fine to ~10M messages'),
    ('Migration from session cookies to JWT/OIDC', 'Medium', 'Medium',
     'Dual-support period; feature flag per endpoint'),
    ('Mobile app scope creep', 'High', 'Medium',
     'Define MVP (chat, calls, meetings, notifications) — defer tabs/bots'),
    ('Compliance feature creep', 'High', 'High',
     'Build eDiscovery/retention as generic policy engine, not one-off features'),
]
add_table(doc, ['Risk', 'Likelihood', 'Impact', 'Mitigation'],
          risks, col_widths=[4, 2, 2, 9])

# ── 9 Suggested Next Steps ─────────────────────────────────────
doc.add_heading('9  Suggested Next Steps', level=1)
steps = [
    'Approve Phase 1 scope — provision Redis, add adapters, migrate sessions',
    'Spike SFU — 1 week: deploy mediasoup + minimal join/leave + 1:1 call parity test',
    'Set up Meilisearch — index existing messages, add global search endpoint + UI',
    'Create migration tooling — baseline current schema, generate first versioned migration',
    'Draft OIDC integration spec — decide Keycloak vs Entra ID, map roles/claims',
]
for i, s in enumerate(steps, 1):
    p = doc.add_paragraph()
    run = p.add_run(f'{i}. ')
    run.bold = True
    p.add_run(s)

doc.add_page_break()

# ── 10 Appendix ────────────────────────────────────────────────
doc.add_heading('10  Appendix: Current NovaConnect Code Map (Key Files)', level=1)
code_map = [
    ('Server entry', 'src/server.js'),
    ('DB schema & seed', 'src/db.js'),
    ('Real-time (Socket.IO)', 'src/realtime.js'),
    ('1:1 Calls', 'src/calls.js, public/js/calls.js'),
    ('Meet signaling (mesh)', 'src/meet-signaling.js, public/js/meet-room.js'),
    ('Meet hub (links/schedule)', 'src/routes/meet.js, src/routes/meetings.js, public/js/meet-hub.js'),
    ('Chat routes', 'src/routes/messages.js, src/routes/dm.js, src/routes/teams.js'),
    ('Calendar', 'src/routes/calendar.js'),
    ('AI', 'src/routes/ai.js'),
    ('Auth/middleware', 'src/middleware/auth.js'),
    ('Workspace shell', 'views/workspace.ejs, public/js/workspace.js'),
    ('Chat header (DM actions)', 'public/js/chat-header.js'),
    ('Channel tools', 'public/js/channel-tools.js'),
    ('Theme & density', 'public/css/theme-blue-cyan.css, public/css/ui-density.css, public/css/style.css'),
]
add_table(doc, ['Area', 'Files'], code_map, col_widths=[5, 12])

# ── Save ───────────────────────────────────────────────────────
output_path = '/Users/hhasija/Desktop/NovaConnect/NovaConnect_Implementation_Plan.docx'
doc.save(output_path)
print(f'Saved to {output_path}')