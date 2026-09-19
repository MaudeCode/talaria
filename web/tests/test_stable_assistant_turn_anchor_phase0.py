"""Phase 0 contract tests for Stable Assistant Turn Anchors (#3926).

The first implementation slice was intentionally non-visual. Later slices keep
the same inventory contract while adding narrow, tested wiring points.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ANCHORS_JS = REPO / "static" / "assistant_turn_anchors.js"
INDEX_HTML = REPO / "static" / "index.html"
MESSAGES_JS = REPO / "static" / "messages.js"
UI_JS = REPO / "static" / "ui.js"
SESSIONS_JS = REPO / "static" / "sessions.js"
SW_JS = REPO / "static" / "sw.js"
PHASE0_DOC = REPO / "docs" / "architecture" / "stable-assistant-turn-anchor-phase0.md"
NODE = shutil.which("node")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _anchor_api_snapshot() -> dict:
    assert NODE, "node is required for assistant_turn_anchors.js helper tests"
    script = f"""
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync({json.dumps(str(ANCHORS_JS))}, 'utf8');
const sandbox = {{window:{{}}}};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, {{filename:'assistant_turn_anchors.js'}});
const api = sandbox.window.HermesAssistantTurnAnchors;
const anchor = api.createAssistantTurnAnchorSeed({{
  session_id:'sid-1',
  stream_id:'stream-1',
  run_id:'run-1',
  source_message_refs:['m1'],
}});
const out = {{
  version: api.version,
  kinds: api.activityEventKinds,
  layers: api.stateLayers,
  classifications: api.sourceEventClassification,
  classificationOrder: api.classificationOrder,
  terminalStates: api.terminalStates,
  terminalAliases: {{
    done: api.normalizeAssistantTurnAnchorTerminalState('done'),
    cancel: api.normalizeAssistantTurnAnchorTerminalState('cancel'),
    apperror: api.normalizeAssistantTurnAnchorTerminalState('apperror'),
    interruptedByUser: api.normalizeAssistantTurnAnchorTerminalState('interrupted-by-user'),
    lostBookkeeping: api.normalizeAssistantTurnAnchorTerminalState('lost_worker_bookkeeping'),
    maxIterations: api.normalizeAssistantTurnAnchorTerminalState('max_iterations'),
    unknown: api.normalizeAssistantTurnAnchorTerminalState('unknown'),
  }},
  tokenKind: api.classifyAssistantTurnAnchorSourceEvent('token').kind,
  streamEndClass: api.classifyAssistantTurnAnchorSourceEvent('stream_end').classification,
  unknownClass: api.classifyAssistantTurnAnchorSourceEvent('unknown_future').classification,
  eventIdKey: api.assistantTurnAnchorEventDedupeKey({{event_id:'run-1:2', text:'same'}}),
  runSeqKey: api.assistantTurnAnchorEventDedupeKey({{run_id:'run-1', seq:2, timestamp:123}}),
  localKey: api.assistantTurnAnchorEventDedupeKey({{session_id:'sid-1', source_event_type:'token', local_id:'local-1', seq:2, content:'ignored'}}),
  localNoSeqKey: api.assistantTurnAnchorEventDedupeKey({{session_id:'sid-1', source_event_type:'token', local_id:'local-1', content:'ignored'}}),
  zeroSeqKey: api.assistantTurnAnchorEventDedupeKey({{run_id:'run-1', seq:0, session_id:'sid-1', local_id:'local-1'}}),
  nanSeqKey: api.assistantTurnAnchorEventDedupeKey({{run_id:'run-1', seq:NaN, session_id:'sid-1', local_id:'local-1'}}),
  emptySeqKey: api.assistantTurnAnchorEventDedupeKey({{run_id:'run-1', seq:'', session_id:'sid-1', local_id:'local-1'}}),
  emptyKey: api.assistantTurnAnchorEventDedupeKey({{content:'visible text only', timestamp:123}}),
  artifactIsActivityKind: api.isAssistantTurnAnchorActivityKind('artifact_reference'),
  terminalIsActivityKind: api.isAssistantTurnAnchorActivityKind('terminal_status'),
  anchor,
}};
console.log(JSON.stringify(out));
"""
    result = subprocess.run([NODE, "-e", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_phase0_inventory_doc_matches_scaffold_contract():
    doc = _read(PHASE0_DOC)
    for marker in [
        "RuntimeAdapter / run-journal Event Envelope",
        "Run journal replay events",
        "Server settled transcript",
        "`S.messages`",
        "`INFLIGHT`",
        "Stream closure state",
        "Live DOM",
        "Slice 7 Dual-Run Reconciler",
        "`HermesAssistantTurnAnchors.reconcileAssistantTurnAnchorActivityScene()`",
        "`activity_scene_reconciliation_v1`",
        "Dedupe Invariant",
        "`event_id`",
        "`run_id + seq`",
        "`session_id + source_event_type + local_id + seq`",
    ]:
        assert marker in doc
