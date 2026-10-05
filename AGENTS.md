# NovaConnect implementation guidance

## UI density standard (user-approved)
Use the compact three-dot chat menu as the height and spacing reference for all future enhancements. Reuse the shared CSS variables in `public/css/ui-density.css`: 36px minimum control height, 4.62px vertical padding, 15.4px horizontal padding, 12.32px item gap, and 15.4px section spacing. These are rendered CSS pixels derived from the approved menu at 0.77 scale. Do not apply zoom again to new controls. In existing zoomed containers, compensate for that scale once as the menu rules do.
Preserve approved font sizes unless the user asks to change them. Multi-line rows and text areas may grow to fit content; never clip names, descriptions, focus rings or translated labels to force a fixed height. Use the standard for new menus, toolbars, forms and member/user lists; check keyboard focus, narrow screens and long labels. User instructions override this default.

The app-wide density rollout was reverted by the user. Keep subsequent menu-matching adjustments scoped to People and the channel header unless explicitly asked otherwise. Their typography and icon sizes match the rendered menu (13.552px text and 17.71px icons); preserve responsive wrapping.

Use the blue/cyan logo-matched theme from `public/css/theme-blue-cyan.css` for future UI work. Reuse brand variables instead of hard-coded purple accents. People rail icon and label must match the standard rail sizing.

## Clean-install rules (user-approved, 2026-10-05)
NovaConnect must install from scratch on any server (README "Fresh install", `compose.yaml`) with every future change, not only work on the NOVAAPP01 lab. CI's fresh-install job checks startup, migrations, the first admin's sign-in and a restart on every push; it does not exercise every feature, so follow these rules:

- **Database changes only as migration files** in `migrations/` (`npm run migrate:create <name>`). They apply themselves at startup (`src/migrate.js`). Never change the lab schema by hand with `psql`, and never create or alter tables from app code. Keep migrations additive, so the previous version still runs if a release rolls back.
- **New settings** go in `src/config.js` (validated, with a sensible default or a clear error) and in `.env.example` with a comment. Required settings belong under "Required" there.
- **New services** (another container, e.g. a worker or a cache) go in `compose.yaml`, with the README updated.
- **New outside sources** (a CDN script or stylesheet, fonts, iframes, websocket or API hosts, media) must be added to the production Content-Security-Policy in `src/server.js` (`CSP_DIRECTIVES`). The lab runs in development mode and sends no CSP, so a missing source only breaks real production installs; CI's browser check (`scripts/ci-browser-check.mjs`) signs in, opens every main view and joins a meeting under the production CSP, and fails on any blocked resource or JavaScript error.
- **Nothing lab-specific as a default:** no `NOVAAPP01`, `10.0.0.x`, `*.lab.sps` or lab passwords in code defaults. Lab values belong in the lab's systemd units.
- **Releases:** `scripts/release.sh` refuses a commit whose CI run (`.github/workflows/ci-cd.yml`) isn't green. Fix CI rather than bypassing it; `NOVACONNECT_SKIP_CI=1` is for emergencies only and must be mentioned in the release reason.
