"""Regression tests for #3691: provider-agnostic model-picker overflow groups."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import types
import urllib.request
from pathlib import Path

import pytest

import api.config as config


REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


class _FakeResponse:
    def __init__(self, payload: dict):
        self._buf = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self) -> bytes:
        return self._buf


@pytest.fixture(autouse=True)
def _clear_models_cache():
    try:
        config.invalidate_models_cache()
    except Exception:
        pass
    yield
    try:
        config.invalidate_models_cache()
    except Exception:
        pass


def _openrouter_group() -> dict:
    return next(g for g in config.get_available_models()["groups"] if g["provider_id"] == "openrouter")


def test_openrouter_overflow_preserves_hidden_tail(monkeypatch):
    monkeypatch.setattr(
        config,
        "cfg",
        {
            "model": {"provider": "openrouter", "default": "anthropic/claude-sonnet-4.6"},
            "providers": {"openrouter": {"api_key": "sk-or-test-key"}},
        },
        raising=False,
    )
    fake_pkg = types.ModuleType("hermes_cli")
    fake_pkg.__path__ = []
    fake_models = types.ModuleType("hermes_cli.models")
    fake_models.fetch_openrouter_models = lambda: [
        ("anthropic/claude-sonnet-4.6", ""),
        ("openai/gpt-4o", ""),
    ]
    monkeypatch.setitem(sys.modules, "hermes_cli", fake_pkg)
    monkeypatch.setitem(sys.modules, "hermes_cli.models", fake_models)

    payload = {
        "data": [
            {
                "id": f"vendor{i}/overflow-{i}:free",
                "name": f"Overflow {i}",
                "supported_parameters": [],
                "pricing": {"prompt": "0", "completion": "0"},
            }
            for i in range(40)
        ]
    }
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(payload))

    group = _openrouter_group()
    total = len(group["models"]) + len(group.get("extra_models", []))
    capped_total = 2 + config._OPENROUTER_FREE_TIER_AUGMENT_CAP

    assert len(group["models"]) == config._MODEL_PICKER_VISIBLE_TARGET
    assert total == capped_total, "OpenRouter overflow models must move into extra_models within the capped augmentation budget."
    assert any(m["id"] == "vendor29/overflow-29:free" for m in group.get("extra_models", [])), (
        "The last capped free-tier model should land in extra_models once the visible picker cap is reached."
    )
    assert all(m["id"] != "vendor30/overflow-30:free" for bucket in ("models", "extra_models") for m in group.get(bucket, [])), (
        "Free-tier augmentation must stop at the configured cap instead of continuing through the whole live payload."
    )


def test_deduplicate_model_ids_includes_extra_models():
    groups = [
        {
            "provider": "Alpha",
            "provider_id": "alpha",
            "models": [{"id": "shared/model", "label": "Shared Model"}],
            "extra_models": [{"id": "alpha/only-extra", "label": "Alpha Extra"}],
        },
        {
            "provider": "Beta",
            "provider_id": "beta",
            "models": [{"id": "beta/visible", "label": "Beta Visible"}],
            "extra_models": [{"id": "shared/model", "label": "Shared Model"}],
        },
    ]

    config._deduplicate_model_ids(groups)

    assert groups[0]["models"][0]["id"] == "shared/model"
    assert groups[1]["extra_models"][0]["id"] == "@beta:shared/model"
    assert groups[1]["extra_models"][0]["label"] == "Shared Model (Beta)"


def test_openrouter_free_tier_selection_stays_visible_when_selected_id_is_bare():
    ordered = [
        {"id": f"@openrouter:vendor/model-{idx}", "label": f"Model {idx}"}
        for idx in range(config._MODEL_PICKER_VISIBLE_TARGET)
    ]
    ordered.append({"id": "@openrouter:vendor/selected-model:free", "label": "Selected Free"})

    visible, extra = config._split_picker_overflow_models(
        ordered,
        selected_model_id="vendor/selected-model:free",
        provider_id="openrouter",
        threshold=config._MODEL_PICKER_OVERFLOW_THRESHOLD,
        target=config._MODEL_PICKER_VISIBLE_TARGET,
    )

    assert any(m["id"] == "@openrouter:vendor/selected-model:free" for m in visible), (
        "A bare OpenRouter :free selection must stay visible when the selected model is in overflow."
    )
    assert all(m["id"] != "@openrouter:vendor/selected-model:free" for m in extra)


_DROPDOWN_DRIVER = r"""
const fs = require('fs');
const ui = fs.readFileSync(process.argv[2], 'utf8');

function extractFunc(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let openParen = ui.indexOf('(', start);
  let i = openParen + 1;
  let parenDepth = 1;
  while (parenDepth > 0 && i < ui.length) {
    if (ui[i] === '(') parenDepth++;
    else if (ui[i] === ')') parenDepth--;
    i++;
  }
  i = ui.indexOf('{', i);
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  return ui.slice(start, i);
}

