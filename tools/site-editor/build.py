"""Build the site editor: one self-contained HTML page, published to the team site as the plan
WIL/tier9-site-editor with shared state and scripts on. Its defaults are read from this repository's files, so
rebuild and republish it after the site changes.

python tools/site-editor/build.py [--template <html-plan template.html>] [--out <file.html>]

The page borrows its look from the html-plan skill's template in the game repository (default: the T9 checkout
beside this repository). Needs Python 3 with beautifulsoup4 and Pillow.
"""
from argparse import ArgumentParser
from base64 import b64encode
from io import BytesIO
import json
import re
import tempfile
from pathlib import Path
from bs4 import BeautifulSoup
from PIL import Image

build = Path(__file__).resolve().parent
site = build.parent.parent
args = ArgumentParser()
args.add_argument("--template", type=Path, default=site.parent / "T9/game/.claude/skills/html-plan/template.html")
args.add_argument("--out", type=Path, default=Path(tempfile.gettempdir()) / "tier9-site-editor.html")
args = args.parse_args()
plan = args.out
template = args.template.read_text(encoding="utf-8").replace("\r\n", "\n")
site_css = (site / "assets/site/site.css").read_text(encoding="utf-8")
world_js = (site / "assets/site/world.js").read_text(encoding="utf-8")
motion = json.loads(re.search(r"var MOTION = (\{.*\});", world_js)[1])

groups = [
    ("landing", "Landing", "landing"),
    ("nav", "Navigation", "studio"),
    ("studio", "Studio", "studio"),
    ("games", "Games overview", "games"),
    ("weapons", "9999+ Weapons", "games"),
    ("autoBattles", "Auto Battles Online", "games"),
    ("community", "Discord and community", "community"),
    ("follow", "Social links", "community"),
    ("team", "The team", "team"),
    ("work", "Working here", "work"),
    ("careersSummary", "Home careers", "careers"),
    ("careers", "Careers page", "careers-page"),
    ("colors", "Colors", ""),
    ("motion", "Background motion", ""),
]
special_names = {
    "otherGame": "Auto Battles Online link",
    "enter": "Enter main site button",
    "discord": "Discord button",
    "blurple": "Discord background",
    "ink": "Main text",
    "inkDim": "Secondary text",
    "accent": "Red accents",
    "enterHover": "Enter button hover",
    "kicker": "Section label",
    "teamSummary": "Team summary",
    # The studio's four boxes hold a timeline, and the perks' keys predate their current text. The keys stay, so
    # saved drafts keep working; the labels say what each field is now.
    "peopleValue": "Timeline 1: year",
    "peopleLabel": "Timeline 1: text",
    "gamesValue": "Timeline 2: year",
    "gamesLabel": "Timeline 2: text",
    "launchedValue": "Timeline 3: year",
    "launchedLabel": "Timeline 3: text",
    "officeValue": "Timeline 4: year",
    "officeLabel": "Timeline 4: text",
    "shipFastTitle": "Perk 1: title",
    "shipFastDescription": "Perk 1: text",
    "ownershipTitle": "Perk 2: title",
    "ownershipDescription": "Perk 2: text",
    "officeTitle": "Perk 3: title",
    "officeDescription": "Perk 3: text",
    "outingsTitle": "Perk 4: title",
    "outingsDescription": "Perk 4: text",
    "benefitsTitle": "Perk 5: title",
    "benefitsDescription": "Perk 5: text",
}
fields = {}
pages = {}
team = []
team_photos = {}
biomes = json.loads((site / "assets/abw/biomes.json").read_text(encoding="utf-8"))

def data_url(content, mime):
    return f"data:{mime};base64,{b64encode(content).decode('ascii')}"

def img_webp(image, quality=72, max_width=None):
    if max_width is not None and image.width > max_width:
        size = max_width, round(image.height * max_width / image.width)
        image = image.resize(size, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, "WEBP", quality=quality, method=6)
    return data_url(buffer.getvalue(), "image/webp")

