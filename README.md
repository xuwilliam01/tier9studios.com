# tier9studios

The Tier 9 Game Studios website, served by GitHub Pages at https://www.tier9studios.com/.

Pages builds from the `deployment` branch. There is no build step: every file in the repository is published as it is.
`main` and `deployment` hold the same files: a change lands on `main` first, and the same commits are then
cherry-picked onto `deployment` to publish them.

## What is here

| Path | What it is |
| --- | --- |
| `/` | The home page. It opens on the 9999+ Weapons card over a live scene from the game. Its "Enter Main Site" button blurs the scene and shows the main site: the studio, the games, the community, the team, working here, and open roles. |
| `/careers/` | Open roles, read from the hiring API, and how hiring works. |
| `/careers/position/?p=<slug>` | One role and its application form. |
| `/careers/privacy/` | The applicant privacy notice the form links to. |
| `/abw/` | The page for 9999+ Weapons: Idle RPG. Also the page shown for the game's sign-in branding. |
| `/abw/app/apple/`, `/abw/app/steam/` | Where Sign in with Apple and Sign in with Steam return to the game. |
| `/auto-battles-online/` | The page for Auto Battles Online. |
| `/abo/` | Sends a visitor to the Auto Battles Online store page for their device. |
| `/support/` | The support page. Its form sends a player's request to the team site's public support route (`https://team.tier9studios.com/api/public/support`). |
| `/privacy/`, `/terms/` | The privacy policy for the games, and the terms for the Discord community. |

### Files other systems depend on

Do not move, rename or reformat these without checking what reads them.

- `.well-known/apple-app-site-association` and `.well-known/assetlinks.json`: app links for the iOS and Android games.
- `404.html`: its script sends any address under `/abw/app` to `/abw/`, keeping the query string. App links for a visitor without the game installed land there. Keep that script inline and first in the page.
- `/abw/app/apple/index.html` and `/abw/app/steam/index.html`: the return pages for Sign in with Apple and Sign in with Steam. Their addresses are registered with the sign-in providers and repeated in the game client and the game server. They must not load any third-party script, because the address carries a one-time sign-in answer.
- `app-ads.txt`: read by the ad networks the games use.
- `/privacy/` and `/terms/`: linked from the games, the store listings and the Discord bots.
- `CNAME` and `.nojekyll`: the custom domain, and what makes GitHub Pages publish the `.well-known` folder.

## The look

The home page, `/abw/`, the careers pages and `404.html` draw a live World 1 biome from 9999+ Weapons behind them: the battle
background, floor, props and monsters, all cut from the game and listed in `assets/abw/biomes.json`.
`assets/site/world.js` builds it. `/abw/` draws the same kind of scene with its own inline script and page defaults.
All monsters walk one line through the middle of the path, and the front props stand at the path's top edge,
behind them. The scene moves for every visitor, including one whose system asks for reduced motion; the
editor's Motion setting can instead hold it still for those visitors, or for everyone. `/abw/` always moves.
Panels are frosted glass; headings use Ioskeley Mono, body text the system font.

The home page has two states, and the address alone picks between them, so they work without JavaScript and
with the back button:

- No fragment, or `#top`: the landing card over the sharp scene.
- `#main` (the main site's header), or any section of the main site (`#studio`, `#games`, `#community`, `#team`,
  `#work`, `#careers`): the main site. The landing is hidden, and the `.veil` element blurs and darkens
  the scene behind the page.

"Enter Main Site" links to `#main`, and the logo in the main site's header links back to `#top`. The careers
pages and `404.html` link into the main site with `/#studio` and the like, and carry `class="in-site"` on
`<body>`, so their scene is always blurred. `/abw/` shows its scene sharp, behind its own card.

## The careers pages

The site has no server. The careers pages read open positions from, and send applications to, the hiring
API on the team site (`https://team.tier9studios.com/api/public/hiring/...`). Positions and applications
are managed in the team site's Hiring tab, and its `docs/HIRING.md` describes the API.