function extractConst(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found as const');
  const eqIdx = ui.indexOf('=', start + name.length);
  let i = ui.indexOf('{', eqIdx);
  if (i < 0) throw new Error(name + ' arrow body not found');
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  if (ui[i] === ';') i++;
  return ui.slice(start, i);
}

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    _set: set,
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    contains(cls) { return set.has(cls); },
    toggle(cls, force) {
      if (force === true) { set.add(cls); return true; }
      if (force === false) { set.delete(cls); return false; }
      if (set.has(cls)) { set.delete(cls); return false; }
      set.add(cls);
      return true;
    },
  };
}

function defineClassName(node) {
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList = makeClassList(String(v || '').split(/\s+/).filter(Boolean)); },
  });
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    parentElement: null,
    textContent: '',
    value: '',
    tabIndex: 0,
    onclick: null,
    _listeners: {},
    _innerHTML: '',
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'OPTGROUP' && this._ownerSelect && child.tagName === 'OPTION') {
        this._ownerSelect.options.push(child);
      }
      return child;
    },
    addEventListener(type, handler) { this._listeners[type] = handler; },
    querySelector(selector) { return this._qs ? this._qs[selector] || null : null; },
    setAttribute(name, value) { this[name] = value; },
    focus() { this._focused = true; },
  };
  node.classList = makeClassList();
  defineClassName(node);
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      this._innerHTML = String(v || '');
      this.children = [];
      this._qs = {};
      if (this.tagName === 'DIV' && this._innerHTML.includes('model-search-input')) {
        const input = makeNode('input');
        input.className = 'model-search-input';
        const clear = makeNode('button');
        clear.className = 'model-search-clear';
        this._qs['.model-search-input'] = input;
        this._qs['.model-search-clear'] = clear;
      } else if (this.tagName === 'DIV' && this._innerHTML.includes('model-custom-input')) {
        const input = makeNode('input');
        input.className = 'model-custom-input';
        const btn = makeNode('button');
        btn.className = 'model-custom-btn';
        this._qs['.model-custom-input'] = input;
        this._qs['.model-custom-btn'] = btn;
      }
    },
  });
  return node;
}

function makeOption(value, label, parent) {
  const opt = makeNode('option');
  opt.value = value;
  opt.textContent = label || value;
  opt.parentElement = parent || null;
  return opt;
}

function makeSelect(groups, selectedValue) {
  const sel = { id: 'modelSelect', children: [], options: [], value: selectedValue || '' };
  for (const group of groups || []) {
    const og = makeNode('optgroup');
    og.label = group.provider || '';
    og.dataset.provider = group.provider_id || '';
    og._ownerSelect = sel;
    if (group.extra_models) og.dataset.extraModels = JSON.stringify(group.extra_models);
    for (const model of group.models || []) {
      og.appendChild(makeOption(model.id, model.label || model.id, og));
    }
    sel.children.push(og);
    sel.options.push(...og.children);
  }
  return sel;
}

function snapshot(dd) {
  // Recurse into collapsible group bodies (#4279): rows + the show-all expander
  // now live inside `.model-group-body` wrappers rather than as direct children
  // of the dropdown, so a flat children map would miss them.
  const out = [];
  const walk = (node) => {
    for (const child of (node.children || [])) {
      out.push({
        className: child.className,
        textContent: child.textContent,
        html: child._innerHTML || '',
      });
      if (child.children && child.children.length) walk(child);
    }
  };
  walk(dd);
  return out;
}

