(() => {
  "use strict";
  const { fields, groups, pages, siteStyle, scenes, team: siteTeam, teamPhotos } = JSON.parse(document.getElementById("editor-data").textContent);
  // The team list is one key: the people in order, each { id, name, role }. Each person's photo is a key of its own,
  // team/photo/<id>: an uploaded image as a data: URL, "none" for no photo, or no value for the site's own photo.
  const teamField = {
    key: "team/members", part: "team", name: "members", group: "team", label: "People", type: "team",
    default: siteTeam.map(({ id, name, role }) => ({ id, name, role }))
  };
  fields.push(teamField);
  const sitePhoto = new Map(siteTeam.filter(person => person.photo).map(person => [person.id, person.photo]));
  const PHOTO_KEY = /^team\/photo\/([a-z0-9][a-z0-9-]{0,39})$/;
  const PERSON_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  // A photo's data: URL must fit one shared-state value (64 KiB of JSON).
  const PHOTO_MAX = 60000, PHOTO_SIDE = 256, TEAM_MAX = 60;
  const $ = id => document.getElementById(id);
  const controls = new Map();
  const byKey = new Map(fields.map(field => [field.key, field]));
  const remote = new Map();
  const pending = new Map();
  const conflicts = new Set();
  const undo = [], redo = [];
  const knownGroups = new Set(groups.map(group => group.id));
  const namespace = "site-editor:v1:";
  const reqPrefix = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const requests = new Map();
  let requestNumber = 0, readRev = 0, connection = "connecting", saving = false;
  let failure = "", syncProblem = false, reading = false, saveTimer;
  let group = groups[0].id, editing = false, compare = false;
  let previewPage = "landing", currentDocument = "", previewReady = false;
  const frame = $("preview");

  function bridge(op, args = {}, timeout = 9000) {
    return new Promise((resolve, reject) => {
      if (window.parent === window) {
        reject(new Error("offline"));
        return;
      }
      const req = reqPrefix + ":" + ++requestNumber;
      const timer = setTimeout(() => {
        requests.delete(req);
        reject(new Error("timeout"));
      }, timeout);
      requests.set(req, reply => {
        clearTimeout(timer);
        if (reply.ok) resolve(reply);
        else reject(new Error(reply.error || "network"));
      });
      window.parent.postMessage({ t9plan: "state", req, op, ...args }, "*");
    });
  }

  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source === frame.contentWindow && data?.type === "site-preview") {
      if (data.op === "ready") {
        previewReady = true;
        sendPreview(true);
      } else if (data.op === "navigate" && [...$("preview-page").options].some(option => option.value === data.page)) {
        navigatePreview(data.page);
      }
      return;
    }
    if (event.source !== window.parent || data?.t9plan !== "state-reply") return;
    const callback = requests.get(data.req);
    if (callback) {
      requests.delete(data.req);
      callback(data);
    }
  });

  function fieldFor(key) {
    const field = byKey.get(key);
    if (field) return field;
    const match = PHOTO_KEY.exec(key);
    return match ? { key, part: "photo", name: match[1], group: "team", label: "Photo", type: "photo", default: null } : null;
  }

  function photoKeys() {
    return new Set([...remote.keys(), ...pending.keys()].filter(key => PHOTO_KEY.test(key)));
  }

  function allKeys() {
    return [...fields.map(field => field.key), ...photoKeys()];
  }

  // Values are text, numbers, booleans, or the team list; two lists are the same when their JSON is.
  function same(a, b) {
    return a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
  }

  function validTeam(list) {
    if (!Array.isArray(list) || !list.length || list.length > TEAM_MAX) return false;
    const ids = new Set();
    return list.every(person => person && Object.getPrototypeOf(person) === Object.prototype &&
      Object.keys(person).every(key => ["id", "name", "role"].includes(key)) &&
      typeof person.id === "string" && PERSON_ID.test(person.id) && !ids.has(person.id) && ids.add(person.id) &&
      typeof person.name === "string" && person.name.trim().length > 0 && person.name.length <= 60 &&
      typeof person.role === "string" && person.role.length <= 60);
  }

  function validPhoto(value) {
    return value === "none" || (typeof value === "string" && value.length <= PHOTO_MAX &&
      /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(value));
  }

  // A key whose draft value differs from the site's own.
  function differs(key) {
    const value = actual(key);
    if (value === null) return false;
    const field = fieldFor(key);
    // The website trims copy, so space around the text changes nothing.
    if (field?.type === "copy") return value.trim() !== field.default;
    // A photo counts only while its person is on the list.
    if (field?.type === "photo") return displayed(teamField).some(person => person.id === field.name);
    return !field || !same(value, field.default);
  }

  // The team list and its photos resolve conflicts together, in the team control.
  const isTeamKey = key => key === teamField.key || PHOTO_KEY.test(key);

  function valid(field, value) {
    if (field.type === "team") return validTeam(value);
    if (field.type === "photo") return validPhoto(value);
    if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    if (field.type === "check") return typeof value === "boolean";
    if (field.type === "choice") return field.choices.some(([choice]) => choice === value);
    if (field.type === "range") {
      return Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isInteger(value));
    }
    return typeof value === "string" && value.trim().length > 0 && value.length <= field.max;
  }

  function actual(key) {
    return pending.has(key) ? pending.get(key).value : remote.get(key)?.value ?? null;
  }

  function displayed(field, useDefaults = false) {
    return (useDefaults ? null : actual(field.key)) ?? field.default;
  }

  function queueValue(key, value) {
    if (connection === "offline") {
      remote.set(key, { value, rev: 0 });
      return;
    }
    const stored = remote.get(key);
    const old = pending.get(key);
    if (same(value, stored?.value ?? null) && !saving) {
      pending.delete(key);
      conflicts.delete(key);
      return;
    }
    pending.set(key, { value, baseRev: old?.baseRev ?? stored?.rev ?? 0 });
  }

  function stage(entries, mergeKey) {
    const edits = [];
    for (const [key, after] of entries) {
      const before = actual(key);
      if (same(before, after)) continue;
      edits.push({ key, before, after });
      queueValue(key, after);
    }
    if (!edits.length) return;
    const last = undo.at(-1);
    if (mergeKey && last?.mergeKey === mergeKey) {
      last.edits[0].after = edits[0].after;
      if (same(last.edits[0].after, last.edits[0].before)) undo.pop();
    } else {
      undo.push({ edits, mergeKey });
      if (undo.length > 100) undo.shift();
    }
    redo.length = 0;
    finishEdit();
  }

  function finishEdit() {
    updateControls();
    setStatus();
    sendPreview();
    scheduleSave();
  }

  function historyStep(from, to, isUndo) {
    const item = from.pop();
    if (!item) return;
    const edits = [];
    for (const { key, before, after } of item.edits) {
      const expected = isUndo ? after : before;
      if (!same(actual(key), expected) || conflicts.has(key)) continue;
      queueValue(key, isUndo ? before : after);
      edits.push({ key, before, after });
    }
    if (edits.length !== item.edits.length) notice("Skipped history changes on fields that changed in the shared draft.");
    if (edits.length) to.push({ edits });
    finishEdit();
  }

  function applyEntries(entries, written = null) {
    for (const entry of entries ?? []) {
      if (!entry.key.startsWith(namespace)) continue;
      const key = entry.key.slice(namespace.length);
      const field = fieldFor(key);
      if (!field || (entry.value !== null && !valid(field, entry.value))) continue;
      const prior = remote.get(key);
      const local = pending.get(key);
      const confirmedWrite = written?.get(key);
      if (entry.rev >= (prior?.rev ?? 0)) remote.set(key, entry);
      if (!local) continue;
      if (confirmedWrite) {
        if (local === confirmedWrite && entry.rev >= (prior?.rev ?? 0)) {
          pending.delete(key);
          conflicts.delete(key);
        } else if (entry.rev >= (prior?.rev ?? 0)) {
          local.baseRev = entry.rev;
          conflicts.delete(key);
        }
        continue;
      }
      if (entry.rev <= local.baseRev || entry.rev < (prior?.rev ?? 0)) continue;
      if (same(entry.value, local.value)) {
        pending.delete(key);
        conflicts.delete(key);
      } else {
        conflicts.add(key);
      }
    }
  }

  async function readChanges(wait) {
    const reply = await bridge("get", { since: readRev, wait }, wait ? 32000 : 9000);
    syncProblem = false;
    applyEntries(reply.entries);
    readRev = Math.max(readRev, reply.rev);
    return reply;
  }

  async function flush() {
    if (connection !== "shared" || saving || failure || !savable()) return;
    saving = true;
    setStatus();
    let sent;
    try {
      await readChanges();
      sent = new Map([...pending].filter(([key]) => !conflicts.has(key)));
      if (sent.size) {
        const set = Object.fromEntries([...sent].map(([key, local]) => [namespace + key, local.value]));
        const reply = await bridge("set", { set });
        applyEntries(reply.entries, sent);
      }
    } catch (error) {
      failure = error.message;
    } finally {
      saving = false;
      updateControls();
      setStatus();
      sendPreview();
      scheduleSave();
    }
  }

  function savable() {
    return [...pending.keys()].some(key => !conflicts.has(key));
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (connection !== "shared" || saving || failure || !savable()) return;
    saveTimer = setTimeout(flush, 600);
  }

  async function poll() {
    if (!["shared", "readonly"].includes(connection) || reading) return;
    reading = true;
    let delay;
    try {
      const reply = await readChanges(25);
      delay = reply.wait ? 100 : 5000;
      updateControls();
      setStatus();
      sendPreview();
    } catch {
      syncProblem = true;
      setStatus();
      delay = 7000;
    } finally {
      reading = false;
      setTimeout(poll, delay);
    }
  }

  async function connect() {
    try {
      const reply = await bridge("hello", {}, 2300);
      await readChanges();
      connection = reply.canWrite ? "shared" : "readonly";
      setTimeout(poll, 100);
    } catch (error) {
      connection = "offline";
      if (window.parent !== window && error.message !== "offline") {
        notice("The shared draft is unavailable in this frame. Open the live team-site plan to sync changes.");
      }
    }
    editing = connection !== "readonly";
    renderFields();
    setStatus();
    sendPreview(true);
  }

  function setStatus() {
    let status = "Connecting", detail = "Loading the shared draft", tone = "";
    if (connection === "offline") {
      status = "Local only";
      detail = "Export before closing to keep these changes";
      tone = "warning";
    } else if (syncProblem && !failure) {
      status = "Sync unavailable";
      detail = "Reconnecting to the shared draft";
      tone = "warning";
    } else if (connection === "readonly") {
      status = "Read only";
      detail = "Shared draft is available to preview and export";
    } else if (failure) {
      status = "Save failed";
      detail = "Your edits are still here. Retry the save or export a copy";
      tone = "error";
    } else if (conflicts.size) {
      status = "Review edits";
      detail = [...new Set([...conflicts].map(key => groups.find(item => item.id === fieldFor(key).group).label))].join(", ");
      tone = "warning";
    } else if (saving || pending.size) {
      status = "Saving";
      detail = pending.size + (pending.size === 1 ? " field waiting" : " fields waiting");
    } else if (connection === "shared") {
      status = "Shared draft saved";
      const changes = allKeys().filter(differs).length;
      detail = changes + (changes === 1 ? " change from the site" : " changes from the site");
      tone = "success";
    }
    $("save-status").textContent = status;
    $("save-status").dataset.tone = tone;
    $("save-detail").textContent = detail;
    $("retry").hidden = !failure;
    $("reload").disabled = !["shared", "readonly"].includes(connection);
    $("undo").disabled = !editing || compare || !undo.length;
    $("redo").disabled = !editing || compare || !redo.length;
    $("export").disabled = connection === "connecting";
    $("import").disabled = !editing || compare;
    $("reset").disabled = !editing || compare || !allKeys().some(key => actual(key) !== null);
  }

  function notice(text) {
    $("editor-warning").textContent = text;
    $("editor-warning").hidden = !text;
  }

  function element(tag, properties = {}) {
    return Object.assign(document.createElement(tag), properties);
  }

  let editNumber = 0;
  function renderFields() {
    const list = $("fields");
    const fragment = document.createDocumentFragment();
    controls.clear();
    for (const field of fields.filter(item => item.group === group)) {
      if (field.type === "team") {
        fragment.append(teamControl(field));
        continue;
      }
      const id = "field-" + field.key;
      const wrapper = element("div", { className: "field" });
      const head = element("div", { className: "field-head" });
      const reset = element("button", { type: "button", className: "field-reset", textContent: "Reset" });
      reset.setAttribute("aria-label", "Reset " + field.label);
      const row = element("div", { className: "field-row" });
      const hint = element("p", { className: "field-help", textContent: field.help ?? "" });
      const error = element("p", { id: id + "-error", className: "field-error", hidden: true });
      const conflict = element("div", { className: "conflict", hidden: true });
      const conflictText = element("p");
      const mine = element("button", { type: "button", textContent: "Keep mine" });
      const theirs = element("button", { type: "button", textContent: "Use shared" });
      const conflictActions = element("div", { className: "actions" });
      conflictActions.append(mine, theirs);
      conflict.append(conflictText, conflictActions);
      let input, swatch, measure, editSession;
      if (field.type === "choice") {
        input = element("select", { id });
        for (const [value, label] of field.choices) input.add(new Option(label, value));
      } else if (field.type === "range") {
        input = element("input", { id, type: "range", min: field.min, max: field.max, step: field.step });
        measure = element("output", { className: "field-measure", htmlFor: id });
      } else if (field.type === "copy" && field.default.length > 78) {
        input = element("textarea", { id, rows: 3, maxLength: field.max });
      } else {
        input = element("input", { id, type: field.type === "check" ? "checkbox" : "text" });
        if (field.type === "copy") input.maxLength = field.max;
        if (field.type === "color") {
          input.maxLength = 7;
          input.spellcheck = false;
          swatch = element("input", { type: "color" });
          swatch.setAttribute("aria-label", field.label + " color picker");
        }
      }
      input.setAttribute("aria-describedby", error.id);
      const label = element("label", { htmlFor: id, textContent: field.label });
      const commitInput = (value, merge) => {
        if (!valid(field, value)) {
          error.textContent = field.type === "color" ? "Enter a six-digit hex color." : "Enter some text.";
          error.hidden = false;
          input.setAttribute("aria-invalid", "true");
          return;
        }
        error.hidden = true;
        input.removeAttribute("aria-invalid");
        const normalized = field.type === "color" ? value.toLowerCase() : value;
        if (swatch) swatch.value = normalized;
        if (measure) measure.textContent = normalized + field.unit;
        stage([[field.key, normalized === field.default ? null : normalized]], merge);
      };
      input.addEventListener("focus", () => { editSession = ++editNumber; });
      input.addEventListener("input", () => {
        const value = field.type === "range" ? input.valueAsNumber : field.type === "check" ? input.checked : input.value;
        commitInput(value, field.type === "choice" || field.type === "check" ? null : editSession);
      });
      input.addEventListener("blur", () => {
        error.hidden = true;
        input.removeAttribute("aria-invalid");
        updateControls();
      });
      if (swatch) {
        swatch.addEventListener("focus", () => { editSession = ++editNumber; });
        swatch.addEventListener("input", () => commitInput(swatch.value, editSession));
      }
      reset.addEventListener("click", () => stage([[field.key, null]]));
      mine.addEventListener("click", () => {
        const local = pending.get(field.key);
        if (!local) return;
        local.baseRev = remote.get(field.key)?.rev ?? 0;
        conflicts.delete(field.key);
        finishEdit();
      });
      theirs.addEventListener("click", () => {
        pending.delete(field.key);
        conflicts.delete(field.key);
        finishEdit();
      });
      head.append(label, reset);
      if (swatch) row.append(swatch);
      row.append(input);
      if (measure) row.append(measure);
      wrapper.append(head, row);
      if (field.help) wrapper.append(hint);
      wrapper.append(error, conflict);
      fragment.append(wrapper);
      controls.set(field.key, { input, swatch, measure, reset, conflict, conflictText, mine, theirs });
    }
    list.replaceChildren(fragment);
    $("group").disabled = false;
    updateControls();
  }

  // Square-crops an image to its centre and encodes it small enough for one shared-state value: WebP where the
  // browser can write it, else PNG, else JPEG on white.
  async function photoFromFile(file) {
    if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
    if (file.size > 20 * 1024 * 1024) throw new Error("The image is larger than 20 MB.");
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("This image could not be read. Try a PNG, JPEG or WebP file.");
    }
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = element("canvas", { width: PHOTO_SIDE, height: PHOTO_SIDE });
    const context = canvas.getContext("2d");
    const draw = () => context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
      0, 0, PHOTO_SIDE, PHOTO_SIDE);
    draw();
    for (const quality of [0.86, 0.76, 0.62]) {
      const url = canvas.toDataURL("image/webp", quality);
      if (url.startsWith("data:image/webp") && url.length <= PHOTO_MAX) return url;
    }
    const png = canvas.toDataURL("image/png");
    if (png.length <= PHOTO_MAX) return png;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PHOTO_SIDE, PHOTO_SIDE);
    draw();
    for (const quality of [0.86, 0.72, 0.58]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= PHOTO_MAX) return url;
    }
    throw new Error("The photo is still too large after resizing. Try a simpler image.");
  }

  function teamControl(field) {
    const wrapper = element("div", { className: "field team-field" });
    const head = element("div", { className: "field-head" });
    const title = element("span", { className: "field-label", textContent: field.label });
    const reset = element("button", { type: "button", className: "field-reset", textContent: "Reset" });
    reset.setAttribute("aria-label", "Reset the team list and photos");
    head.append(title, reset);
    const list = element("ol", { className: "team-list" });
    list.setAttribute("aria-label", "People on the team");
    // Not a <form>: the team site's plan frame is sandboxed without allow-forms, so a form never submits.
    const add = element("div", { className: "team-add" });
    const addName = element("input", { type: "text", placeholder: "Name", maxLength: 60 });
    const addRole = element("input", { type: "text", placeholder: "Role", maxLength: 60 });
    addName.setAttribute("aria-label", "New person's name");
    addRole.setAttribute("aria-label", "New person's role");
    const addButton = element("button", { type: "button", textContent: "Add person" });
    add.append(addName, addRole, addButton);
    const hint = element("p", {
      className: "field-help",
      textContent: "A photo is cropped to a centred square and saved at 256 × 256. Someone without a photo shows their initial."
    });
    const error = element("p", { className: "field-error", hidden: true });
    error.setAttribute("role", "alert");
    const conflict = element("div", { className: "conflict", hidden: true });
    const conflictText = element("p", { textContent: "Another editor changed the team list or a photo you changed." });
    const mine = element("button", { type: "button", textContent: "Keep mine" });
    const theirs = element("button", { type: "button", textContent: "Use shared" });
    const conflictActions = element("div", { className: "actions" });
    conflictActions.append(mine, theirs);
    conflict.append(conflictText, conflictActions);
    const picker = element("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
    wrapper.append(head, list, add, hint, error, conflict, picker);
    let pickFor = null, signature = "", typing = null, rebuilding = false;

    const people = () => displayed(field, compare);
    const listValue = next => same(next, field.default) ? null : next;
    const showError = text => { error.textContent = text; error.hidden = !text; };
    const button = (text, label) => {
      const made = element("button", { type: "button", textContent: text });
      if (label) made.setAttribute("aria-label", label);
      return made;
    };

    function row(person, index, everyone, disabled) {
      const item = element("li", { className: "team-row" });
      const photo = photoOf(person.id, compare);
      const src = photo ? (photo.startsWith("data:") ? photo : teamPhotos[photo]) : null;
      const face = src ? element("img", { className: "team-face", src, alt: "" })
        : element("span", { className: "team-face", textContent: ([...person.name.trim()][0] ?? "?").toUpperCase() });
      const inputs = element("div", { className: "team-inputs" });
      for (const part of ["name", "role"]) {
        const input = element("input", { type: "text", value: person[part], maxLength: 60, disabled });
        input.setAttribute("aria-label", (part === "name" ? "Name of " : "Role of ") + person.name);
        input.dataset.person = person.id;
        input.dataset.part = part;
        input.addEventListener("input", () => {
          // One undo step per field per visit: the rows are rebuilt under the caret, so the step is tracked here.
          const slot = person.id + ":" + part;
          if (typing?.slot !== slot) typing = { slot, merge: ++editNumber };
          if (part === "name" && !input.value.trim()) {
            showError("Enter a name.");
            input.setAttribute("aria-invalid", "true");
            return;
          }
          showError("");
          input.removeAttribute("aria-invalid");
          const next = people().map(other => other.id === person.id ? { ...other, [part]: input.value } : other);
          stage([[field.key, listValue(next)]], typing.merge);
        });
        input.addEventListener("blur", () => {
          // Rebuilding the rows under the caret blurs the old input (Chrome fires blur before removing it); that is
          // not the visitor leaving the field.
          if (rebuilding) return;
          typing = null;
          showError("");
          input.removeAttribute("aria-invalid");
          signature = "";
          updateControls();
        });
        inputs.append(input);
      }
      const actions = element("div", { className: "team-actions" });
      const upload = button("Upload photo", "Upload a photo of " + person.name);
      const clear = button("Remove photo", "Remove the photo of " + person.name);
      const restore = button("Site photo", "Use the website's photo of " + person.name);
      const up = button("↑", "Move " + person.name + " up");
      const down = button("↓", "Move " + person.name + " down");
      const remove = button("Remove", "Remove " + person.name + " from the team");
      const own = actual("team/photo/" + person.id);
      upload.disabled = disabled;
      clear.disabled = disabled || !photo;
      restore.hidden = !(own !== null && sitePhoto.has(person.id));
      restore.disabled = disabled;
      up.disabled = disabled || index === 0;
      down.disabled = disabled || index === everyone.length - 1;
      remove.disabled = disabled;
      upload.addEventListener("click", () => { pickFor = person.id; picker.click(); });
      clear.addEventListener("click", () => stage([["team/photo/" + person.id, sitePhoto.has(person.id) ? "none" : null]]));
      restore.addEventListener("click", () => stage([["team/photo/" + person.id, null]]));
      const move = step => {
        const next = people().slice();
        const at = next.findIndex(other => other.id === person.id);
        if (at < 0 || !next[at + step]) return;
        [next[at], next[at + step]] = [next[at + step], next[at]];
        stage([[field.key, listValue(next)]]);
      };
      up.addEventListener("click", () => move(-1));
      down.addEventListener("click", () => move(1));
      remove.addEventListener("click", () => {
        const next = people().filter(other => other.id !== person.id);
        if (!next.length) {
          showError("The team needs at least one person.");
          return;
        }
        stage([[field.key, listValue(next)], ["team/photo/" + person.id, null]]);
      });
      actions.append(upload, clear, restore, up, down, remove);
      inputs.append(actions);
      item.append(face, inputs);
      return item;
    }

    function render() {
      const disabled = !editing || compare;
      const everyone = people();
      reset.disabled = disabled || (actual(field.key) === null && ![...photoKeys()].some(key => actual(key) !== null));
      addName.disabled = addRole.disabled = addButton.disabled = disabled || everyone.length >= TEAM_MAX;
      conflict.hidden = ![...conflicts].some(isTeamKey);
      mine.disabled = theirs.disabled = disabled;
      const next = JSON.stringify([disabled, everyone.map(person => {
        const photo = photoOf(person.id, compare) ?? "";
        return [person.id, person.name, person.role, photo.length, photo.slice(-32), actual("team/photo/" + person.id) !== null];
      })]);
      if (next === signature) return;
      signature = next;
      // Rebuilding the rows must not lose the caret of someone typing a name or role.
      const focused = document.activeElement;
      const caret = list.contains(focused) && focused.dataset.person
        ? { person: focused.dataset.person, part: focused.dataset.part, start: focused.selectionStart, end: focused.selectionEnd }
        : null;
      rebuilding = true;
      try {
        list.replaceChildren(...everyone.map((person, index) => row(person, index, everyone, disabled)));
        if (caret) {
          const again = list.querySelector('[data-person="' + caret.person + '"][data-part="' + caret.part + '"]');
          if (again) {
            again.focus();
            if (caret.start !== null) again.setSelectionRange(caret.start, caret.end);
          }
        }
      } finally {
        rebuilding = false;
      }
    }

    reset.addEventListener("click", () => stage([[field.key, null], ...[...photoKeys()].map(key => [key, null])]));
    picker.addEventListener("change", async () => {
      const file = picker.files[0];
      const id = pickFor;
      picker.value = "";
      pickFor = null;
      if (!file || !id) return;
      try {
        const photo = await photoFromFile(file);
        showError("");
        stage([["team/photo/" + id, photo]]);
      } catch (problem) {
        showError(problem.message);
      }
    });
    const addPerson = () => {
      const name = addName.value.trim(), role = addRole.value.trim();
      if (!name) {
        showError("Enter the new person's name.");
        addName.focus();
        return;
      }
      const everyone = people();
      // The id names the person's photo file. A removed person's id stays taken (a site photo, or a photo still in
      // the draft), so a newcomer never inherits someone's photo.
      const base = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "person";
      const drafted = [...photoKeys()].filter(key => actual(key) !== null).map(key => PHOTO_KEY.exec(key)[1]);
      const taken = new Set([...everyone.map(person => person.id), ...sitePhoto.keys(), ...drafted]);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = base + "-" + n;
      showError("");
      stage([[field.key, listValue([...everyone, { id, name, role }])]]);
      addName.value = addRole.value = "";
      addName.focus();
    };
    addButton.addEventListener("click", addPerson);
    for (const input of [addName, addRole]) {
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          addPerson();
        }
      });
    }
    mine.addEventListener("click", () => {
      for (const key of [...conflicts].filter(isTeamKey)) {
        const local = pending.get(key);
        if (local) local.baseRev = remote.get(key)?.rev ?? 0;
        conflicts.delete(key);
      }
      finishEdit();
    });
    theirs.addEventListener("click", () => {
      for (const key of [...conflicts].filter(isTeamKey)) {
        pending.delete(key);
        conflicts.delete(key);
      }
      finishEdit();
    });
    controls.set(field.key, { render });
    return wrapper;
  }

  function updateControls() {
    for (const [key, view] of controls) {
      if (view.render) {
        view.render();
        continue;
      }
      const field = byKey.get(key);
      const value = displayed(field, compare);
      const disabled = !editing || compare;
      view.input.disabled = disabled;
      view.reset.disabled = disabled || actual(key) === null;
      if (field.type === "check") view.input.checked = value;
      else if (view.input.value !== String(value) &&
               (document.activeElement !== view.input || disabled ||
                (!pending.has(key) && !view.input.hasAttribute("aria-invalid")))) view.input.value = value;
      if (view.swatch) {
        view.swatch.disabled = disabled;
        if (document.activeElement !== view.swatch) view.swatch.value = value;
      }
      if (view.measure) view.measure.textContent = value + field.unit;
      view.conflict.hidden = !conflicts.has(key);
      view.mine.disabled = disabled;
      view.theirs.disabled = disabled;
      if (!view.conflict.hidden) {
        const shared = remote.get(key);
        const text = shared.value ?? field.default;
        view.conflictText.textContent = (shared.by || "Another editor") + " changed this field to “" + text + "”.";
      }
    }
  }

  // A person's photo: an uploaded data: URL, the site's own photo path, or null for their initial.
  function photoOf(id, useDefaults) {
    const own = useDefaults ? null : actual("team/photo/" + id);
    if (own === "none") return null;
    return own ?? sitePhoto.get(id) ?? null;
  }

  function teamMembers(useDefaults) {
    return displayed(teamField, useDefaults).map(person => ({ ...person, photo: photoOf(person.id, useDefaults) }));
  }

  // withDefaults: every value, for the preview. Otherwise only the draft's own values, for the export file that
  // tools/apply-site-settings.mjs writes into the website. The team goes in whole once any part of it changed.
  function settings(useDefaults, withDefaults) {
    const result = { version: 1, copy: {}, colors: {}, motion: {} };
    for (const field of fields) {
      if (field.type === "team") continue;
      const value = withDefaults ? displayed(field, useDefaults) : actual(field.key);
      if (value !== null) result[field.part][field.name] = value;
    }
    const teamChanged = actual(teamField.key) !== null || [...photoKeys()].some(key => actual(key) !== null);
    if (withDefaults || teamChanged) result.team = { members: teamMembers(useDefaults) };
    return result;
  }

  function importSettings(text) {
    const data = JSON.parse(text);
    const parts = ["copy", "colors", "motion"];
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || data.version !== 1 ||
        Object.keys(data).some(key => key !== "version" && key !== "team" && !parts.includes(key))) {
      throw new Error("Expected version 1 of site-settings.json.");
    }
    const imported = new Map();
    for (const part of parts) {
      if (!Object.hasOwn(data, part)) continue;
      const entries = data[part];
      if (!entries || Object.getPrototypeOf(entries) !== Object.prototype) throw new Error("Invalid " + part + " settings.");
      for (const [name, value] of Object.entries(entries)) {
        const field = byKey.get(part + "/" + name);
        if (!field || field.type === "team" || !valid(field, value)) throw new Error("Invalid setting " + part + "." + name + ".");
        imported.set(field.key, value === field.default ? null : value);
      }
    }
    const photos = new Map();
    if (Object.hasOwn(data, "team")) {
      const members = data.team?.members;
      if (!Array.isArray(members)) throw new Error("Invalid team settings.");
      const list = members.map(person => ({ id: person?.id, name: person?.name, role: person?.role ?? "" }));
      if (!validTeam(list)) throw new Error("Invalid team list.");
      imported.set(teamField.key, same(list, teamField.default) ? null : list);
      for (const person of members) {
        let value;
        if (person.photo === null || person.photo === undefined) value = sitePhoto.has(person.id) ? "none" : null;
        else if (person.photo === sitePhoto.get(person.id)) value = null;
        else if (person.photo.startsWith?.("data:") && validPhoto(person.photo)) value = person.photo;
        else throw new Error("Invalid photo for " + person.name + ".");
        photos.set("team/photo/" + person.id, value);
      }
    }
    return [...fields.map(field => [field.key, imported.get(field.key) ?? null]),
            ...[...new Set([...photoKeys(), ...photos.keys()])].map(key => [key, photos.get(key) ?? null])];
  }

  function sendPreview(navigate = false) {
    if (!previewReady) return;
    const shown = settings(compare, true);
    // The frame has no copy of the site's files: a site photo goes to it as the data: URL bundled at build time.
    shown.team.members = shown.team.members.map(person =>
      ({ ...person, photo: person.photo && !person.photo.startsWith("data:") ? teamPhotos[person.photo] ?? null : person.photo }));
    frame.contentWindow.postMessage({ type: "site-preview-settings", page: navigate ? previewPage : "", settings: shown }, "*");
  }

  function navigatePreview(page) {
    previewPage = page;
    $("preview-page").value = page;
    const path = page === "careers-page" ? "careers" : "home";
    if (path === currentDocument) {
      sendPreview(true);
      return;
    }
    currentDocument = path;
    previewReady = false;
    // Data is bundled at build time. The preview's runtime accepts settings only by postMessage.
    const opening = "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><style>";
    const script = "<scr" + "ipt>(" + previewRuntime.toString() + ")(" + JSON.stringify(scenes) + ");</scr" + "ipt>";
    frame.srcdoc = opening + siteStyle + "</style></head>" + pages[path] + script + "</html>";
  }

  for (const item of groups) $("group").add(new Option(item.label, item.id));
  $("group").addEventListener("change", () => {
    const next = $("group").value;
    if (!knownGroups.has(next)) return;
    group = next;
    renderFields();
    $("fields").scrollTop = 0;
    navigatePreview(groups.find(item => item.id === next).page || previewPage);
  });
  $("preview-page").addEventListener("change", event => navigatePreview(event.target.value));
  $("phone").addEventListener("click", () => {
    const selected = $("preview-stage").classList.toggle("phone");
    $("phone").setAttribute("aria-pressed", String(selected));
  });
  $("compare").addEventListener("click", () => {
    compare = !compare;
    $("compare").setAttribute("aria-pressed", String(compare));
    $("compare").textContent = compare ? "Return to draft" : "View defaults";
    updateControls();
    setStatus();
    sendPreview();
  });
  $("undo").addEventListener("click", () => historyStep(undo, redo, true));
  $("redo").addEventListener("click", () => historyStep(redo, undo, false));
  $("retry").addEventListener("click", () => {
    failure = "";
    flush();
    setStatus();
  });
  $("reload").addEventListener("click", async () => {
    $("reload").disabled = true;
    notice("");
    try {
      await readChanges();
      finishEdit();
    } catch {
      notice("Could not sync the shared draft. Your edits are still here.");
      setStatus();
    }
  });
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(settings(false, false), null, 2) + "\n"], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = element("a", { href, download: "site-settings.json" });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  });
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const input = $("import-file");
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("The file is larger than 4 MB.");
      stage(importSettings(await file.text()));
      notice("Settings imported into the draft.");
    } catch (error) {
      notice("Import failed. " + error.message);
    }
  });
  $("reset").addEventListener("click", () => $("reset-dialog").showModal());
  $("cancel-reset").addEventListener("click", () => $("reset-dialog").close());
  $("confirm-reset").addEventListener("click", () => {
    $("reset-dialog").close();
    stage(allKeys().map(key => [key, null]));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  /* Runs inside the isolated website preview frame. */
  function previewRuntime(scenes) {
    let motion = null, timer, currentBiome, bag = [];
    const ids = Object.keys(scenes);
    const scene = document.createElement("div");
    scene.className = "scene shown preview-scene";
    scene.setAttribute("aria-hidden", "true");
    document.querySelector(".veil").before(scene);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const dash = value => value.replace(/[A-Z]/g, match => "-" + match.toLowerCase());
    const url = value => 'url("' + value + '")';

    function makeScene(id) {
      const model = scenes[id];
      const background = document.createElement("div");
      background.className = "layer";
      background.style.backgroundImage = url(model.background);
      background.style.backgroundSize = model.width * 100 + "vh 100%";
      background.style.backgroundPosition = "center";
      const floor = document.createElement("div");
      floor.className = "floor";
      floor.style.backgroundImage = url(model.floor);
      const still = motion.mode === "still" || reduce.matches;
      const state = still ? model.idle : model.walk;
      scene.replaceChildren(background, floor);
      for (const [index, position] of [12, 46, 76].entries()) {
        const actor = document.createElement("div");
        actor.className = "preview-actor";
        actor.style.left = position + "%";
        actor.style.height = "calc(var(--cell) * " + state.tiles + ")";
        actor.style.aspectRatio = state.aspect;
        actor.style.bottom = "calc(var(--cell) * " + (2.4 - model.feet - (.04 * index)) + ")";
        actor.style.backgroundImage = url(state.file);
        actor.style.backgroundSize = state.frames * 100 + "% 100%";
        if (!still) {
          actor.animate([{ backgroundPosition: "0 0" }, { backgroundPosition: state.frames * 100 / (state.frames - 1) + "% 0" }],
            { duration: state.frames * 1000 / state.fps, iterations: Infinity, easing: "steps(" + state.frames + ")" });
          actor.animate([{ transform: "translateX(0)" }, { transform: "translateX(" + (index % 2 ? 13 : -13) + "vw)" }],
            { duration: 5200 + index * 1200, iterations: Infinity, direction: "alternate" });
        }
        scene.append(actor);
      }
      currentBiome = id;
    }
    function nextBiome() {
      if (motion.biome !== "random") return motion.biome;
      if (!bag.length) {
        bag = ids.slice();
        for (let index = bag.length - 1; index > 0; index--) {
          const other = Math.floor(Math.random() * (index + 1));
          [bag[index], bag[other]] = [bag[other], bag[index]];
        }
        if (bag.at(-1) === currentBiome) bag.unshift(bag.pop());
      }
      return bag.pop();
    }
    function scheduleRotation() {
      clearTimeout(timer);
      if (motion.mode === "still" || reduce.matches || !motion.rotateBiomes || motion.biome !== "random") return;
      timer = setTimeout(() => {
        makeScene(nextBiome());
        scheduleRotation();
      }, motion.intervalSeconds * 1000);
    }
    reduce.addEventListener("change", () => {
      if (!currentBiome) return;
      makeScene(currentBiome);
      scheduleRotation();
    });
    function navigate(page) {
      if (!document.body.classList.contains("home")) return;
      document.body.dataset.previewView = page === "landing" ? "landing" : "main";
      const targeted = document.getElementById(page);
      if (targeted) targeted.scrollIntoView({ behavior: "instant", block: "start" });
      else window.scrollTo({ top: 0, behavior: "instant" });
    }
    window.addEventListener("message", event => {
      if (event.source !== window.parent || event.data?.type !== "site-preview-settings") return;
      const { settings, page } = event.data;
      for (const node of document.querySelectorAll("[data-site-copy]")) {
        const text = settings.copy[node.dataset.siteCopy];
        if (typeof text === "string" && text !== node.textContent) node.textContent = text;
      }
      // The same markup tools/apply-site-settings.mjs writes, built from text nodes only.
      const team = document.querySelector("ul.team");
      if (team && settings.team) {
        team.replaceChildren(...settings.team.members.map(person => {
          const item = document.createElement("li");
          item.className = "person";
          let face;
          if (typeof person.photo === "string" && person.photo.startsWith("data:image/")) {
            face = document.createElement("img");
            face.className = "person__photo";
            face.width = face.height = 256;
            face.alt = "";
            face.src = person.photo;
          } else {
            face = document.createElement("span");
            face.className = "person__mark";
            face.setAttribute("aria-hidden", "true");
            face.textContent = ([...person.name.trim()][0] ?? "?").toUpperCase();
          }
          const who = document.createElement("span");
          who.className = "person__who";
          const name = document.createElement("b");
          name.textContent = person.name.trim();
          who.append(name);
          if (person.role.trim()) {
            const role = document.createElement("span");
            role.textContent = person.role.trim();
            who.append(role);
          }
          item.append(face, who);
          return item;
        }));
      }
      for (const [key, value] of Object.entries(settings.colors)) {
        document.documentElement.style.setProperty("--" + dash(key), value);
      }
      document.documentElement.style.setProperty("--site-blur", settings.motion.blurPx + "px");
      const next = settings.motion;
      document.documentElement.dataset.siteMotion = next.mode;
      const rebuild = !motion || motion.biome !== next.biome || motion.mode !== next.mode;
      const reschedule = rebuild || motion.rotateBiomes !== next.rotateBiomes || motion.intervalSeconds !== next.intervalSeconds;
      const biome = rebuild && (!motion || motion.biome !== next.biome);
      motion = next;
      if (rebuild) makeScene(biome ? nextBiome() : currentBiome);
      if (reschedule) scheduleRotation();
      if (page) navigate(page);
    });
    document.addEventListener("click", event => {
      const link = event.target.closest("a");
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href");
      let page;
      if (href === "/careers/") page = "careers-page";
      else if (href === "/" || href === "#top") page = "landing";
      else if (href === "#main") page = "studio";
      else if (/^\/?#(?:studio|games|team|work|community|careers)$/.test(href || "")) page = href.split("#")[1];
      if (page) window.parent.postMessage({ type: "site-preview", op: "navigate", page }, "*");
      else if (href?.startsWith("#")) document.getElementById(href.slice(1))?.scrollIntoView();
    });
    window.parent.postMessage({ type: "site-preview", op: "ready" }, "*");
  }

  navigatePreview("landing");
  connect();
})();
