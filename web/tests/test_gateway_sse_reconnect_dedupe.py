"""Regression coverage for gateway SSE reconnect refresh dedupe."""

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SESSIONS_JS = ROOT / "static" / "sessions.js"
GATEWAY_WATCHER = ROOT / "api" / "gateway_watcher.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _block(src: str, start: str, end: str) -> str:
    i = src.index(start)
    j = src.index(end, i)
    return src[i:j]


def test_gateway_watcher_remains_hash_only():
    """The watcher should not try to infer restarts from state.db mtime."""
    src = _read(GATEWAY_WATCHER)
    poll_once = _block(src, "    def _poll_once(", "\n    def _poll_loop")

    assert "_get_db_mtime" not in src
    assert "_detect_gateway_restart" not in src
    assert "current_hash = _snapshot_hash(sessions)" in poll_once
    assert "if current_hash != self._last_hash:" in poll_once


def test_gateway_snapshot_dedupe_logic_filters_symmetrically():
    """Exercise the dedupe helpers, including null and webui noise."""
    script = r"""
function _isCliSession(session) {
  return session && (session.session_source === 'cli' || session.raw_source === 'cli' || session.is_cli_session === true);
}
function _isMessagingSession(session) {
  return session && session.session_source === 'messaging';
}
function _gatewaySessionSnapshotKey(sessions){
  return (Array.isArray(sessions)?sessions:[])
    .filter(s=>s&&s.session_id)
    .map(s=>`${s.session_id}:${s.updated_at||0}:${s.message_count||0}`)
    .sort()
    .join('|');
}
function _isGatewaySessionForSnapshot(session){
  if(!session) return false;
  if(typeof _isCliSession==='function'&&_isCliSession(session)) return true;
  if(typeof _isMessagingSession==='function'&&_isMessagingSession(session)) return true;
  const source=String(session.session_source||session.raw_source||session.source_tag||session.source||'').toLowerCase();
  return !!source&&source!=='webui';
}
function _isDuplicateGatewaySessionSnapshot(sessions){
  const incoming=(Array.isArray(sessions)?sessions:[]).filter(_isGatewaySessionForSnapshot);
  const currentGatewaySessions=(Array.isArray(globalThis._allSessions)?globalThis._allSessions:[]).filter(_isGatewaySessionForSnapshot);
  if(!incoming.length&&!currentGatewaySessions.length) return true;
  return _gatewaySessionSnapshotKey(incoming)===_gatewaySessionSnapshotKey(currentGatewaySessions);
}

globalThis._allSessions = [
  {session_id:'cli-1', updated_at:10, message_count:2, session_source:'cli'},
  {session_id:'msg-1', updated_at:20, message_count:5, session_source:'messaging'},
  {session_id:'web-1', updated_at:30, message_count:1, session_source:'webui'},
  null,
];

const duplicateWithNoise = [
  null,
  {session_id:'web-2', updated_at:99, message_count:1, session_source:'webui'},
  {session_id:'msg-1', updated_at:20, message_count:5, session_source:'messaging'},
  {session_id:'cli-1', updated_at:10, message_count:2, session_source:'cli'},
];
if(!_isDuplicateGatewaySessionSnapshot(duplicateWithNoise)) throw new Error('expected duplicate snapshot');

const changed = [
  {session_id:'cli-1', updated_at:10, message_count:3, session_source:'cli'},
  {session_id:'msg-1', updated_at:20, message_count:5, session_source:'messaging'},
];
if(_isDuplicateGatewaySessionSnapshot(changed)) throw new Error('expected changed snapshot');

globalThis._allSessions = [{session_id:'web-1', updated_at:1, message_count:1, session_source:'webui'}];
if(!_isDuplicateGatewaySessionSnapshot([null, {session_id:'web-2', session_source:'webui'}])) throw new Error('expected empty gateway snapshot duplicate');
"""
    subprocess.run(["node", "-e", script], check=True)
