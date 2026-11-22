// A live World 1 biome behind the page, the same scene /abw/ draws with its own inline copy of this script.
// /assets/abw/biomes.json lists five biomes, each with its battle background layers, floor, props and monsters,
// all cut from the game. Every load and every 30 s shows the next biome from a shuffled bag kept in localStorage,
// so no biome repeats until all five have been shown. Each page has a .veil element that site.css blurs to put the
// scene out of focus behind the main site; scenes go in just before it, so the veil always covers them.
(function () {
    var BAG_KEY = "t9.abw.biomeBag", LAST_KEY = "t9.abw.lastBiome";
    var ROTATE_MS = 30000, FADE_MS = 1200;
    var biomes = [], current = null, lastWidth = window.innerWidth;
    // A visitor who has asked their system for reduced motion gets one still scene: nothing walks, drifts or
    // loops, and the biome does not change while the page stays open.
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function rand(a, b) { return a + Math.random() * (b - a); }
    function div(cls, parent) {
        var d = document.createElement("div");
        d.className = cls;
        if (parent) parent.appendChild(d);
        return d;
    }
    function url(f) { return 'url("' + f + '")'; }
    function shuffle(a) {
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1)), t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }
    function weighted(items) {
        var total = 0, i;
        for (i = 0; i < items.length; i++) total += items[i].weight;
        var r = Math.random() * total;
        for (i = 0; i < items.length; i++) if ((r -= items[i].weight) < 0) return items[i];
        return items[items.length - 1];
    }
    // Private browsing can refuse storage; the rotation still works for the current visit.
    function load(key, fallback) {
        try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
    }
    function save(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* keep going without persistence */ }
    }

    // Take the next biome from the bag. A new bag never starts with the biome just shown.
    function nextBiome() {
        var ids = biomes.map(function (b) { return b.id; });
        var bag = load(BAG_KEY, []).filter(function (id) { return ids.indexOf(id) >= 0; });
        var lastId = load(LAST_KEY, null);
        if (!bag.length) {
            bag = shuffle(ids.slice());
            if (bag.length > 1 && bag[0] === lastId) bag.push(bag.shift());
        }
        var id = bag.shift();
        save(BAG_KEY, bag);
        save(LAST_KEY, id);
        return biomes[ids.indexOf(id)];
    }

    // Background layers are tiles one scene height tall, so every size below is in vh.
    function addLayer(scene, l) {
        var d = div("layer", scene), w = l.w * 100;
        d.style.backgroundImage = url(l.file);
        if (l.role === "anim") {
            // An animated band: a vertical sheet of frames for one strip of the background.
            var sheet = l.h * l.frames * 100;
            d.style.top = l.top * 100 + "vh";
            d.style.bottom = "auto";
            d.style.height = l.h * 100 + "vh";
            d.style.backgroundSize = w + "vh " + sheet + "vh";
            if (!still) {
                d.animate([{ backgroundPosition: "0 0" }, { backgroundPosition: "0 -" + sheet + "vh" }],
                    { duration: l.frames / l.fps * 1000, iterations: Infinity, easing: "steps(" + l.frames + ")" });
            }
            return;
        }
        d.style.backgroundSize = w + "vh 100%";
        if (l.role === "drift") {
            // Auto-scrolling clouds and fog: slide one tile width per loop, at the game's speed.
            d.style.left = -w + "vh";
            d.style.width = "calc(100% + " + w + "vh)";
            var a = l.dir > 0 ? 0 : w, b = l.dir > 0 ? w : 0;
            if (!still) {
                d.animate([{ transform: "translateX(" + a + "vh)" }, { transform: "translateX(" + b + "vh)" }],
                    { duration: l.seconds * 1000, iterations: Infinity });
            }
        }
    }

    function build(b) {
        var s = { biome: b, el: div("scene"), critters: [] };
        s.el.setAttribute("aria-hidden", "true");
        b.layers.forEach(function (l) { addLayer(s.el, l); });
        // Bushes and trees stand behind the floor, so its top tile row covers their base.
        s.back = div("layer", s.el);
        s.floor = div("floor", s.el);
        s.floor.style.backgroundImage = url(b.floor);
        s.props = div("layer", s.el);
        s.crew = div("layer", s.el);
        return s;
    }

    // Props are drawn at their in-game size, as two separate rows. Back-row props (bushes, trees) stand behind the
    // floor, sunk by their most common in-game depth, so its top tile row covers their base. Front props stand at
    // the top edge of the path, in tiles below the floor's top edge: behind the line the monsters walk on, so none
    // of them shows under a monster's feet.
    var PATH_TOP = 0.15;
    function placeProps(s) {
        var decor = s.biome.decor;
        placeRow(s, s.back, decor.filter(function (p) { return p.back; }), 1, 4, null);
        placeRow(s, s.props, decor.filter(function (p) { return !p.back; }), 1.5, 5, PATH_TOP);
    }

    // sink: how far below the floor's top edge each prop's bottom stands, in tiles; null keeps each prop's own.
    function placeRow(s, layer, items, minGap, maxGap, sink) {
        layer.textContent = "";
        if (!items.length) return;
        var w = layer.clientWidth, floorH = s.floor.offsetHeight, cell = floorH / 2.4;
        var x = rand(-1, 1) * cell;
        while (x < w) {
            var p = weighted(items), pw = p.w * cell, ph = p.h * cell;
            var d = div("prop", layer);
            d.style.width = pw + "px";
            d.style.height = ph + "px";
            d.style.backgroundImage = url(p.file);
            d.style.backgroundSize = p.frames * pw + "px " + ph + "px";
            var flip = Math.random() < p.flip ? " scaleX(-1)" : "";
            var depth = sink == null ? p.sink : sink;
            d.style.transform = "translate(" + x + "px," + -(floorH - depth * cell) + "px)" + flip;
            if (p.frames > 1 && !still) {
                d.animate([{ backgroundPosition: "0 0" }, { backgroundPosition: -p.frames * pw + "px 0" }],
                    { duration: p.frames / p.fps * 1000, iterations: Infinity, easing: "steps(" + p.frames + ")" });
            }
            x += pw + rand(minGap, maxGap) * cell;
        }
    }

    // Three to eight monsters by screen width, cycling through the biome's picks so each one appears.
    function spawnCrew(s) {
        s.crew.textContent = "";
        s.critters = [];
        var w = s.crew.clientWidth, floorH = s.floor.offsetHeight;
        var picks = shuffle(s.biome.monsters.slice());
        var count = Math.max(3, Math.min(8, Math.round(w / 240)));
        // Every monster walks the middle of the path (the middle of the biome's walkable band in the floor's top
        // tile row), so all their feet stand on one line.
        var sink = (s.biome.feet[0] + s.biome.feet[1]) / 2;
        for (var i = 0; i < count; i++) {
            var k = {
                m: picks[i % picks.length],
                el: div("monster", s.crew),
                cell: floorH / 2.4,
                floorH: floorH,
                x: (i + rand(0, 0.8)) * w / count,
                dir: Math.random() < 0.5 ? -1 : 1,
                sink: sink
            };
            k.sheets = { walk: sheet(k.el, k.m.walk), idle: sheet(k.el, k.m.idle) };
            // A still scene has nothing to step it: each monster stands in one frame of its idle pose.
            setAnim(k, still ? "idle" : "walk", rand(2, 7));
            k.t = rand(0, 1);
            s.critters.push(k);
            draw(k);
        }
    }

    function sheet(parent, a) {
        var d = div("", parent);
        d.style.backgroundImage = url(a.file);
        d.style.backgroundSize = a.frames * 100 + "% 100%";
        return d;
    }

    // Switch animation without reloading anything: resize the box and show the other sheet in the same frame.
    function setAnim(k, name, seconds) {
        var a = k.m[name];
        if (k.state) k.sheets[k.state].style.visibility = "hidden";
        k.sheets[name].style.visibility = "visible";
        k.anim = a;
        k.state = name;
        k.t = 0;
        k.timer = seconds;
        k.h = a.tiles * k.cell;
        k.w = k.h * a.aspect;
        k.el.style.width = k.w + "px";
        k.el.style.height = k.h + "px";
        // Mirror around the sprite's pivot, so turning around does not shift it sideways.
        k.el.style.transformOrigin = a.pivotX * 100 + "% 100%";
    }

    function draw(k) {
        var a = k.anim, f = Math.floor(k.t * a.fps) % a.frames;
        k.sheets[k.state].style.backgroundPosition = (a.frames > 1 ? f * 100 / (a.frames - 1) : 0) + "% 0";
        // Each strip's bottom row is the lowest foot pixel of its frames: stand it on the path line.
        // (The game's sprite pivot sits a little below the art and would leave a visible gap.)
        var bottom = k.floorH - k.sink * k.cell;
        var flip = k.dir === k.m.faces ? 1 : -1;
        k.el.style.transform = "translate3d(" + (k.x - a.pivotX * k.w) + "px," + -bottom + "px,0) scaleX(" + flip + ")";
    }

    function step(k, dt, w) {
        var a = k.anim;
        k.t += dt;
        k.timer -= dt;
        var f = Math.floor(k.t * a.fps) % a.frames;
        if (k.state === "walk") {
            // movementSpeed is in thousandths of a world unit per second; one floor tile is 1.28 units tall.
            var speed = k.m.speed / 1000 * k.cell / 1.28;
            // A hopper only moves while airborne (frames 2 to 6), five frames out of its cycle.
            if (!k.m.hop) k.x += k.dir * speed * dt;
            else if (f >= 2 && f <= 6) k.x += k.dir * speed * a.frames / 5 * dt;
            if (k.dir > 0 && k.x - k.w > w) k.x = -k.w;
            if (k.dir < 0 && k.x + k.w < 0) k.x = w + k.w;
            // Stop only at the start of a cycle, so nobody freezes in mid-air.
            if (k.timer <= 0 && f === 0) setAnim(k, "idle", rand(1.2, 3.5));
        } else if (k.timer <= 0) {
            if (Math.random() < 0.3) k.dir = -k.dir;
            setAnim(k, "walk", rand(3, 9));
        }
        draw(k);
    }

    function populate(s) {
        placeProps(s);
        spawnCrew(s);
    }

    // Wait (briefly) for every image of the biome to download and decode: background, floor, props, and both
    // animations of every monster. Without this, a monster's idle sheet first loads at its first stop and the
    // monster blinks out while it arrives. The decoded images are kept so the browser does not drop them.
    var decoded = [];
    function ready(b) {
        var files = b.layers.map(function (l) { return l.file; }).concat([b.floor]);
        b.decor.forEach(function (p) { files.push(p.file); });
        b.monsters.forEach(function (m) { files.push(m.walk.file, m.idle.file); });
        decoded = [];
        var loads = files.map(function (f) {
            var img = new Image();
            img.src = f;
            decoded.push(img);
            return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
        });
        return Promise.race([Promise.all(loads), new Promise(function (r) { setTimeout(r, 4000); })]);
    }

    function show(b) {
        return ready(b).then(function () {
            var old = current, s = build(b);
            // After any older scene, so the new one fades in on top of it, and under the veil.
            document.body.insertBefore(s.el, document.querySelector(".veil"));
            populate(s);
            current = s;
            requestAnimationFrame(function () { s.el.classList.add("shown"); });
            if (old) setTimeout(function () { old.el.remove(); }, FADE_MS + 100);
        });
    }

    function rotate() {
        show(nextBiome()).then(function () { if (!still) setTimeout(rotate, ROTATE_MS); });
    }

    var last = 0;
    function tick(now) {
        // Clamp the step so a background tab does not teleport everyone on return.
        var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        if (current) {
            var w = current.crew.clientWidth;
            for (var i = 0; i < current.critters.length; i++) step(current.critters[i], dt, w);
        }
        requestAnimationFrame(tick);
    }

    // Re-lay props and monsters only when the width changes: mobile toolbars change the height on every scroll.
    var resizeTimer;
    window.addEventListener("resize", function () {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { if (current) populate(current); }, 200);
    });

    fetch("/assets/abw/biomes.json")
        .then(function (r) { return r.json(); })
        .then(function (list) {
            biomes = list;
            rotate();
            if (!still) requestAnimationFrame(tick);
        });
})();
