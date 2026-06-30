/**
 * Smoke: feedback.js UI eligibility, thanks dismiss, and lifecycle.
 * Run: node tests/smoke/__feedback_ui_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HTMLElementStub {}
class HTMLButtonElementStub extends HTMLElementStub {}
class HTMLTextAreaElementStub extends HTMLElementStub {}

function makeStubEl(className) {
  const el = {
    className,
    hidden: false,
    disabled: false,
    value: "",
    rows: 2,
    dataset: {},
    _children: [],
    textContent: "",
    classList: {
      _set: new Set(className ? className.split(/\s+/) : []),
      contains(c) {
        return el.classList._set.has(c);
      },
      add(c) {
        el.classList._set.add(c);
      },
      remove(c) {
        el.classList._set.delete(c);
      },
    },
    appendChild(c) {
      el._children.push(c);
      c._parent = el;
    },
    remove() {
      const parent = el._parent;
      if (parent && Array.isArray(parent._children)) {
        parent._children = parent._children.filter((c) => c !== el);
      }
    },
    querySelector(sel) {
      const walk = (node) => {
        if (!node) return null;
        if (node.matches?.(sel)) return node;
        for (const child of node._children || []) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        if (!node) return;
        if (node.matches?.(sel)) out.push(node);
        for (const child of node._children || []) walk(child);
      };
      walk(el);
      return out;
    },
    matches(sel) {
      const cls = el.className || "";
      if (sel === ".vera-feedback-bar") return cls === "vera-feedback-bar";
      if (sel === ".vera-feedback-btn--up") return cls.includes("vera-feedback-btn--up");
      if (sel === ".vera-feedback-btn--down") return cls.includes("vera-feedback-btn--down");
      if (sel === ".vera-feedback-note-wrap") return cls === "vera-feedback-note-wrap";
      if (sel === ".vera-feedback-note") return cls === "vera-feedback-note";
      if (sel === ".vera-feedback-note-submit") return cls === "vera-feedback-note-submit";
      if (sel === ".vera-feedback-controls") return cls === "vera-feedback-controls";
      if (sel === ".vera-feedback-thanks") return cls === "vera-feedback-thanks";
      if (sel === ".bubble.vera") return cls === "bubble vera";
      return false;
    },
    addEventListener(type, fn) {
      el._listeners = el._listeners || {};
      el._listeners[type] = fn;
    },
    focus() {},
    setAttribute() {},
    removeAttribute() {},
    get isConnected() {
      const parent = el._parent;
      return Boolean(parent && (parent._children || []).includes(el));
    },
    closest(sel) {
      if (sel === ".message-row.vera" && el._role === "row") return el;
      if (el._parent && typeof el._parent.closest === "function") {
        return el._parent.closest(sel);
      }
      return null;
    },
  };
  Object.setPrototypeOf(el, HTMLElementStub.prototype);
  return el;
}

function makeDom() {
  const convo = makeStubEl("");
  convo.id = "vera-conversation";
  convo._children = [];
  convo.contains = function (node) {
    let cur = node;
    while (cur) {
      if (cur === convo) return true;
      cur = cur._parent;
    }
    return false;
  };
  convo.appendChild = function (child) {
    convo._children.push(child);
    child._parent = convo;
  };
  convo.querySelectorAll = function (sel) {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.matches?.(sel)) out.push(node);
      for (const child of node._children || []) walk(child);
    };
    for (const row of convo._children) walk(row);
    return out;
  };
  return {
    convo,
    document: {
      getElementById(id) {
        if (id === "vera-conversation") return convo;
        return null;
      },
      createElement(tag) {
        if (tag === "div") return makeStubEl("");
        if (tag === "span") return makeStubEl("vera-feedback-thanks");
        if (tag === "button") {
          const b = makeStubEl("vera-feedback-btn");
          b._tag = "button";
          Object.setPrototypeOf(b, HTMLButtonElementStub.prototype);
          return b;
        }
        if (tag === "textarea") {
          const t = makeStubEl("vera-feedback-note");
          t._tag = "textarea";
          Object.setPrototypeOf(t, HTMLTextAreaElementStub.prototype);
          return t;
        }
        return makeStubEl("");
      },
    },
  };
}

function makeVeraRow(dom, { pending = false, stage1 = false } = {}) {
  const row = makeStubEl("message-row vera");
  row._role = "row";
  dom.convo.appendChild(row);

  const bubble = makeStubEl("bubble vera");
  bubble.textContent = "Assistant reply text.";
  if (pending) bubble.classList._set.add("vera-pending-status");
  if (stage1) bubble.classList._set.add("vera-work-mode-stage1-ack");
  row.appendChild(bubble);

  row.querySelector = function (sel) {
    for (const child of row._children) {
      if (child.matches?.(sel)) return child;
      const nested = child.querySelector?.(sel);
      if (nested) return nested;
    }
    return null;
  };
  row.querySelectorAll = function (sel) {
    const out = [];
    for (const child of row._children) {
      if (child.matches?.(sel)) out.push(child);
      out.push(...(child.querySelectorAll?.(sel) || []));
    }
    return out;
  };

  return { row, bubble };
}

function makeSandbox(dom, { authenticated = true, thanksDismissMs = null } = {}) {
  const sandbox = {
    window: {},
    document: dom.document,
    HTMLElement: HTMLElementStub,
    HTMLButtonElement: HTMLButtonElementStub,
    HTMLTextAreaElement: HTMLTextAreaElementStub,
    HTMLInputElement: HTMLTextAreaElementStub,
    setTimeout,
    clearTimeout,
    getSessionId: () => "sess-ui-test",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    authFetch: async () => {
      sandbox._fetchCalls = (sandbox._fetchCalls || 0) + 1;
      return { ok: true, json: async () => ({ ok: true, id: "fb-1" }) };
    },
    isSupabaseUserAuthenticated: () => authenticated,
    console,
    _fetchCalls: 0,
  };
  if (thanksDismissMs != null) {
    sandbox.veraFeedbackThanksDismissMs = thanksDismissMs;
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const feedbackSrc = readFileSync(path.join(root, "users/feedback.js"), "utf8");
  vm.runInContext(feedbackSrc, sandbox);
  return sandbox;
}

async function main() {
  section("initial state — thumbs only");
  const dom = makeDom();
  const sandbox = makeSandbox(dom);
  const finalRow = makeVeraRow(dom);
  sandbox.veraFeedbackSetPendingUser("What is the weather?");
  sandbox.veraFeedbackMarkFinal(finalRow.bubble, { requestId: "req_1", turnId: "wm-1" });
  const bar = finalRow.row.querySelector(".vera-feedback-bar");
  const noteWrap = finalRow.row.querySelector(".vera-feedback-note-wrap");
  ok(bar != null, "feedback bar attached to final Vera bubble");
  ok(bar?.hidden === false, "feedback bar visible when authenticated");
  ok(noteWrap != null && noteWrap.hidden === true, "note field hidden initially");
  ok(
    !noteWrap?.classList.contains("is-open"),
    "note editor not open before thumbs down"
  );

  section("thumbs up — thanks then dismiss");
  const domUp = makeDom();
  const sandboxUp = makeSandbox(domUp, { thanksDismissMs: 0 });
  const upRow = makeVeraRow(domUp);
  sandboxUp.veraFeedbackMarkFinal(upRow.bubble, { requestId: "req_up" });
  upRow.row.querySelector(".vera-feedback-btn--up")?._listeners?.click?.();
  ok(upRow.row.dataset.feedbackSubmitted === "1", "thumbs up marks row submitted");
  ok(sandboxUp._fetchCalls === 1, "thumbs up submits immediately");
  const thanksUp = upRow.row.querySelector(".vera-feedback-thanks");
  ok(thanksUp?.hidden === false, "thanks shown after thumbs up");
  await sleep(400);
  ok(upRow.row.querySelector(".vera-feedback-bar") == null, "bar removed after thanks dismiss");

  section("thumbs down — textarea, thanks, dismiss");
  const dom2 = makeDom();
  const sandbox2 = makeSandbox(dom2, { thanksDismissMs: 0 });
  const row2 = makeVeraRow(dom2);
  sandbox2.veraFeedbackMarkFinal(row2.bubble, { requestId: "req_2" });
  const noteInput = row2.row.querySelector(".vera-feedback-note");
  ok(noteInput?._tag === "textarea", "note field is a textarea");
  ok((noteInput?.rows || 0) >= 2, "note textarea has at least 2 rows");
  row2.row.querySelector(".vera-feedback-btn--down")?._listeners?.click?.();
  const noteWrap2 = row2.row.querySelector(".vera-feedback-note-wrap");
  ok(noteWrap2?.classList.contains("is-open"), "thumbs down opens note editor");
  row2.row.querySelector(".vera-feedback-note-submit")?._listeners?.click?.();
  ok(row2.row.dataset.feedbackSubmitted === "1", "thumbs down send submits");
  ok(sandbox2._fetchCalls === 1, "thumbs down submit fires once");
  ok(row2.row.querySelector(".vera-feedback-thanks")?.hidden === false, "thanks shown after thumbs down");
  await sleep(400);
  ok(row2.row.querySelector(".vera-feedback-bar") == null, "bar removed after thumbs down thanks");

  section("enter submits note");
  const domEnter = makeDom();
  const sandboxEnter = makeSandbox(domEnter, { thanksDismissMs: 1000 });
  const rowEnter = makeVeraRow(domEnter);
  sandboxEnter.veraFeedbackMarkFinal(rowEnter.bubble, { requestId: "req_enter" });
  rowEnter.row.querySelector(".vera-feedback-btn--down")?._listeners?.click?.();
  const inputEnter = rowEnter.row.querySelector(".vera-feedback-note");
  inputEnter.value = "bad answer";
  inputEnter._listeners?.keydown?.({ key: "Enter", shiftKey: false, preventDefault() {} });
  ok(rowEnter.row.dataset.feedbackSubmitted === "1", "Enter submits thumbs down note");

  section("escape closes note");
  const domEsc = makeDom();
  const sandboxEsc = makeSandbox(domEsc);
  const rowEsc = makeVeraRow(domEsc);
  sandboxEsc.veraFeedbackMarkFinal(rowEsc.bubble, { requestId: "req_esc" });
  rowEsc.row.querySelector(".vera-feedback-btn--down")?._listeners?.click?.();
  rowEsc.row.querySelector(".vera-feedback-note")?._listeners?.keydown?.({
    key: "Escape",
    preventDefault() {},
  });
  const wrapEsc = rowEsc.row.querySelector(".vera-feedback-note-wrap");
  ok(!wrapEsc?.classList.contains("is-open"), "Escape closes note editor");
  ok(rowEsc.row.dataset.feedbackSubmitted !== "1", "Escape does not submit");

  section("thumbs up while note open submits up");
  const domMix = makeDom();
  const sandboxMix = makeSandbox(domMix, { thanksDismissMs: 1000 });
  const rowMix = makeVeraRow(domMix);
  sandboxMix.veraFeedbackMarkFinal(rowMix.bubble, { requestId: "req_mix" });
  rowMix.row.querySelector(".vera-feedback-btn--down")?._listeners?.click?.();
  rowMix.row.querySelector(".vera-feedback-btn--up")?._listeners?.click?.();
  ok(rowMix.row.dataset.feedbackSubmitted === "1", "thumbs up while note open submits");
  ok(sandboxMix._fetchCalls === 1, "single up submit when overriding open note");

  section("new user message clears old controls");
  const dom3 = makeDom();
  const sandbox3 = makeSandbox(dom3);
  const oldReply = makeVeraRow(dom3);
  sandbox3.veraFeedbackMarkFinal(oldReply.bubble, { requestId: "req_old" });
  ok(dom3.convo.querySelectorAll(".vera-feedback-bar").length === 1, "one bar before new user msg");
  sandbox3.veraFeedbackOnNewUserMessage();
  ok(dom3.convo.querySelectorAll(".vera-feedback-bar").length === 0, "bars removed on new user message");
  const newReply = makeVeraRow(dom3);
  sandbox3.veraFeedbackSetPendingUser("Follow-up question");
  sandbox3.veraFeedbackMarkFinal(newReply.bubble, { requestId: "req_new" });
  ok(dom3.convo.querySelectorAll(".vera-feedback-bar").length === 1, "only latest reply has feedback bar");

  section("logged-out controls visible");
  const dom4 = makeDom();
  const sandbox4 = makeSandbox(dom4, { authenticated: false, thanksDismissMs: 0 });
  const loggedOutRow = makeVeraRow(dom4);
  sandbox4.veraFeedbackMarkFinal(loggedOutRow.bubble, { requestId: "req_3" });
  const loggedOutBar = loggedOutRow.row.querySelector(".vera-feedback-bar");
  ok(loggedOutBar != null, "logged-out: feedback bar shown");
  ok(loggedOutBar?.hidden === false, "logged-out: bar visible");
  loggedOutRow.row.querySelector(".vera-feedback-btn--up")?._listeners?.click?.();
  ok(loggedOutRow.row.dataset.feedbackSubmitted === "1", "logged-out thumbs up submits");
  ok(sandbox4._fetchCalls === 1, "logged-out thumbs up fires fetch");
  ok(
    loggedOutRow.row.querySelector(".vera-feedback-thanks")?.hidden === false,
    "logged-out thumbs up shows Thanks"
  );
  await sleep(400);
  ok(loggedOutRow.row.querySelector(".vera-feedback-bar") == null, "logged-out bar dismisses after thanks");

  section("logged-out thumbs down with note");
  const domDown = makeDom();
  const sandboxDown = makeSandbox(domDown, { authenticated: false, thanksDismissMs: 0 });
  const downRow = makeVeraRow(domDown);
  sandboxDown.veraFeedbackMarkFinal(downRow.bubble, { requestId: "req_3b" });
  downRow.row.querySelector(".vera-feedback-btn--down")?._listeners?.click?.();
  const downNote = downRow.row.querySelector(".vera-feedback-note");
  downNote.value = "not helpful";
  downRow.row.querySelector(".vera-feedback-note-submit")?._listeners?.click?.();
  ok(downRow.row.dataset.feedbackSubmitted === "1", "logged-out thumbs down submits");
  ok(sandboxDown._fetchCalls === 1, "logged-out thumbs down fires fetch");
  ok(
    downRow.row.querySelector(".vera-feedback-thanks")?.hidden === false,
    "logged-out thumbs down shows Thanks"
  );
  await sleep(400);
  ok(downRow.row.querySelector(".vera-feedback-bar") == null, "logged-out down bar dismisses after thanks");

  section("pending bubble ineligible");
  const dom5 = makeDom();
  const sandbox5 = makeSandbox(dom5);
  const pendingRow = makeVeraRow(dom5, { pending: true });
  sandbox5.veraFeedbackMarkFinal(pendingRow.bubble, { requestId: "req_4" });
  ok(pendingRow.row.querySelector(".vera-feedback-bar") == null, "no bar on pending bubble");

  section("summary");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

await main();