// Find a node anywhere in the dropdown subtree whose innerHTML matches.
function findInTree(dd, pred) {
  const stack = [...(dd.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (pred(n)) return n;
    if (n.children && n.children.length) stack.push(...n.children);
  }
  return null;
}

const payload = JSON.parse(process.argv[3]);
const dropdown = makeNode('div');
dropdown.classList.add('open');
const modelSelect = makeSelect(payload.groups, payload.selectedValue || payload.groups[0].models[0].id);

function $(id) {
  if (id === 'composerModelDropdown') return dropdown;
  if (id === 'modelSelect') return modelSelect;
  return null;
}
const window = { _configuredModelBadges: payload.configuredBadges || {} };
const document = { createElement(tag) { return makeNode(tag); } };
function esc(v) { return String(v || ''); }
function t(key, ...args) {
  if (key === 'model_show_all_models') return `Show all ${args[0]} models`;
  return key;
}
function li() { return 'x'; }
function getModelLabel(v) { return String(v || ''); }
function _providerFromModelValue(v) {
  const value = String(v || '');
  if (value.startsWith('@') && value.includes(':')) return value.slice(1, value.lastIndexOf(':'));
  return '';
}
function _normalizeConfiguredModelKey(v) { return String(v || '').toLowerCase(); }
function _getConfiguredModelBadge(value, badgeMap) { return badgeMap[value] || null; }
function closeModelDropdown() {}
function selectModelFromDropdown() {}

for (const name of [
  '_readModelOverflowData',
  '_appendOverflowOptionsToGroup',
  '_isEquivalentConfiguredModelEntry',
  'renderModelDropdown',
]) {
  eval(extractFunc(name));
}

renderModelDropdown();
const initial = snapshot(dropdown);
// The show-all expander now lives inside a `.model-group-body` wrapper (#4279),
// so search the whole subtree rather than only direct children.
const initialShowAllRow = findInTree(dropdown, node => String(node._innerHTML || '').includes('Show all'));
const searchInput = dropdown.children[1].querySelector('.model-search-input');
searchInput.value = payload.searchTerm;
searchInput._listeners.input();
const searched = snapshot(dropdown);
initialShowAllRow.onclick({ stopPropagation() {} });
const searchInputAfterExpand = dropdown.children[1].querySelector('.model-search-input');
searchInputAfterExpand.value = '';
searchInputAfterExpand._listeners.input();
const expanded = snapshot(dropdown);

process.stdout.write(JSON.stringify({
  initial,
  searched,
  expanded,
  optionCountAfterExpand: modelSelect.children[0].children.length,
  hiddenDatasetAfterExpand: modelSelect.children[0].dataset.extraModels || '',
}));
"""

_INPLACE_DRIVER = r"""
const fs = require('fs');
const ui = fs.readFileSync(process.argv[2], 'utf8');

function extractFunc(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let openParen = ui.indexOf('(', start);
  let i = openParen + 1;
  let parenDepth = 1;
  while (parenDepth > 0 && i < ui.length) {
    if (ui[i] === '(') parenDepth++;
    else if (ui[i] === ')') parenDepth--;
    i++;
  }
  i = ui.indexOf('{', i);
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  return ui.slice(start, i);
}

function extractConst(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found as const');
  const eqIdx = ui.indexOf('=', start + name.length);
  let i = ui.indexOf('{', eqIdx);
  if (i < 0) throw new Error(name + ' arrow body not found');
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  if (ui[i] === ';') i++;
  return ui.slice(start, i);
}

// Extended DOM globals to enable in-place expansion path
const CSS = { escape: s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
const requestAnimationFrame = fn => { fn(); return 0; };

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    _set: set,
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    contains(cls) { return set.has(cls); },
    toggle(cls, force) {
      if (force === true) { set.add(cls); return true; }
      if (force === false) { set.delete(cls); return false; }
      if (set.has(cls)) { set.delete(cls); return false; }
      set.add(cls);
      return true;
    },
  };
}

function defineClassName(node) {
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList = makeClassList(String(v || '').split(/\s+/).filter(Boolean)); },
  });
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    parentElement: null,
    textContent: '',
    value: '',
    tabIndex: 0,
    onclick: null,
    _listeners: {},
    _innerHTML: '',
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'OPTGROUP' && this._ownerSelect && child.tagName === 'OPTION') {
        this._ownerSelect.options.push(child);
      }
      return child;
    },
    insertBefore(newChild, refChild) {
      newChild.parentElement = this;
      const idx = refChild ? this.children.indexOf(refChild) : -1;
      if (idx >= 0) {
        this.children.splice(idx, 0, newChild);
      } else {
        this.children.push(newChild);
      }
      return newChild;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
      }
    },
    addEventListener(type, handler) { this._listeners[type] = handler; },
    querySelector(selector) {
      // Try the _qs cache first
      if (this._qs && this._qs[selector]) return this._qs[selector];
      // Handle attribute selectors and descendant selectors
      return querySelectorAllImpl(this, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return querySelectorAllImpl(this, selector);
    },
    setAttribute(name, value) { this[name] = value; },
    focus() { this._focused = true; },
  };
  Object.defineProperty(node, 'offsetTop', {
    value: 0,
  });
  Object.defineProperty(node, 'scrollTop', {
    get() { return this._scrollTop || 0; },
    set(v) { this._scrollTop = v; },
  });
  Object.defineProperty(node, 'previousElementSibling', {
    get() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    },
  });
  node.classList = makeClassList();
  defineClassName(node);
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      this._innerHTML = String(v || '');
      this.children = [];
      this._qs = {};
      if (this.tagName === 'DIV' && this._innerHTML.includes('model-search-input')) {
        const input = makeNode('input');
        input.className = 'model-search-input';
        const clear = makeNode('button');
        clear.className = 'model-search-clear';
        this._qs['.model-search-input'] = input;
        this._qs['.model-search-clear'] = clear;
      } else if (this.tagName === 'DIV' && this._innerHTML.includes('model-custom-input')) {
        const input = makeNode('input');
        input.className = 'model-custom-input';
        const btn = makeNode('button');
        btn.className = 'model-custom-btn';
        this._qs['.model-custom-input'] = input;
        this._qs['.model-custom-btn'] = btn;
      }
    },
  });
  return node;
}

