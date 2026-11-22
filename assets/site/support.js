// Support request form on /support/. Posts the fields as a JSON string to the team site's public
// support route, shows the reference code it returns, and falls back to a prefilled email when the
// request cannot be sent.
(function () {
    "use strict";

    var SUPPORT_EMAIL = "autobattlesonline@gmail.com";
    var TIMEOUT_MS = 20000;
    var MAX_BODY_BYTES = 16384;
    var LIMITS = { email: 254, playerName: 60, server: 60, orderId: 120, device: 120, message: 5000 };
    var MESSAGE_MIN = 10;
    var CHOICES = {
        game: { abw: "9999+ Weapons: Idle RPG", abo: "Auto Battles Online" },
        platform: { android: "Android (Google Play)", ios: "iPhone or iPad (App Store)", steam: "Windows (Steam)", other: "Other" },
        topic: {
            purchase: "Purchase or billing",
            bug: "Bug or technical problem",
            account: "Account, login or lost progress",
            deletion: "Delete my account or data",
            feedback: "Feedback or suggestion",
            other: "Something else"
        }
    };
    var LABELS = {
        game: "Game", platform: "Platform", topic: "Topic", email: "Email", playerName: "In-game name",
        server: "Server", orderId: "Order or transaction ID", device: "Device and operating system", message: "Message"
    };
    // The same email rule as the team site's hiring form.
    var EMAIL_LOCAL_RX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
    var EMAIL_LABEL_RX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
    // Control characters (Unicode category Cc, the same check the team site makes): the message
    // may hold newlines and tabs, the single-line fields nothing.
    var CONTROL_RX = /\p{Cc}/u;
    var MESSAGE_CONTROL_RX = /[^\P{Cc}\t\n]/u;

    function isEmail(raw) {
        if (!raw || raw.length > LIMITS.email) return false;
        var at = raw.lastIndexOf("@");
        if (at < 0) return false;
        var local = raw.slice(0, at);
        var labels = raw.slice(at + 1).split(".");
        if (!EMAIL_LOCAL_RX.test(local) || local.charAt(0) === "." || local.slice(-1) === "." || local.indexOf("..") >= 0) return false;
        return labels.length >= 2 && labels.every(function (l) { return EMAIL_LABEL_RX.test(l); }) &&
            /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
    }

    function apiBase(params) {
        var meta = document.querySelector('meta[name="t9-api"]');
        var base = (meta && meta.content) || "https://team.tier9studios.com";
        // A copy of the page on the developer's own machine may point at a local server.
        var host = window.location.hostname;
        var override = params.get("api");
        if ((host === "localhost" || host === "127.0.0.1") && override && /^https?:\/\//i.test(override)) base = override;
        return base.replace(/\/+$/, "");
    }

    function init() {
        var form = document.getElementById("support-form");
        if (!form) return;
        var params = new URLSearchParams(window.location.search);
        var API = apiBase(params);
        var el = {
            request: document.getElementById("request"),
            sent: document.getElementById("sent"),
            sentTitle: document.getElementById("sent-title"),
            sentRef: document.getElementById("sent-ref"),
            sentEmail: document.getElementById("sent-email"),
            another: document.getElementById("send-another"),
            notice: document.getElementById("form-notice"),
            submit: document.getElementById("f-submit"),
            spinner: document.querySelector("#f-submit .spinner"),
            submitLabel: document.querySelector("#f-submit .label"),
            used: document.getElementById("f-message-used"),
            count: document.getElementById("f-message-count"),
            announce: document.getElementById("announce"),
            wrapOrder: document.getElementById("wrap-order"),
            wrapDevice: document.getElementById("wrap-device")
        };
        var fields = {};
        ["game", "platform", "topic", "email", "playerName", "server", "orderId", "device", "message", "website"].forEach(function (name) {
            fields[name] = form.elements.namedItem(name);
        });
        var sending = false;

        // ---- preselect from the query string ----
        ["game", "platform", "topic"].forEach(function (name) {
            var v = params.get(name);
            if (v && Object.prototype.hasOwnProperty.call(CHOICES[name], v)) fields[name].value = v;
        });

        // ---- topic-specific fields and the character count ----
        function syncTopic() {
            var topic = fields.topic.value;
            el.wrapOrder.hidden = topic !== "purchase";
            el.wrapDevice.hidden = topic !== "bug";
            if (el.wrapOrder.hidden) clearError("orderId");
            if (el.wrapDevice.hidden) clearError("device");
        }
        function syncCount() {
            var n = fields.message.value.length;
            el.used.textContent = n.toLocaleString("en-US");
            el.count.classList.toggle("near", n > LIMITS.message * 0.9);
        }
        syncTopic();
        syncCount();

        fields.topic.addEventListener("change", syncTopic);
        ["game", "platform", "topic"].forEach(function (name) {
            fields[name].addEventListener("change", function () {
                if (fields[name].value) clearError(name);
            });
        });
        fields.message.addEventListener("input", syncCount);
        // Clear a field's error as soon as its value passes again.
        ["email", "playerName", "server", "orderId", "device", "message"].forEach(function (name) {
            fields[name].addEventListener("input", function () {
                if (fields[name].getAttribute("aria-invalid") === "true" && !checkField(name)) clearError(name);
            });
        });

        // ---- errors ----
        function errorEl(name) { return document.getElementById(fields[name].id + "-error"); }
        function setError(name, message) {
            var input = fields[name];
            var err = errorEl(name);
            err.textContent = message;
            err.hidden = false;
            input.setAttribute("aria-invalid", "true");
            var ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
            if (ids.indexOf(err.id) < 0) ids.push(err.id);
            input.setAttribute("aria-describedby", ids.join(" "));
        }
        function clearError(name) {
            var input = fields[name];
            var err = errorEl(name);
            err.textContent = "";
            err.hidden = true;
            input.removeAttribute("aria-invalid");
            var ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (id) { return id && id !== err.id; });
            if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
            else input.removeAttribute("aria-describedby");
        }
        function isShown(name) {
            if (name === "orderId") return !el.wrapOrder.hidden;
            if (name === "device") return !el.wrapDevice.hidden;
            return true;
        }

        // Returns the problem with one field in plain language, or "" when it is fine.
        function checkField(name) {
            var input = fields[name];
            var raw = input.value;
            var value = raw.trim();
            if (name === "game" || name === "platform" || name === "topic") {
                if (!Object.prototype.hasOwnProperty.call(CHOICES[name], value)) {
                    return name === "game" ? "Choose a game." : name === "platform" ? "Choose a platform." : "Choose a topic.";
                }
                return "";
            }
            if (name === "email") {
                if (!value) return "Enter your email address so we can reply.";
                if (!isEmail(value) || (input.validity && input.validity.typeMismatch)) return "Enter a valid email address, like name@example.com.";
                return "";
            }
            if (name === "message") {
                if (!value) return "Tell us how we can help.";
                if (MESSAGE_CONTROL_RX.test(value)) return "Remove the unusual hidden characters from your message.";
                if (value.length < MESSAGE_MIN) return "Write at least " + MESSAGE_MIN + " characters.";
                if (value.length > LIMITS.message) return "Keep your message to 5,000 characters or fewer.";
                return "";
            }
            if (!isShown(name)) return "";
            if (CONTROL_RX.test(value)) return "Remove the unusual hidden characters.";
            if (value.length > LIMITS[name]) return "Keep this to " + LIMITS[name] + " characters or fewer.";
            return "";
        }

        function validateAll() {
            var first = null;
            ["game", "platform", "topic", "email", "playerName", "server", "orderId", "device", "message"].forEach(function (name) {
                var problem = checkField(name);
                if (problem) {
                    setError(name, problem);
                    if (!first) first = name;
                } else {
                    clearError(name);
                }
            });
            return first;
        }

        // ---- payload and the email fallback ----
        function payload() {
            var out = {};
            ["game", "platform", "topic", "email", "playerName", "server", "orderId", "device", "message"].forEach(function (name) {
                out[name] = isShown(name) ? fields[name].value.trim() : "";
            });
            out.website = fields.website.value;
            return out;
        }
        function mailtoHref(data) {
            var game = CHOICES.game[data.game] || data.game;
            var topic = CHOICES.topic[data.topic] || data.topic;
            var subject = "Support request: " + game + (topic ? " - " + topic : "");
            var lines = [];
            ["game", "platform", "topic", "playerName", "server", "orderId", "device"].forEach(function (name) {
                var v = data[name];
                if (!v) return;
                if (CHOICES[name] && CHOICES[name][v]) v = CHOICES[name][v];
                lines.push(LABELS[name] + ": " + v);
            });
            lines.push("", data.message.replace(/\r?\n/g, "\r\n"));
            return "mailto:" + SUPPORT_EMAIL + "?subject=" + encodeURIComponent(subject) +
                "&body=" + encodeURIComponent(lines.join("\r\n"));
        }

        // ---- notices ----
        function showNotice(parts) {
            el.notice.textContent = "";
            parts.forEach(function (part) {
                var p = document.createElement("p");
                part.forEach(function (bit) {
                    if (typeof bit === "string") {
                        p.appendChild(document.createTextNode(bit));
                    } else {
                        var a = document.createElement("a");
                        a.href = bit.href;
                        a.textContent = bit.text;
                        p.appendChild(a);
                    }
                });
                el.notice.appendChild(p);
            });
            el.notice.hidden = false;
        }
        function hideNotice() {
            el.notice.hidden = true;
            el.notice.textContent = "";
        }
        function showCouldNotSend(data) {
            showNotice([
                ["We couldn’t send your request. Your details are still here, so you can try again in a moment."],
                ["Or email us instead: ", { href: mailtoHref(data), text: SUPPORT_EMAIL }, " (your details are filled in for you)."]
            ]);
        }
        function showRateLimited(retryAfter) {
            var seconds = parseInt(retryAfter, 10);
            var when = "later";
            if (seconds > 0) {
                var minutes = Math.max(1, Math.ceil(seconds / 60));
                when = minutes === 1 ? "in about a minute" : minutes >= 90
                    ? "in about " + Math.round(minutes / 60) + " hours"
                    : "in about " + minutes + " minutes";
            }
            showNotice([["You’ve sent several requests in a short time. Please try again " + when + ". Your details are still here."]]);
        }

        // ---- sending state ----
        function setSending(on) {
            sending = on;
            el.submit.disabled = on;
            el.spinner.hidden = !on;
            el.submitLabel.textContent = on ? "Sending…" : "Send request";
            form.setAttribute("aria-busy", on ? "true" : "false");
        }

        function showSent(ref, email) {
            el.sentRef.textContent = ref;
            el.sentEmail.textContent = email;
            el.request.hidden = true;
            el.sent.hidden = false;
            el.announce.textContent = "Request sent. Your reference code is " + ref + ". We will reply to " + email + ".";
            el.sentTitle.focus();
        }

        el.another.addEventListener("click", function () {
            // Keep who the player is (game, platform, email, name, server) and clear the request itself.
            fields.topic.value = "";
            fields.orderId.value = "";
            fields.device.value = "";
            fields.message.value = "";
            syncTopic();
            syncCount();
            hideNotice();
            el.announce.textContent = "";
            el.sent.hidden = true;
            el.request.hidden = false;
            fields.topic.focus();
        });

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            if (sending) return;
            hideNotice();
            var first = validateAll();
            if (first) {
                fields[first].focus();
                return;
            }
            var data = payload();
            var body = JSON.stringify(data);
            if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
                setError("message", "Your message is too long to send. Please shorten it.");
                fields.message.focus();
                return;
            }
            send(data, body);
        });

        function send(data, body) {
            setSending(true);
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
            fetch(API + "/api/public/support", {
                method: "POST",
                mode: "cors",
                credentials: "omit",
                headers: { "Content-Type": "text/plain;charset=UTF-8" },
                body: body,
                signal: controller.signal
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (json) {
                    handleResponse(res, json || {}, data);
                });
            }).catch(function () {
                showCouldNotSend(data);
            }).then(function () {
                clearTimeout(timer);
                setSending(false);
                // The disabled button dropped focus; give it back so a keyboard user keeps their place.
                if (!el.request.hidden && (!document.activeElement || document.activeElement === document.body)) el.submit.focus();
            });
        }

        function handleResponse(res, json, data) {
            if (res.status === 201 && json.ok && typeof json.ref === "string") {
                showSent(json.ref, data.email);
                return;
            }
            if (res.status === 400 && json.error === "invalid" && fields[json.field] && json.field !== "website") {
                setError(json.field, json.message || "Check this field.");
                fields[json.field].focus();
                return;
            }
            if (res.status === 413) {
                setError("message", "Your message is too long to send. Please shorten it.");
                fields.message.focus();
                return;
            }
            if (res.status === 429) {
                showRateLimited(res.headers.get("Retry-After"));
                return;
            }
            showCouldNotSend(data);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