def public_file(path):
    return site / path.lstrip("/")

def readable(value):
    words = re.sub(r"([a-z])([A-Z0-9])|([0-9])([A-Z])",
                   lambda m: " ".join(part for part in m.groups() if part), value)
    return words.lower().capitalize()

def add_field(part, name, group, label, type_, default, **metadata):
    key = f"{part}/{name}"
    prior = fields.get(key)
    if prior:
        assert prior["default"] == default, key
        return
    fields[key] = dict(key=key, part=part, name=name, group=group, label=label,
                       type=type_, default=default, **metadata)

for path, name in [("index.html", "home"), ("careers/index.html", "careers")]:
    soup = BeautifulSoup((site / path).read_text(encoding="utf-8"), "html.parser")
    body = soup.body
    for element in body.select("[data-site-copy]"):
        key = element["data-site-copy"]
        assert not element.find(), key
        group, name_part = key.split(".", 1)
        label = special_names.get(name_part, readable(name_part))
        if name_part == "link" and group == "careersSummary":
            label = "Careers page button"
        add_field("copy", key, group, label, "copy", element.get_text().strip(), max=2000)
    for element in body.select("script, noscript"):
        element.decompose()
    if name == "home":
        for person in body.select("ul.team > li.person"):
            photo = person.select_one("img.person__photo")
            src = photo["src"] if photo else None
            # tools/apply-site-settings.mjs writes each person's id into the page; the editor's draft is keyed by it.
            person_id = person.get("data-person-id", "")
            assert re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", person_id), f"a team member has no valid data-person-id: {person}"
            assert person_id not in {other["id"] for other in team}, f"the team id {person_id} is used twice"
            team.append(dict(id=person_id,
                             name=person.b.get_text().strip(),
                             role=role.get_text().strip() if (role := person.select_one(".person__who > span")) else "",
                             photo=src))
            if src:
                team_photos[src] = data_url(public_file(src).read_bytes(), "image/" + Path(src).suffix.lstrip(".").replace("jpg", "jpeg"))
    for element in body.select("img[src]"):
        path = element["src"]
        asset = public_file(path)
        if "-1600" in path:
            smaller = public_file(path.replace("-1600", "-960"))
            if smaller.exists():
                asset = smaller
        element["src"] = img_webp(Image.open(asset).convert("RGBA"), quality=64, max_width=480)
        element.attrs.pop("srcset", None)
        element.attrs.pop("sizes", None)
    for element in body.select("[data-roles-empty]"):
        element.attrs.pop("hidden", None)
    pages[name] = str(body)

for name in ["ink", "inkDim", "accent", "enter", "enterHover", "blurple"]:
    css_name = re.sub(r"[A-Z]", lambda m: "-" + m[0].lower(), name)
    default = re.search(fr"--{css_name}:\s*(#[0-9a-fA-F]{{6}})\b", site_css)[1]
    label = special_names.get(name, readable(name))
    if name == "enter":
        label = "Enter button"
    add_field("colors", name, "colors", label, "color", default)

add_field("motion", "mode", "motion", "Motion", "choice", motion["mode"],
          choices=[["play", "Always move"], ["auto", "Follow device preference"], ["still", "Always still"]],
          help="Follow device preference holds the scene still for a visitor whose system asks for reduced motion.")
add_field("motion", "biome", "motion", "Fixed biome", "choice", motion["biome"],
          choices=[["random", "Random"], *[[b["id"], b["id"].replace("-", " ").capitalize()] for b in biomes]],
          help="Choosing a biome keeps that background in place.")
add_field("motion", "rotateBiomes", "motion", "Rotate random biomes", "check", motion["rotateBiomes"])
add_field("motion", "intervalSeconds", "motion", "Rotation interval", "range", motion["intervalSeconds"],
          min=5, max=120, step=1, integer=True, unit=" s")