function querySelectorAllImpl(node, selector) {
  const results = [];
  const stack = [node];

  while (stack.length) {
    const n = stack.shift();
    if (n.children && n.children.length) {
      stack.push(...n.children);
    }

    // Simple class selector: .foo
    if (selector.startsWith('.') && !selector.includes('[') && !selector.includes(' ')) {
      const className = selector.slice(1);
      if (n.className && n.className.includes(className)) {
        results.push(n);
      }
    }
    // Attribute selector: .foo[data-bar="baz"]
    else if (selector.includes('[') && !selector.includes(' ')) {
      const match = selector.match(/^\.([^\[]+)\[data-([^\]=]+)="([^\]]+)"\]$/);
      if (match) {
        const [, className, dataKey, dataVal] = match;
        if (n.className && n.className.includes(className) &&
            n.dataset && n.dataset[dataKey] === dataVal) {
          results.push(n);
        }
      }
    }
    // Descendant selector: .foo .bar
    else if (selector.includes(' ')) {
      const parts = selector.split(' ').filter(Boolean);
      if (parts.length === 2) {
        const [parentSel, childSel] = parts;
        // Find all ancestors matching parentSel
        let parent = n.parentElement;
        let hasParent = false;
        while (parent) {
          if (isMatch(parent, parentSel)) {
            hasParent = true;
            break;
          }
          parent = parent.parentElement;
        }
        // If we found a matching ancestor, check if this node matches childSel
        if (hasParent && isMatch(n, childSel)) {
          results.push(n);
        }
      }
    }
  }

  return results;
}

function isMatch(node, selector) {
  // Simple class selector: .foo
  if (selector.startsWith('.') && !selector.includes('[')) {
    const className = selector.slice(1);
    return node.className && node.className.includes(className);
  }
  // Attribute selector: .foo[data-bar="baz"]
  if (selector.includes('[')) {
    const match = selector.match(/^\.([^\[]+)\[data-([^\]=]+)="([^\]]+)"\]$/);
    if (match) {
      const [, className, dataKey, dataVal] = match;
      return node.className && node.className.includes(className) &&
             node.dataset && node.dataset[dataKey] === dataVal;
    }
  }
  return false;
}

function makeOption(value, label, parent) {
  const opt = makeNode('option');
  opt.value = value;
  opt.textContent = label || value;
  opt.parentElement = parent || null;
  return opt;
}

function makeSelect(groups, selectedValue) {
  const sel = { id: 'modelSelect', children: [], options: [], value: selectedValue || '' };
  for (const group of groups || []) {
    const og = makeNode('optgroup');
    og.label = group.provider || '';
    og.dataset.provider = group.provider_id || '';
    og._ownerSelect = sel;
    if (group.extra_models) og.dataset.extraModels = JSON.stringify(group.extra_models);
    for (const model of group.models || []) {
      og.appendChild(makeOption(model.id, model.label || model.id, og));
    }
    sel.children.push(og);
    sel.options.push(...og.children);
  }
  return sel;
}

function snapshot(dd) {
  const out = [];
  const walk = (node) => {
    for (const child of (node.children || [])) {
      out.push({
        className: child.className,
        textContent: child.textContent,
        html: child._innerHTML || '',
      });
      if (child.children && child.children.length) walk(child);
    }
  };
  walk(dd);
  return out;
}

