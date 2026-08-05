# UUH branding — CWORK-1111

```bash
make -C deploy/uuh brand     # apply; re-run after any container recreate
```

## ⚠️ Placeholder assets

Colours and marks were **scraped from `uofuhealth.utah.edu` on 2026-08-05**
because UUH's official asset pack (requested 22 Jul, chased in the recap) had
not arrived, and CWORK-1111 says explicitly: *do not wait*.

These are University of Utah Health trademarks. Fine for demonstrating back to
UUH; **not** for publication or reuse. Replace wholesale when the real pack
lands — `uuh-brand.css` and `assets/` are the only two things to swap.

Palette taken from the site's own CSS custom properties, not eyeballed:

| | |
|---|---|
| `#BE0000` | crimson, primary (`--nav-primary-item-active-color`) |
| `#9DD8D7` | "blue topaz", secondary accent |
| `#C5C5C6` | grey |

## The finding that changed the approach

**CWORK-1111 states colours require a frontend rebuild of `client/src/style.css`.
They do not.** LibreChat v0.8.7 defines its palette as CSS custom properties, so
a stylesheet loaded after the bundle re-themes the app with **no source edit and
no rebuild**.

That matters more than the colours. `style.css` is one of the most churned files
upstream (v0.8.5 sidebar redesign, v0.8.7 settings redesign) against roughly
monthly releases carrying heavy security content — v0.8.4 alone shipped "30+
security fixes". Editing it is what forces a hard fork, and **a health system on
a stale fork inherits that exposure**. Nothing here touches anything upstream
ships, so `git rebase upstream/main` stays clean.

Confirmed separately: there is **no theming block in `librechat.yaml` for
v0.8.7** — the ticket asked to check whether native theming had landed. It has
not.

## How far the branding actually goes

Honest scope. This is **not** a full reskin:

- ✅ Browser tab title, footer, welcome message
- ✅ Primary actions (send button, submit buttons) in UUH crimson
- ✅ Focus rings crimson — also an accessibility win
- ✅ UUH mark replaces the LibreChat logo asset
- ⚠️ The overall interface is still LibreChat's dark theme. Backgrounds,
  sidebar, and typography are untouched.

Going further means either restyling many Tailwind utility classes (brittle —
they churn between releases) or the rebuild the ticket described (forces the
fork). For a demo, the current level reads as "UUH's product" without buying
that maintenance burden. Revisit if UUH asks for a deeper reskin, and price the
fork cost explicitly when they do.

## Four traps, each of which cost real time

1. **`index.html` is read ONCE at startup.** `api/server/index.js:161` does
   `fs.readFileSync(indexPath)` and serves that string from memory forever.
   Patching the file on disk does nothing until the process restarts — the
   stylesheet returns 200 while the page never references it, which looks
   exactly like a CSS cascade bug and is not one. The script restarts the API.

2. **The browser caches the stylesheet.** Without a cache-busting query the
   browser serves a stale copy after every edit: the file is served, the
   selector matches, and nothing changes. The script hashes the CSS into the
   href (`?v=aa151706`).

3. **Custom properties alone do not re-theme this build.** The send button is
   `bg-text-primary`, *not* `bg-surface-submit` — so overriding
   `--surface-submit` changes nothing visible, and overriding `--text-primary`
   would repaint all body text. Primary actions need explicit selectors, which
   target stable hooks (`aria-label`, `data-testid`) rather than Tailwind
   classes.

4. **Never patch an already-patched `index.html`.** An earlier cleanup
   (`sed /uuh-brand/d`) deleted the whole line — which also carried `</head>`,
   destroying the anchor for the next injection. The script keeps a pristine
   `index.html.uuh-orig` and re-derives from it every run. A separate BSD-sed
   newline attempt emitted a **literal `\n` into the markup**, visible as text
   in the top-left of every page.

## Re-applying after an upstream bump

The ticket's done-when requires this be documented.

```bash
git fetch upstream && git rebase upstream/main
make -C deploy/uuh up
make -C deploy/uuh brand
```

Nothing should conflict — every file here is in `deploy/uuh/`, which upstream
does not ship. Two things to re-check after a bump:

- **Asset paths.** `assets/favicon-*.png`, `apple-touch-icon-180x180.png`, and
  `logo.svg` are currently **non-hashed**, which is why overwriting them works.
  If upstream starts hashing them, this approach needs revisiting.
- **The send-button hook.** If `data-testid="send-button"` or the `aria-label`
  changes, the crimson silently stops applying. `make -C deploy/uuh brand`
  will still report success — it verifies delivery, not appearance. Eyeball it.

## Files

| | |
|---|---|
| `uuh-brand.css` | palette + targeted rules. The whole theme |
| `apply-branding.sh` | copies assets, injects the stylesheet, restarts the API, verifies |
| `assets/logo.svg` | UUH mark (white-fill, drawn for a dark field) |
| `assets/uhealth-logo.svg` | alternate mark, unused |
| `assets/favicon.ico` | UUH favicon; PNG slots left stock (see script comment) |

App title and footer live in `.env` (`APP_TITLE`, `CUSTOM_FOOTER`); the welcome
message is `interface.customWelcome` in `deploy/uuh/librechat.uuh.yaml`.