add_field("motion", "blurPx", "motion", "Main site background blur", "range",
          float(re.search(r"--site-blur:\s*([0-9.]+)px", site_css)[1]),
          min=0, max=24, step=.5, unit=" px", help="Open Studio in the preview to see this change.")

for path in set(re.findall(r'url\("(/assets/fonts/[^"]+)"\)', site_css)):
    site_css = site_css.replace(path, data_url(public_file(path).read_bytes(), "font/woff2"))
site_css = site_css.replace(':has(#main:target, .site :target)', '[data-preview-view="main"]')
site_css += "\n.preview-actor { position: absolute; background-repeat: no-repeat; image-rendering: auto; }"
site_css += "\n.preview-scene { pointer-events: none; }"

scenes = {}
for biome in biomes:
    ratio = biome["layers"][0]["w"]
    h = 320
    w = round(h * ratio)
    canvas = Image.new("RGBA", (w, h), biome["top"])
    for layer in biome["layers"]:
        image = Image.open(public_file(layer["file"])).convert("RGBA")
        layer_w = round(h * layer["w"])
        layer_h = h
        offset = 0
        if layer["role"] == "anim":
            image = image.crop((0, 0, image.width, round(image.height / layer["frames"])))
            layer_h = round(h * layer["h"])
            offset = round(h * layer["top"])
        image = image.resize((layer_w, layer_h), Image.Resampling.LANCZOS)
        while layer_w < w:
            canvas.alpha_composite(image, (layer_w, offset))
            layer_w += image.width
        canvas.alpha_composite(image, (0, offset))
    monster = biome["monsters"][0]
    scenes[biome["id"]] = {
        "background": img_webp(canvas.convert("RGB"), quality=68),
        "width": ratio,
        "floor": img_webp(Image.open(public_file(biome["floor"])).convert("RGBA"), quality=61, max_width=288),
        "feet": sum(biome["feet"]) / 2,
        "idle": monster["idle"].copy(),
        "walk": monster["walk"].copy(),
    }
    for action in ("idle", "walk"):
        animation = scenes[biome["id"]][action]
        sheet = Image.open(public_file(animation["file"])).convert("RGBA")
        animation["file"] = img_webp(sheet, quality=58, max_width=44 * animation["frames"])

assert set(key.split(".", 1)[0] for key in (f["name"] for f in fields.values() if f["part"] == "copy")).issubset(
    {entry[0] for entry in groups}
)
editor_css, editor_html, editor_js = ((build / name).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
                                      for name in ("editor.css", "editor.html", "editor.js"))
house_css = template.split("<style>", 1)[1].split("</style>", 1)[0]
house_css = (house_css.split("  /* ---- orientation modules ---- */", 1)[0] +
             editor_css + "\n" +
             house_css.split("  @media (prefers-color-scheme: dark) {", 1)[1].split("  @media (max-width: 50em) {", 1)[0])
house_css = house_css.replace(editor_css + "\n", editor_css + "\n  @media (prefers-color-scheme: dark) {")
house_css += """
  @media (max-width: 50em) {
    html { font-size: 1rem; }
    body { padding: 22px 12px 70px; }
  }
"""
data = json.dumps(
    {"fields": list(fields.values()), "groups": [dict(id=i, label=l, page=p) for i, l, p in groups],
     "pages": pages, "siteStyle": site_css, "scenes": scenes, "team": team, "teamPhotos": team_photos},
    ensure_ascii=False, separators=(",", ":")
).replace("<", "\\u003c")
html = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tier 9 website editor</title>
<style>""" + house_css + """</style>
</head>
<body>
<!-- Created: 2026-11-22 · Last Modified: 2026-11-24 · Status: Complete · Refs: tier9studios-main-site -->
""" + editor_html + """
<script id="editor-data" type="application/json">""" + data + """</script>
<script>
""" + editor_js + """</script>
</body>
</html>
"""
plan.write_bytes(html.replace("\n", "\r\n").encode("utf-8"))
print(f"{plan} — {len(fields)} fields, {plan.stat().st_size:,} bytes")