function findInTree(dd, pred) {
  const stack = [...(dd.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (pred(n)) return n;
    if (n.children && n.children.length) stack.push(...n.children);
  }
  return null;
}

const payload = JSON.parse(process.argv[3]);
const dropdown = makeNode('div');
dropdown.classList.add('open');
const modelSelect = makeSelect(payload.groups, payload.selectedValue || payload.groups[0].models[0].id);

function $(id) {
  if (id === 'composerModelDropdown') return dropdown;
  if (id === 'modelSelect') return modelSelect;
  return null;
}
const window = { _configuredModelBadges: payload.configuredBadges || {} };
const document = { createElement(tag) { return makeNode(tag); } };
function esc(v) { return String(v || ''); }
function t(key, ...args) {
  if (key === 'model_show_all_models') return `Show all ${args[0]} models`;
  return key;
}
function li() { return 'x'; }
function getModelLabel(v) { return String(v || ''); }
function _providerFromModelValue(v) {
  const value = String(v || '');
  if (value.startsWith('@') && value.includes(':')) return value.slice(1, value.lastIndexOf(':'));
  return '';
}
function _normalizeConfiguredModelKey(v) { return String(v || '').toLowerCase(); }
function _getConfiguredModelBadge(value, badgeMap) { return badgeMap[value] || null; }
function closeModelDropdown() {}
function selectModelFromDropdown() {}

for (const name of [
  '_readModelOverflowData',
  '_appendOverflowOptionsToGroup',
  '_isEquivalentConfiguredModelEntry',
  'renderModelDropdown',
]) {
  eval(extractFunc(name));
}

eval(extractConst('_expandOverflowGroup'));

renderModelDropdown();
const initial = snapshot(dropdown);
const initialShowAllRow = findInTree(dropdown, node => String(node._innerHTML || '').includes('Show all'));
// Click show-all FIRST (before any search) so the in-place path runs on a
// fresh DOM with .model-opt-more still present. Searching first would trigger
// a full re-render that removes .model-opt-more, making the stale onclick
// reference fall into the full-rerender fallback instead of in-place.
initialShowAllRow.onclick({ stopPropagation() {} });
const expanded = snapshot(dropdown);
// Now type a search, then clear it, to verify the hiddenByDefault sync
// keeps the group fully expanded through the search→clear cycle.
const searchInput = dropdown.children[1].querySelector('.model-search-input');
searchInput.value = payload.searchTerm;
searchInput._listeners.input();
const searched = snapshot(dropdown);
searchInput.value = '';
searchInput._listeners.input();
const cleared = snapshot(dropdown);

// After clearing, measure the rendered group body — not the hidden <select>.
// _appendOverflowOptionsToGroup appends to the <select> unconditionally, so
// counting <option> elements there is always 4 whether or not the
// hiddenByDefault/hiddenCount sync is present. The regression the fix prevents
// is the rendered dropdown snapping back to the capped view + a fresh "Show all"
// expander, so we must check the live DOM rows inside the .model-group-body.
const groupWrapper = querySelectorAllImpl(dropdown, '.model-group-body[data-group="openrouter"]')[0] || null;
const clearedRenderedModelCount = groupWrapper ? querySelectorAllImpl(groupWrapper, '.model-opt').length : -1;
const clearedHasMoreButton = groupWrapper ? querySelectorAllImpl(groupWrapper, '.model-opt-more').length > 0 : false;

process.stdout.write(JSON.stringify({
  inPlacePath: true,
  initialShowAll: initial.some(item => String(item.html || '').includes('Show all')),
  expandedHasShowAll: expanded.some(item => String(item.html || '').includes('Show all')),
  clearedHasShowAll: cleared.some(item => String(item.html || '').includes('Show all')),
  clearedRenderedModelCount,
  clearedHasMoreButton,
}));
"""

_INPLACE_ENDPOINT_ERROR_DRIVER = r"""
const fs = require('fs');
const ui = fs.readFileSync(process.argv[2], 'utf8');

function extractFunc(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let openParen = ui.indexOf('(', start);
  let i = openParen + 1;
  let parenDepth = 1;
  while (parenDepth > 0 && i < ui.length) {
    if (ui[i] === '(') parenDepth++;
    else if (ui[i] === ')') parenDepth--;
    i++;
  }
  i = ui.indexOf('{', i);
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  return ui.slice(start, i);
}

const CSS = { escape: s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
const requestAnimationFrame = fn => { fn(); return 0; };

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    _set: set,
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    contains(cls) { return set.has(cls); },
    toggle(cls, force) {
      if (force === true) { set.add(cls); return true; }
      if (force === false) { set.delete(cls); return false; }
      if (set.has(cls)) { set.delete(cls); return false; }
      set.add(cls);
      return true;
    },
  };
}

function defineClassName(node) {
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList = makeClassList(String(v || '').split(/\s+/).filter(Boolean)); },
  });
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    parentElement: null,
    textContent: '',
    value: '',
    tabIndex: 0,
    onclick: null,
    _listeners: {},
    _innerHTML: '',
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'OPTGROUP' && this._ownerSelect && child.tagName === 'OPTION') {
        this._ownerSelect.options.push(child);
      }
      return child;
    },
    addEventListener(type, handler) { this._listeners[type] = handler; },
    querySelector(selector) { return this._qs ? this._qs[selector] || null : null; },
    setAttribute(name, value) { this[name] = value; },
    focus() { this._focused = true; },
  };
  node.classList = makeClassList();
  defineClassName(node);
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      this._innerHTML = String(v || '');
      this.children = [];
      this._qs = {};
      if (this.tagName === 'DIV' && this._innerHTML.includes('model-search-input')) {
        const input = makeNode('input');
        input.className = 'model-search-input';
        const clear = makeNode('button');
        clear.className = 'model-search-clear';
        this._qs['.model-search-input'] = input;
        this._qs['.model-search-clear'] = clear;
      } else if (this.tagName === 'DIV' && this._innerHTML.includes('model-custom-input')) {
        const input = makeNode('input');
        input.className = 'model-custom-input';
        const btn = makeNode('button');
        btn.className = 'model-custom-btn';
        this._qs['.model-custom-input'] = input;
        this._qs['.model-custom-btn'] = btn;
      }
    },
  });
  return node;
}

function makeOption(value, label, parent) {
  const opt = makeNode('option');
  opt.value = value;
  opt.textContent = label || value;
  opt.parentElement = parent || null;
  return opt;
}

