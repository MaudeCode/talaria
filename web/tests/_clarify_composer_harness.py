"""Node harness for the clarify-in-composer flow (HWEB-8 / HWEB-59).

The app ships no bundler and jsdom is not a dependency, so the real functions
are cut out of ``static/messages.js``, ``static/ui.js`` and
``static/sessions.js`` and run against a small element stub covering exactly
what they touch. Tests append a script body that drives the flow and prints one
JSON object.
"""

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MESSAGES_JS = (ROOT / "static" / "messages.js").read_text(encoding="utf-8")
UI_JS = (ROOT / "static" / "ui.js").read_text(encoding="utf-8")
SESSIONS_JS = (ROOT / "static" / "sessions.js").read_text(encoding="utf-8")
NODE = shutil.which("node")


def block(source: str, start_marker: str, end_marker: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


MINI_DOM = r"""
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.classNameValue = '';
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.onclick = null;
    this.placeholder = '';
    this.title = '';
    this.type = '';
    this._html = '';
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
    };
    const el = this;
    this.classList = {
      add(c) { if (!el._classes().includes(c)) el.classNameValue = (el.classNameValue + ' ' + c).trim(); },
      remove(c) { el.classNameValue = el._classes().filter(x => x !== c).join(' '); },
      toggle(c, force) {
        const on = typeof force === 'boolean' ? force : !el._classes().includes(c);
        on ? this.add(c) : this.remove(c);
        return on;
      },
      contains(c) { return el._classes().includes(c); },
    };
  }
  set id(v) { this.attrs.id = String(v); }
  get id() { return this.attrs.id || ''; }
  set className(v) { this.classNameValue = String(v); }
  get className() { return this.classNameValue; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
  }
  set innerHTML(v) { this._html = String(v || ''); if (!v) this.children = []; }
  get innerHTML() { return this.children.length ? '<child>' : this._html; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { document.activeElement = this; }
  select() {}
  getBoundingClientRect() { return {height: 0}; }
  _classes() { return this.classNameValue.split(/\s+/).filter(Boolean); }
  _matches(sel) {
    const attr = sel.match(/^(\.[-\w]+)\[([-\w]+)="([^"]*)"\]$/);
    if (attr) return this._matches(attr[1]) && this.getAttribute(attr[2]) === attr[3];
    if (sel.startsWith('.')) return this._classes().includes(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  _descendants() { return this.children.flatMap(c => [c, ...c._descendants()]); }
  querySelectorAll(selector) {
    const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
    return this._descendants().filter(el => parts.some(p => el._matches(p)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const document = {createElement: (tag) => new El(tag), activeElement: null};
const _els = {};
function $(id) { return _els[id] || null; }
for (const id of ['clarifyCard', 'clarifyCounter', 'clarifyProgress', 'clarifyQuestion',
                  'clarifyChoices', 'clarifyHint', 'clarifyCollapse', 'clarifyCountdown',
                  'msg', 'btnSend', 'composerBox']) {
  _els[id] = new El(id === 'msg' ? 'textarea' : 'div');
  _els[id].id = id;
}
_els.msg.placeholder = 'Message Hermes…';
const window = {addEventListener() {}};
const requestAnimationFrame = (fn) => fn();
const sessionStorage = {setItem() {}};
function t(key, ...args) { return args.length ? key + ':' + args.join('/') : key; }
const S = {session: {session_id: 's1'}, messages: [], pendingFiles: [], busy: true, activeStreamId: 'st1'};
let apiCalls = [];
let apiImpl = async () => ({ok: true});
async function api(path, opts) { apiCalls.push({path, body: JSON.parse(opts.body)}); return apiImpl(); }
const sendCalls = [];
let _sendInProgress = false;
let toasts = [];
function showToast(msg) { toasts.push(String(msg)); }
function setStatus() {}
function setComposerStatus() {}
function renderMessages() {}
function applyLocaleToDOM() {}
function syncTopbar() {}
function autoResize() {}
function assistantDisplayName() { return 'Hermes'; }
function _setPromptFlyoutHidden(card, hidden) { card.hidden = !!hidden; }
function _promptActiveSessionId() { return S.session && S.session.session_id; }
function _renderPendingApprovalForActiveSession() {}
function activeSessionHasPendingPromptAttention() { return false; }
function _saveComposerDraftNow() {}
const draftSaves = [];
function _saveComposerDraft(sid, text, files) { draftSaves.push({sid, text, files: (files || []).length}); }
let _loadingSessionId = null;
function _isComposerDraftRestoreSuppressed() { return false; }
function _clearComposerDraftRestoreSuppression() {}
function _composerDraftHasPayload(text, files) { return !!(String(text || '') || (Array.isArray(files) && files.length)); }
const tick = () => new Promise(r => setTimeout(r, 0));
"""


def run_clarify_harness(body: str) -> dict:
    if not NODE:  # pragma: no cover - environment dependent
        pytest.skip("node not available")
    clarify = block(MESSAGES_JS, "// ── Clarify polling ──", "var _clarifyEventSource = null;")
    composer = block(UI_JS, "let _composerLockState=null;", "function setBusy(v){")
    restore = block(SESSIONS_JS, "function _restoreComposerDraft(", "// Clear the saved draft for a session")
    # The real send() up to its first side effect: the clarify guard must route
    # before the in-flight re-queue branch. Anything past the guard is the chat
    # path, recorded so a test can prove it never ran.
    send_head = block(MESSAGES_JS, "async function send(){", "_sendInProgress = true;")
    send_fn = send_head + "sendCalls.push('chat'); }\n"
    script = MINI_DOM + clarify + "\n" + composer + "\n" + restore + "\n" + send_fn + textwrap.dedent(body)
    proc = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    return json.loads(proc.stdout)