- Each page that lists roles names the API in `<meta name="t9-api">` and allows that one origin in its
  Content-Security-Policy `connect-src`. To move the API, change both in every page that has them.
- The team site only answers the origins listed under `hiring.publicOrigins` in its `config.json`.
- A list of roles asks the API only once it is near the screen, so a visit that stays on the landing card
  sends no request. On the home page the list is the last section, so nothing below it moves when it arrives.
- Everything the API returns reaches the page as text. A position description arrives as a list of
  blocks (headings, paragraphs, lists), and `assets/site/careers.js` builds page elements from them.
  No HTML from the API is ever parsed.
- The form's consent line and the applicant privacy notice say "12 months", the hiring system's
  default for how long an application is kept, and show the configured period instead once the API
  answers. If that setting is changed for good, change the text of both pages as well, so a reader
  without JavaScript sees the right period.

## The site editor

The site editor is a page on the team site:
[Tier 9 website editor](https://team.tier9studios.com/plans/WIL/tier9-site-editor). It edits the text,
the colours, the team (names, roles, order and photos) and the background's motion, with a live preview,
and every change autosaves as a shared draft on the team site. The website does not read that draft. To
publish it:

1. In the editor, choose **Export JSON** to save `site-settings.json`.
2. Run `node tools/apply-site-settings.mjs site-settings.json`. It writes the draft into the pages, the
   stylesheet, `world.js` and `assets/img/team/`, and stops without writing anything if a value is wrong.
   The script's header lists what it changes.
3. Preview, commit and publish as for any other change. Keep the settings file out of the repository:
   every file here is published.
4. Rebuild the editor with `python tools/site-editor/build.py` and republish it to the plan, so its
   defaults match the site again. The build reads its defaults from the files the script wrote.

What the editor and the script reach:

- Text: every element with a `data-site-copy` attribute. One key changes every page that carries it, and
  such an element holds text only, no markup.
- Colours: `--ink`, `--ink-dim`, `--accent`, `--enter`, `--enter-hover` and `--blurple` in `site.css`.
- Motion: the `MOTION` line at the top of `world.js` (always move, follow the visitor's reduced-motion
  preference, or always still; one biome or random; rotation and its interval) and `--site-blur` in
  `site.css`.
- The team: the whole `<ul class="team">` list on the home page, and its photos in `assets/img/team/`.

## Preview locally

```
node tools/dev-server.mjs
```

serves the site at http://127.0.0.1:8080/ the way GitHub Pages does (folder indexes, and `404.html` for a
missing address). If `world.js` follows the reduced-motion preference and your computer asks for it, open
http://127.0.0.1:8080/?motion=play to see the background move. That switch works only on this machine's own
addresses.

To try the careers pages against a team site running on your machine:

```
node tools/dev-server.mjs --api http://127.0.0.1:8787
```

With `--api`, the server rewrites the API address in the HTML it serves. The files on disk are not
changed, and the shipped careers code uses the API address in the page.

## Rules for changes

- The home and careers pages ship a Content-Security-Policy in a `<meta>` tag: no inline `<style>`, no
  `style="..."` attributes, no inline `<script>`, and no requests to other origins except the hiring API.
  Styles go in `assets/site/site.css`. Setting `element.style` from JavaScript is fine.
- GitHub Pages cannot send response headers of our choosing, so the pages cannot forbid being framed by
  another site, and cannot send a Strict-Transport-Security header. "Enforce HTTPS" is on in the
  repository's Pages settings.
- No analytics, no cookies, no third-party fonts or scripts.
- Nothing may depend on JavaScript to be readable, except the list of roles and the form.

## Art

- `assets/abw/`: backgrounds, props and monsters cut from the game, and `biomes.json`, which describes
  each biome's layers, floor, walkable band, props and monsters.
- `assets/img/`: the key art and world map, the potato and the mole, and the touch icon.
- `assets/img/team/`: one 256 × 256 photo per person on the team list, named by the person's id.
- `assets/bg.jpg`, `bg-arena.jpg` and `bg-dungeon.jpg`: the backgrounds of the Auto Battles Online page, and
  the image that link previews show.