function makeSelect(groups, selectedValue) {
  const sel = { id: 'modelSelect', children: [], options: [], value: selectedValue || '' };
  for (const group of groups || []) {
    const og = makeNode('optgroup');
    og.label = group.provider || '';
    og.dataset.provider = group.provider_id || '';
    og._ownerSelect = sel;
    if (group.extra_models) og.dataset.extraModels = JSON.stringify(group.extra_models);
    if (group.modelsEndpointError) og.dataset.modelsEndpointError = JSON.stringify(group.modelsEndpointError);
    for (const model of group.models || []) {
      og.appendChild(makeOption(model.id, model.label || model.id, og));
    }
    sel.children.push(og);
    sel.options.push(...og.children);
  }
  return sel;
}

const payload = JSON.parse(process.argv[3]);
const dropdown = makeNode('div');
dropdown.classList.add('open');
const modelSelect = makeSelect(payload.groups, payload.selectedValue || payload.groups[0].models[0].id);

function $(id) {
  if (id === 'composerModelDropdown') return dropdown;
  if (id === 'modelSelect') return modelSelect;
  return null;
}
const window = { _configuredModelBadges: payload.configuredBadges || {} };
const document = { createElement(tag) { return makeNode(tag); } };
function esc(v) { return String(v || ''); }
function t(key, ...args) {
  if (key === 'model_show_all_models') return `Show all ${args[0]} models`;
  return key;
}
function li() { return 'x'; }
function getModelLabel(v) { return String(v || ''); }
function _providerFromModelValue(v) {
  const value = String(v || '');
  if (value.startsWith('@') && value.includes(':')) return value.slice(1, value.lastIndexOf(':'));
  return '';
}
function _normalizeConfiguredModelKey(v) { return String(v || '').toLowerCase(); }
function _getConfiguredModelBadge(value, badgeMap) { return badgeMap[value] || null; }
function closeModelDropdown() {}
function selectModelFromDropdown() {}

for (const name of [
  '_readModelOverflowData',
  '_appendOverflowOptionsToGroup',
  '_isEquivalentConfiguredModelEntry',
  'renderModelDropdown',
]) {
  eval(extractFunc(name));
}

renderModelDropdown();

// Target the errored group's wrapper specifically by data-group attribute.
// A plain walk() that overwrites on every .model-group-body ends on the last
// wrapper in DOM order (the selected/open Anthropic group), giving a false
// "open" result regardless of whether _hasEndpointError fired.
let errWrap = null;
const walk = (node) => {
  for (const child of (node.children || [])) {
    if (child.className && child.className.includes('model-group-body') &&
        child.dataset && child.dataset.group === 'openrouter') {
      errWrap = child;
    }
    if (child.children && child.children.length) walk(child);
  }
};
walk(dropdown);

process.stdout.write(JSON.stringify({
  foundWrapper: !!errWrap,
  groupRendersOpen: !!errWrap && errWrap.style.display !== 'none',
}));
"""

_INPLACE_PREEXISTING_DRIVER = r"""
const fs = require('fs');
const ui = fs.readFileSync(process.argv[2], 'utf8');

function extractFunc(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let openParen = ui.indexOf('(', start);
  let i = openParen + 1;
  let parenDepth = 1;
  while (parenDepth > 0 && i < ui.length) {
    if (ui[i] === '(') parenDepth++;
    else if (ui[i] === ')') parenDepth--;
    i++;
  }
  i = ui.indexOf('{', i);
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  return ui.slice(start, i);
}

function extractConst(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=');
  const start = ui.search(re);
  if (start < 0) throw new Error(name + ' not found as const');
  const eqIdx = ui.indexOf('=', start + name.length);
  let i = ui.indexOf('{', eqIdx);
  if (i < 0) throw new Error(name + ' arrow body not found');
  let depth = 1;
  i++;
  while (depth > 0 && i < ui.length) {
    if (ui[i] === '{') depth++;
    else if (ui[i] === '}') depth--;
    i++;
  }
  if (ui[i] === ';') i++;
  return ui.slice(start, i);
}

const CSS = { escape: s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
const requestAnimationFrame = fn => { fn(); return 0; };

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    _set: set,
    add(cls) { set.add(cls); },
    remove(cls) { set.delete(cls); },
    contains(cls) { return set.has(cls); },
    toggle(cls, force) {
      if (force === true) { set.add(cls); return true; }
      if (force === false) { set.delete(cls); return false; }
      if (set.has(cls)) { set.delete(cls); return false; }
      set.add(cls);
      return true;
    },
  };
}

