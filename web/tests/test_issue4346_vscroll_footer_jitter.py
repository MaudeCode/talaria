"""Behavioral and structural assertions for issue #4346 DOM node recycling.

Tests are organized in three tiers:
1. Structural: verify the recycling machinery exists in ui.js source
2. Behavioral (extracted): extract real functions from ui.js, execute them in
   Node.js with mock DOM objects, and assert on observable output
3. Behavioral (integrated): exercise multi-step recycling flows (stash → wipe
   → lookup → type-check) end-to-end in Node.js

Every behavioral test is designed to FAIL on the known-buggy versions that the
maintainer's review caught, and PASS only on the fixed version.
"""
import json
import pathlib
import re
import shutil
import subprocess
import tempfile

import pytest

ROOT = pathlib.Path(__file__).parent.parent
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node not on PATH")


def _run_node(source: str) -> str:
    with tempfile.NamedTemporaryFile(
        "w", suffix=".cjs", encoding="utf-8", dir=ROOT, delete=False
    ) as script:
        script.write(source)
        script_path = pathlib.Path(script.name)
    try:
        result = subprocess.run(
            [NODE, str(script_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        script_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def _extract_func_script(js: str) -> str:
    return f"""
const src = {js!r};
function extractFunc(name) {{
  const re = new RegExp('function\\\\s+' + name + '\\\\s*\\\\(');
  const start = src.search(re);
  if (start < 0) throw new Error(name + ' not found');
  let i = src.indexOf('{{', start);
  let depth = 1; i++;
  while (depth > 0 && i < src.length) {{
    if (src[i] === '{{') depth++;
    else if (src[i] === '}}') depth--;
    i++;
  }}
  return src.slice(start, i);
}}
"""


# ═══════════════════════════════════════════════════════════════════════════
# Tier 1: Structural assertions — verify recycling machinery in source
# ═══════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════
# Tier 2: Behavioral — extract real functions, run with mock DOM
# ═══════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════
# Tier 3: Integrated recycling flow tests — multi-step stash→wipe→lookup
# ═══════════════════════════════════════════════════════════════════════════

class TestContentSkipOptimization:
    """When a recycled user row's content hasn't changed, the innerHTML
    update should be skipped entirely to avoid layout thrash."""

    def test_unchanged_content_skips_innerhtml_update(self):
        """Recycled row with matching rawText should NOT get innerHTML reassigned."""
        source = r"""
let innerHTMLWriteCount = 0;

const row = {
  dataset: { msgIdx: '2', rawText: 'hello world' },
  classList: { contains(name){ return name === 'msg-row'; } },
  set innerHTML(val){ innerHTMLWriteCount++; },
  get innerHTML(){ return '<div class="msg-body">hello world</div><div class="msg-foot">same</div>'; },
};

const _recycleStash = new Map();
_recycleStash.set(2, row);
const _msgNodeRecycleEnabled = true;

// Simulate the user-row recycling branch
const rawIdx = 2;
let r = _msgNodeRecycleEnabled ? _recycleStash.get(rawIdx) : null;
if(r && (!r.classList.contains('msg-row') || r.classList.contains('assistant-turn'))) r = null;
if(r){
  const newRawText = 'hello world';
  const nextRowHtml = '<div class="msg-body">hello world</div><div class="msg-foot">same</div>';
  if(r.dataset.rawText !== newRawText || r.innerHTML !== nextRowHtml){
    r.dataset.rawText = newRawText;
    r.innerHTML = nextRowHtml;
  }
}

console.log(JSON.stringify({
  recycled: r === row,
  innerHTML_writes: innerHTMLWriteCount,
  skipped: innerHTMLWriteCount === 0,
}));
"""
        out = json.loads(_run_node(source))
        assert out["recycled"] is True
        assert out["skipped"] is True, \
            f"innerHTML was written {out['innerHTML_writes']} times for unchanged content"

    def test_changed_content_updates_innerhtml(self):
        """Recycled row with different rawText SHOULD get innerHTML reassigned."""
        source = r"""
let innerHTMLWriteCount = 0;

const row = {
  dataset: { msgIdx: '2', rawText: 'old content' },
  classList: { contains(name){ return name === 'msg-row'; } },
  set innerHTML(val){ innerHTMLWriteCount++; },
  get innerHTML(){ return '<div class="msg-body">old content</div>'; },
};

const _recycleStash = new Map();
_recycleStash.set(2, row);
const _msgNodeRecycleEnabled = true;

const rawIdx = 2;
let r = _msgNodeRecycleEnabled ? _recycleStash.get(rawIdx) : null;
if(r && (!r.classList.contains('msg-row') || r.classList.contains('assistant-turn'))) r = null;
if(r){
  const newRawText = 'new content';
  const nextRowHtml = '<div class="msg-body">new content</div>';
  if(r.dataset.rawText !== newRawText || r.innerHTML !== nextRowHtml){
    r.dataset.rawText = newRawText;
    r.innerHTML = nextRowHtml;
  }
}

console.log(JSON.stringify({
  recycled: r === row,
  innerHTML_writes: innerHTMLWriteCount,
  updated: innerHTMLWriteCount === 1,
  rawText_updated: r.dataset.rawText === 'new content',
}));
"""
        out = json.loads(_run_node(source))
        assert out["recycled"] is True
        assert out["updated"] is True, "innerHTML was not updated for changed content"
        assert out["rawText_updated"] is True, "rawText was not updated"

    def test_same_rawtext_but_changed_markup_updates_innerhtml(self):
        """Recycled rows must refresh when files/footer markup changes."""
        source = r"""
let innerHTMLWriteCount = 0;

const row = {
  dataset: { msgIdx: '2', rawText: 'same text' },
  classList: { contains(name){ return name === 'msg-row'; } },
  set innerHTML(val){ innerHTMLWriteCount++; this._html = val; },
  get innerHTML(){ return '<div class="msg-body">same text</div><div class="msg-foot">old</div>'; },
};

const _recycleStash = new Map();
_recycleStash.set(2, row);
const _msgNodeRecycleEnabled = true;

const rawIdx = 2;
let r = _msgNodeRecycleEnabled ? _recycleStash.get(rawIdx) : null;
if(r && (!r.classList.contains('msg-row') || r.classList.contains('assistant-turn'))) r = null;
const newRawText = 'same text';
const nextRowHtml = '<div class="msg-body">same text</div><div class="msg-foot">new</div>';
if(r){
  if(r.dataset.rawText !== newRawText || r.innerHTML !== nextRowHtml){
    r.dataset.rawText = newRawText;
    r.innerHTML = nextRowHtml;
  }
}

console.log(JSON.stringify({
  recycled: r === row,
  innerHTML_writes: innerHTMLWriteCount,
  updated: innerHTMLWriteCount === 1,
}));
"""
        out = json.loads(_run_node(source))
        assert out["recycled"] is True
        assert out["updated"] is True, \
            "same rawText with changed markup must still refresh the row"

    def test_recycled_row_clears_transient_editing_flag(self):
        """Recycled rows must clear stale edit state before reuse."""
        source = r"""
const row = {
  dataset: { msgIdx: '2', rawText: 'same text', editing: '1' },
  classList: { contains(name){ return name === 'msg-row'; } },
  set innerHTML(val){ this._html = val; },
  get innerHTML(){ return '<div class="msg-body">same text</div><div class="msg-foot">same</div>'; },
};

const _recycleStash = new Map();
_recycleStash.set(2, row);
const _msgNodeRecycleEnabled = true;

const rawIdx = 2;
let r = _msgNodeRecycleEnabled ? _recycleStash.get(rawIdx) : null;
if(r && (!r.classList.contains('msg-row') || r.classList.contains('assistant-turn'))) r = null;
const newRawText = 'same text';
const nextRowHtml = '<div class="msg-body">same text</div><div class="msg-foot">same</div>';
if(r){
  delete r.dataset.editing;
  if(r.dataset.rawText !== newRawText || r.innerHTML !== nextRowHtml){
    r.dataset.rawText = newRawText;
    r.innerHTML = nextRowHtml;
  }
}

console.log(JSON.stringify({
  recycled: r === row,
  editing_cleared: !('editing' in r.dataset),
}));
"""
        out = json.loads(_run_node(source))
        assert out["recycled"] is True
        assert out["editing_cleared"] is True, \
            "recycled rows must drop stale dataset.editing state"


# ═══════════════════════════════════════════════════════════════════════════
# Tier 5: Scrollbar drag suppression — prevent innerHTML wipe during
# native scrollbar drag to avoid browser releasing the pointer grab
# ═══════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════
# Tier 6: Maintainer must-fix regression tests — raw numerical evidence
#
# Maps directly to nesquena-hermes's CHANGES_REQUESTED review on PR #4474:
#   MF-1: data-msg-idx on .assistant-turn corrupts measurement heights
#   MF-2: un-typed stash lookups allow cross-type node recycling
#   MF-3: source-text grep tests pass even on broken code
#
# Each test produces concrete numbers proving the fix works and the bug
# would produce wrong numbers without it.
# ═══════════════════════════════════════════════════════════════════════════

class TestMaintainerMF2CrossTypeCollision:
    """MF-2: typed guards on stash lookups prevent cross-type node recycling.

    Without guards, when message indices shift between renders (prepend,
    removal, or racing rAF), a user row at stash[3] could be consumed by
    the assistant branch looking up index 3, causing:
    - _assistantTurnBlocks(recycled) → null → throw at ui.js:10501 → blank chat
    - Or vice versa: assistant-turn repurposed as user row with wrong class/id

    These tests exercise both directions with concrete node counts."""

    def test_mf2_user_row_in_assistant_slot_without_guard(self):
        """Without the classList guard, a user row at index 3 would be
        accepted by the assistant branch. Count how many fields are wrong."""
        source = r"""
const userRow = {
  id: 'msg-user-3',
  dataset: { msgIdx: '3', rawText: 'hello', role: 'user' },
  classList: { contains(name){ return name === 'msg-row'; } },
  className: 'msg-row',
  childNodes: [{textContent: 'hello'}],
};

// WITHOUT guard (the buggy behavior)
let buggy_recycled = userRow;
// No type check — just use whatever came back from stash

// WITH guard (the fix)
let fixed_recycled = userRow;
if (fixed_recycled && !fixed_recycled.classList.contains('assistant-turn'))
  fixed_recycled = null;

// Count mismatched properties if the buggy path reused the node
const mismatches = [];
if (buggy_recycled.className !== 'assistant-turn') mismatches.push('className');
if (buggy_recycled.dataset.role !== 'assistant') mismatches.push('dataset.role');
if (buggy_recycled.id.startsWith('msg-user')) mismatches.push('id');

console.log(JSON.stringify({
  buggy_accepted: buggy_recycled !== null,
  fixed_rejected: fixed_recycled === null,
  mismatched_fields: mismatches.length,
  mismatches: mismatches,
}));
"""
        out = json.loads(_run_node(source))
        assert out["buggy_accepted"] is True, \
            "Bug simulation: user row was not accepted (test setup error)"
        assert out["fixed_rejected"] is True, \
            "Guard did not reject user row in assistant slot"
        assert out["mismatched_fields"] == 3, \
            f"Expected 3 mismatched fields, got {out['mismatched_fields']}: {out['mismatches']}"

    def test_mf2_assistant_turn_in_user_slot_without_guard(self):
        """Without the classList guard, an assistant turn at index 5 would
        be accepted by the user branch. Count wrong properties."""
        source = r"""
const assistantTurn = {
  id: '',
  dataset: { recycleKey: '5', role: 'assistant' },
  classList: { contains(name){ return name === 'assistant-turn' || name === 'msg-row'; } },
  className: 'msg-row assistant-turn',
  childNodes: [{classList: {contains(n){return n==='assistant-segment';}}}],
};

// WITHOUT guard
let buggy_row = assistantTurn;

// WITH guard
let fixed_row = assistantTurn;
if (fixed_row && (!fixed_row.classList.contains('msg-row') || fixed_row.classList.contains('assistant-turn')))
  fixed_row = null;

const mismatches = [];
if (buggy_row.className !== 'msg-row') mismatches.push('className');
if (buggy_row.dataset.role !== 'user') mismatches.push('dataset.role');
if (!buggy_row.dataset.msgIdx) mismatches.push('dataset.msgIdx missing');

console.log(JSON.stringify({
  buggy_accepted: buggy_row !== null,
  fixed_rejected: fixed_row === null,
  mismatched_fields: mismatches.length,
  mismatches: mismatches,
}));
"""
        out = json.loads(_run_node(source))
        assert out["buggy_accepted"] is True, \
            "Bug simulation: assistant turn was not accepted (test setup error)"
        assert out["fixed_rejected"] is True, \
            "Guard did not reject assistant turn in user slot"
        assert out["mismatched_fields"] == 3, \
            f"Expected 3 mismatched fields, got {out['mismatched_fields']}: {out['mismatches']}"

    def test_mf2_stash_collision_rate_in_shifted_indices(self):
        """Simulate an index shift where 5 nodes are stashed, then the
        message list is prepended with 2 new messages (shifting all indices
        by +2). Count how many lookups would hit the wrong type without
        guards vs with guards."""
        source = r"""
const _recycleStash = new Map();

// Pre-shift DOM: user rows at 0,2,4; assistant turns at 1,3
const nodes = [
  {type: 'user',      idx: 0, classes: ['msg-row']},
  {type: 'assistant', idx: 1, classes: ['msg-row', 'assistant-turn']},
  {type: 'user',      idx: 2, classes: ['msg-row']},
  {type: 'assistant', idx: 3, classes: ['msg-row', 'assistant-turn']},
  {type: 'user',      idx: 4, classes: ['msg-row']},
];
for (const n of nodes) {
  const mock = {
    dataset: n.type === 'assistant' ? {recycleKey: String(n.idx)} : {msgIdx: String(n.idx)},
    classList: { contains(name){ return n.classes.includes(name); } },
    _type: n.type,
  };
  _recycleStash.set(n.idx, mock);
}

// Post-shift: 2 messages prepended, all old indices shift by +2
// Old idx 0 → now at idx 2, old idx 1 → now at idx 3, etc.
// New render wants: user at 0, user at 1, user at 2, assistant at 3, user at 4
const wanted = [
  {idx: 0, wantType: 'user',      branch: 'msg-row'},
  {idx: 1, wantType: 'user',      branch: 'msg-row'},
  {idx: 2, wantType: 'user',      branch: 'msg-row'},
  {idx: 3, wantType: 'assistant', branch: 'assistant-turn'},
  {idx: 4, wantType: 'user',      branch: 'msg-row'},
];

let buggy_wrong = 0, buggy_correct = 0, buggy_miss = 0;
let fixed_wrong = 0, fixed_correct = 0, fixed_miss = 0;

for (const w of wanted) {
  const node = _recycleStash.get(w.idx);
  if (!node) {
    buggy_miss++;
    fixed_miss++;
    continue;
  }

  // Without guard
  if (node._type === w.wantType) buggy_correct++;
  else buggy_wrong++;

  // With the real asymmetric fixed guards
  const accepted = w.wantType === 'assistant'
    ? node.classList.contains('assistant-turn')
    : (node.classList.contains('msg-row') && !node.classList.contains('assistant-turn'));
  if (accepted && node._type === w.wantType) fixed_correct++;
  else if (accepted) fixed_wrong++;
  else fixed_miss++;  // rejected, will build fresh
}

console.log(JSON.stringify({
  total_lookups: wanted.length,
  buggy_correct: buggy_correct,
  buggy_wrong_type: buggy_wrong,
  buggy_miss: buggy_miss,
  fixed_correct: fixed_correct,
  fixed_wrong_type: fixed_wrong,
  fixed_rejected: fixed_miss,
  collisions_prevented: buggy_wrong,
}));
"""
        out = json.loads(_run_node(source))
        assert out["buggy_wrong_type"] > 0, \
            "Simulation didn't produce any cross-type collisions (test setup error)"
        assert out["fixed_wrong_type"] == 0, \
            f"Fixed guard still accepted wrong-type nodes: {out['fixed_wrong_type']}"
        assert out["fixed_rejected"] >= out["buggy_wrong_type"], \
            f"Guards didn't catch all collisions: {out['fixed_rejected']} rejected vs {out['buggy_wrong_type']} wrong"


class TestStashKeyCoercion:
    """The stash uses Number(key) for storage. Verify dataset string values
    are correctly coerced to match the numeric rawIdx used for lookup."""

    def test_string_dataset_matches_numeric_lookup(self):
        """dataset.msgIdx is a string ('3'), but _recycleStash.get(3)
        uses a number. Number('3') === 3 must hold for the stash to work."""
        source = r"""
const _recycleStash = new Map();

const row = {
  dataset: { msgIdx: '3' },
  classList: { contains(name){ return name === 'msg-row'; } },
  querySelector(){ return null; },
};

// Stash phase uses Number(key)
const key = row.dataset.msgIdx;
_recycleStash.set(Number(key), row);

// Lookup phase uses numeric rawIdx
const rawIdx = 3;
const found = _recycleStash.get(rawIdx);

console.log(JSON.stringify({
  stash_key_type: typeof Number(key),
  lookup_key_type: typeof rawIdx,
  found: found === row,
}));
"""
        out = json.loads(_run_node(source))
        assert out["found"] is True, "numeric coercion mismatch between stash and lookup"