function defineClassName(node) {
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList = makeClassList(String(v || '').split(/\s+/).filter(Boolean)); },
  });
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    parentElement: null,
    textContent: '',
    value: '',
    tabIndex: 0,
    onclick: null,
    _listeners: {},
    _innerHTML: '',
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'OPTGROUP' && this._ownerSelect && child.tagName === 'OPTION') {
        this._ownerSelect.options.push(child);
      }
      return child;
    },
    insertBefore(newChild, refChild) {
      newChild.parentElement = this;
      const idx = refChild ? this.children.indexOf(refChild) : -1;
      if (idx >= 0) {
        this.children.splice(idx, 0, newChild);
      } else {
        this.children.push(newChild);
      }
      return newChild;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
      }
    },
    addEventListener(type, handler) { this._listeners[type] = handler; },
    querySelector(selector) {
      // Try the _qs cache first
      if (this._qs && this._qs[selector]) return this._qs[selector];
      // Handle attribute selectors and descendant selectors
      return querySelectorAllImpl(this, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return querySelectorAllImpl(this, selector);
    },
    setAttribute(name, value) { this[name] = value; },
    focus() { this._focused = true; },
  };
  Object.defineProperty(node, 'offsetTop', {
    value: 0,
  });
  Object.defineProperty(node, 'scrollTop', {
    get() { return this._scrollTop || 0; },
    set(v) { this._scrollTop = v; },
  });
  Object.defineProperty(node, 'previousElementSibling', {
    get() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    },
  });
  node.classList = makeClassList();
  defineClassName(node);
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      this._innerHTML = String(v || '');
      this.children = [];
      this._qs = {};
      if (this.tagName === 'DIV' && this._innerHTML.includes('model-search-input')) {
        const input = makeNode('input');
        input.className = 'model-search-input';
        const clear = makeNode('button');
        clear.className = 'model-search-clear';
        this._qs['.model-search-input'] = input;
        this._qs['.model-search-clear'] = clear;
      } else if (this.tagName === 'DIV' && this._innerHTML.includes('model-custom-input')) {
        const input = makeNode('input');
        input.className = 'model-custom-input';
        const btn = makeNode('button');
        btn.className = 'model-custom-btn';
        this._qs['.model-custom-input'] = input;
        this._qs['.model-custom-btn'] = btn;
      }
    },
  });
  return node;
}

function querySelectorAllImpl(node, selector) {
  const results = [];
  const stack = [node];

  while (stack.length) {
    const n = stack.shift();
    if (n.children && n.children.length) {
      stack.push(...n.children);
    }

    if (selector.startsWith('.') && !selector.includes('[') && !selector.includes(' ')) {
      const className = selector.slice(1);
      if (n.className && n.className.includes(className)) {
        results.push(n);
      }
    }
    else if (selector.includes('[') && !selector.includes(' ')) {
      const match = selector.match(/^\.([^\[]+)\[data-([^\]=]+)="([^\]]+)"\]$/);
      if (match) {
        const [, className, dataKey, dataVal] = match;
        if (n.className && n.className.includes(className) &&
            n.dataset && n.dataset[dataKey] === dataVal) {
          results.push(n);
        }
      }
    }
    else if (selector.includes(' ')) {
      const parts = selector.split(' ').filter(Boolean);
      if (parts.length === 2) {
        const [parentSel, childSel] = parts;
        let parent = n.parentElement;
        let hasParent = false;
        while (parent) {
          if (isMatch(parent, parentSel)) {
            hasParent = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (hasParent && isMatch(n, childSel)) {
          results.push(n);
        }
      }
    }
    // Bare tag-name selector: e.g. 'option'. Required so
    // _appendOverflowOptionsToGroup's querySelectorAll('option') finds
    // pre-injected <option> elements — without this, existingByValue stays
    // empty and the function never returns 0, so the extraModels.length guard
    // is never exercised.
    else if (!selector.startsWith('.') && !selector.includes('[') && !selector.includes(' ')) {
      if (n.tagName && n.tagName === selector.toUpperCase()) {
        results.push(n);
      }
    }
  }

  return results;
}

function isMatch(node, selector) {
  if (selector.startsWith('.') && !selector.includes('[')) {
    const className = selector.slice(1);
    return node.className && node.className.includes(className);
  }
  if (selector.includes('[')) {
    const match = selector.match(/^\.([^\[]+)\[data-([^\]=]+)="([^\]]+)"\]$/);
    if (match) {
      const [, className, dataKey, dataVal] = match;
      return node.className && node.className.includes(className) &&
             node.dataset && node.dataset[dataKey] === dataVal;
    }
  }
  if (!selector.startsWith('.') && !selector.includes('[')) {
    return node.tagName && node.tagName === selector.toUpperCase();
  }
  return false;
}

function makeOption(value, label, parent) {
  const opt = makeNode('option');
  opt.value = value;
  opt.textContent = label || value;
  opt.parentElement = parent || null;
  return opt;
}

function makeSelect(groups, selectedValue) {
  const sel = {
    id: 'modelSelect', tagName: 'SELECT', children: [], options: [], value: selectedValue || '',
    querySelectorAll(selector) { return querySelectorAllImpl(this, selector); },
    querySelector(selector) { return querySelectorAllImpl(this, selector)[0] || null; },
  };
  for (const group of groups || []) {
    const og = makeNode('optgroup');
    og.label = group.provider || '';
    og.dataset.provider = group.provider_id || '';
    og._ownerSelect = sel;
    og.parentNode = sel;
    if (group.extra_models) og.dataset.extraModels = JSON.stringify(group.extra_models);
    for (const model of group.models || []) {
      og.appendChild(makeOption(model.id, model.label || model.id, og));
    }
    sel.children.push(og);
    sel.options.push(...og.children);
  }
  return sel;
}

function findInTree(dd, pred) {
  const stack = [...(dd.children || [])];
  while (stack.length) {
    const n = stack.shift();
    if (pred(n)) return n;
    if (n.children && n.children.length) stack.push(...n.children);
  }
  return null;
}

const payload = JSON.parse(process.argv[3]);
const dropdown = makeNode('div');
dropdown.classList.add('open');
const modelSelect = makeSelect(payload.groups, payload.selectedValue || payload.groups[0].models[0].id);

// Pre-inject one overflow model as an <option> in the optgroup to simulate
// _ensureModelOptionInDropdown having already added it. Both overflow models
// are pre-injected so _appendOverflowOptionsToGroup returns 0 new appends,
// exercising the extraModels.length guard (not the return-value guard).
if (payload.preexistingModelIds) {
  const og = modelSelect.children[0];
  for (const mid of payload.preexistingModelIds) {
    const preexisting = payload.groups[0].extra_models.find(m => m.id === mid);
    if (preexisting && og) {
      const opt = makeOption(preexisting.id, preexisting.label || preexisting.id, og);
      og.appendChild(opt);
    }
  }
}

function $(id) {
  if (id === 'composerModelDropdown') return dropdown;
  if (id === 'modelSelect') return modelSelect;
  return null;
}
const window = { _configuredModelBadges: payload.configuredBadges || {} };
const document = { createElement(tag) { return makeNode(tag); } };
function esc(v) { return String(v || ''); }
function t(key, ...args) {
  if (key === 'model_show_all_models') return `Show all ${args[0]} models`;
  return key;
}
function li() { return 'x'; }
function getModelLabel(v) { return String(v || ''); }
function _providerFromModelValue(v) {
  const value = String(v || '');
  if (value.startsWith('@') && value.includes(':')) return value.slice(1, value.lastIndexOf(':'));
  return '';
}
function _normalizeConfiguredModelKey(v) { return String(v || '').toLowerCase(); }
function _getConfiguredModelBadge(value, badgeMap) { return badgeMap[value] || null; }
function closeModelDropdown() {}
function selectModelFromDropdown() {}

for (const name of [
  '_readModelOverflowData',
  '_appendOverflowOptionsToGroup',
  '_isEquivalentConfiguredModelEntry',
  'renderModelDropdown',
]) {
  eval(extractFunc(name));
}

eval(extractConst('_expandOverflowGroup'));

renderModelDropdown();
const initialShowAllRow = findInTree(dropdown, node => String(node._innerHTML || '').includes('Show all'));
initialShowAllRow.onclick({ stopPropagation() {} });

// Check if preexisting models are now visible - look through all innerHTML or textContent
const idsToFind = new Set(payload.preexistingModelIds || []);
const foundIds = new Set();
let showAllGone = false;
const walk = (node, depth=0) => {
  for (const mid of idsToFind) {
    if (node._innerHTML && node._innerHTML.includes(mid)) {
      foundIds.add(mid);
    }
    if (node.textContent && String(node.textContent).includes(mid)) {
      foundIds.add(mid);
    }
  }
  if (node.children && node.children.length) {
    for (const child of node.children) walk(child, depth+1);
  }
};
walk(dropdown);
const preexistingVisible = foundIds.size === idsToFind.size;
const expanded = findInTree(dropdown, node => String(node._innerHTML || '').includes('Show all'));
showAllGone = !expanded;

process.stdout.write(JSON.stringify({
  preexistingVisible,
  showAllGone,
}));
"""


@pytest.fixture(scope="module")
def _driver_paths(tmp_path_factory):
    driver_dir = tmp_path_factory.mktemp("issue3691_drivers")
    dropdown_path = driver_dir / "driver.js"
    dropdown_path.write_text(_DROPDOWN_DRIVER, encoding="utf-8")
    inplace_path = driver_dir / "driver_inplace.js"
    inplace_path.write_text(_INPLACE_DRIVER, encoding="utf-8")
    endpoint_error_path = driver_dir / "driver_endpoint_error.js"
    endpoint_error_path.write_text(_INPLACE_ENDPOINT_ERROR_DRIVER, encoding="utf-8")
    preexisting_path = driver_dir / "driver_preexisting.js"
    preexisting_path.write_text(_INPLACE_PREEXISTING_DRIVER, encoding="utf-8")
    return {
        "dropdown": str(dropdown_path),
        "inplace": str(inplace_path),
        "endpoint_error": str(endpoint_error_path),
        "preexisting": str(preexisting_path),
    }


@pytest.fixture(scope="module")
def _dropdown_driver_path(tmp_path_factory):
    path = tmp_path_factory.mktemp("issue3691_dropdown_driver") / "driver.js"
    path.write_text(_DROPDOWN_DRIVER, encoding="utf-8")
    return str(path)
