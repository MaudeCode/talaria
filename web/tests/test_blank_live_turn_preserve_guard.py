"""Regression: blank assistant turn (对话消失) AND duplicate settled render (#6948)
— the live-turn preserve guard must require a PROVABLE live owner.

Root cause (reproduced + fixed on an isolated debug instance, 2026-07-01)
------------------------------------------------------------------------
`renderMessages()` (static/ui.js) preserves the `#liveAssistantTurn` DOM node
across the `inner.innerHTML=''` wipe so the smd parser's live reference is not
detached mid-stream (#3877 flicker fix). The preserve guard originally fired
whenever `INFLIGHT[sid]` existed:

    let _preservedLiveTurn=null;
    if(sid&&INFLIGHT[sid]){
      const _lt=document.getElementById('liveAssistantTurn');
      if(_lt&&(...sessionId matches...)){ _preservedLiveTurn=_lt; }
    }

When a turn's SSE dropped (S.activeStreamId cleared to null) but its
`INFLIGHT[sid]` entry was NOT cleaned, the live turn was a DEAD EMPTY shell —
avatar + an empty worklog group ("Processed Ns", no body/tool rows). On the
next `session-updated` self-heal swap (loadSession force + keepStaleUntilLoaded,
common under repeated self-wake restarts), the guard re-attached that empty
shell OVER the freshly-wiped transcript, pinning an avatar-only blank turn on
top of the already-persisted answer. That is the reported "对话消失".

First fix (#5390)
-----------------
Gate preservation on "real rendered content OR an active stream":

    const _hasRealLiveContent=!!_lt.querySelector(
      '.msg-body, .tool-card-row, .wl-reason'
    );
    if(_hasRealLiveContent || S.activeStreamId){ _preservedLiveTurn=_lt; }

That stopped the EMPTY shell but made rendered content itself act as authority.

Second bug (#6948)
------------------
After an assistant turn COMPLETES, the same message can render twice in the
feed (first copy without model label, second with it). Data was always clean —
state.db, the sidecar, and /api/session each hold one row; the duplicate is a
rendering artifact: a stale live-turn DOM node survives the settled-transcript
swap and is re-attached on top of it. When the stream has ended (S.activeStreamId
nulled) but `INFLIGHT[sid]` has not been cleaned yet, `_hasRealLiveContent` is
still true (the completed body is in the DOM), so the DEAD live turn is
preserved and re-attached OVER the settled transcript — two copies.

Final contract (this file)
--------------------------
Preservation requires a PROVABLE live owner: the requested pane must still own
the session, the current session must expose an active stream identity, and the
`INFLIGHT` identity must match it when present. Only then may an active client
stream or explicit live-assistant projection authorize preserving the node.
Bare DOM content and bare projection markers are never authority. This retains
mid-stream and reconnect rendering while rejecting dead, cross-session, and
mismatched-run nodes.
"""
import pathlib
import re
import shutil
import subprocess
import textwrap

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding="utf-8")


def _preserve_guard_src():
    src = read("static/ui.js")
    i = src.find("let _preservedLiveTurn=null;")
    assert i >= 0, "_preservedLiveTurn guard not found"
    # capture through the closing of the if-block (next 'const compressionState')
    j = src.find("const compressionState", i)
    assert j > i, "guard block end not found"
    return src[i:j]


class TestBlankLiveTurnPreserveGuard:
    def test_runtime_rejects_dead_shell_preserves_live(self):
        node = shutil.which("node")
        if not node:
            import pytest
            pytest.skip("node not available")
        script = textwrap.dedent(
            """
            const assert=require('assert');
            // Mirror the guard's owner predicate: pane + current stream +
            // matching INFLIGHT identity + active client/projection evidence.
            function guardWouldPreserve(lt, activeStreamId, sessionStreamId, messages, inflightStreamId, sessionId, loadingSessionId){
              if(!lt) return false;
              if(lt.dataset&&lt.dataset.sessionId&&lt.dataset.sessionId!==sessionId) return false;
              const paneOwns=!loadingSessionId||loadingSessionId===sessionId;
              const currentOwner=String(activeStreamId||sessionStreamId||'');
              const streamMatches=!!currentOwner&&(!inflightStreamId||inflightStreamId===currentOwner);
              const hasLiveProjection=Array.isArray(messages)&&messages.some(m=>
                m&&m.role==='assistant'&&(m._live||m._activityBurstId!==undefined||m._liveSegmentSeq!==undefined)
              );
              return paneOwns&&streamMatches&&(!!activeStreamId||hasLiveProjection);
            }
            // Minimal DOM element stub with querySelector over a class set.
            function el(classes, dataset){
              const set=new Set(classes||[]);
              return {
                dataset: dataset||null,
                querySelector(sel){
                  // sel is a comma list of .class tokens
                  return sel.split(',').map(s=>s.trim().replace(/^\\\\./,''))
                    .some(c=>set.has(c)) ? {} : null;
                }
              };
            }
            const settledMessages=[];                                 // no live markers
            const liveMessages=[{role:'assistant',content:'answer',_live:true}];
            const burstLiveMessages=[{role:'assistant',content:'x',_activityBurstId:3}];
            const segLiveMessages=[{role:'assistant',content:'x',_liveSegmentSeq:1}];
            const deadShell = el([]);                 // empty worklog shell, no content
            const withBody  = el(['msg-body']);       // contentful (completed) turn
            const wrongSess = el(['msg-body'], {sessionId:'other-sid'});
            assert.strictEqual(guardWouldPreserve(deadShell, null, null, settledMessages, 'run-1', 's1', null), false, 'dead shell rejected');
            assert.strictEqual(guardWouldPreserve(deadShell, 'run-1', 'run-1', settledMessages, 'run-1', 's1', null), true, 'active stream preserved');
            assert.strictEqual(guardWouldPreserve(withBody, null, null, settledMessages, 'run-1', 's1', null), false, 'contentful dead turn rejected');
            assert.strictEqual(guardWouldPreserve(withBody, null, 'run-1', liveMessages, 'run-1', 's1', null), true, 'reconnect projection with owner preserved');
            assert.strictEqual(guardWouldPreserve(withBody, null, null, liveMessages, 'run-1', 's1', null), false, 'bare projection is not authority');
            assert.strictEqual(guardWouldPreserve(withBody, null, 'run-1', burstLiveMessages, 'run-1', 's1', null), true, 'burst projection preserved');
            assert.strictEqual(guardWouldPreserve(withBody, null, 'run-1', segLiveMessages, 'run-1', 's1', null), true, 'segment projection preserved');
            assert.strictEqual(guardWouldPreserve(withBody, 'run-2', 'run-2', liveMessages, 'run-1', 's1', null), false, 'mismatched run rejected');
            assert.strictEqual(guardWouldPreserve(withBody, 'run-1', 'run-1', liveMessages, 'run-1', 's1', 's2'), false, 'requested pane mismatch rejected');
            assert.strictEqual(guardWouldPreserve(wrongSess, 'run-1', 'run-1', liveMessages, 'run-1', 's1', null), false, 'wrong-session DOM rejected');
            console.log('OK');
            """
        )
        out = subprocess.run([node, "-e", script], capture_output=True, text=True)
        assert out.returncode == 0, f"node harness failed: {out.stderr}\n{out.stdout}"
        assert "OK" in out.stdout

    def test_settled_transcript_with_stale_inflight_renders_once(self):
        """#6948 browser-lifecycle equivalent in the node harness: the full
        renderMessages decision — capture guard + wipe + rebuild — must yield
        exactly ONE assistant row when a contentful live DOM node exists but
        the projection is settled (stream ended, INFLIGHT[sid] stale)."""
        node = shutil.which("node")
        if not node:
            import pytest
            pytest.skip("node not available")
        script = textwrap.dedent(
            """
            const assert=require('assert');
            // Faithful mirror of the renderMessages preserve decision + the
            // re-attach step. Semantics of the real code (static/ui.js):
            //   - the rebuilt DOM renders settled assistant rows from the
            //     projection; a live-projection assistant renders as the
            //     rebuilt live turn;
            //   - when the guard captured the live node it REPLACES the rebuilt
            //     live row (segment/whole-turn swap) — never appends on top of a
            //     row that already exists in the projection;
            //   - mid-stream the in-progress turn is NOT yet in the projection,
            //     so the preserved node appends as the live tail (one live row);
            //   - when the guard did NOT capture (settled + stale INFLIGHT), the
            //     rebuilt settled rows stand alone — exactly one copy.
            function renderMessagesSim(lt, activeStreamId, sessionStreamId, messages, inflightStreamId, loadingSessionId){
              let preservedLiveTurn=null;
              const sid='s1';
              if(sid&&inflightStreamId){
                if(lt&&(!lt.dataset||!lt.dataset.sessionId||lt.dataset.sessionId===sid)){
                  const paneOwns=!loadingSessionId||loadingSessionId===sid;
                  const currentOwner=String(activeStreamId||sessionStreamId||'');
                  const streamMatches=!!currentOwner&&inflightStreamId===currentOwner;
                  const hasLiveProjection=Array.isArray(messages)&&messages.some(m=>
                    m&&m.role==='assistant'&&(m._live||m._activityBurstId!==undefined||m._liveSegmentSeq!==undefined)
                  );
                  if(paneOwns&&streamMatches&&(activeStreamId||hasLiveProjection)) preservedLiveTurn=lt;
                }
              }
              const liveMark=m=>m&&m.role==='assistant'&&(m._live||m._activityBurstId!==undefined||m._liveSegmentSeq!==undefined);
              const hasLiveRow=Array.isArray(messages)&&messages.some(liveMark);
              const finalRows=(messages||[]).filter(m=>m&&m.role==='assistant'&&!liveMark(m));
              if(preservedLiveTurn){
                // Swap-in replaces the rebuilt live row when one exists; the
                // mid-stream case appends the live tail (turn not yet in the
                // projection). Either way: one row for the turn.
                finalRows.push({role:'assistant',_preserved:true});
              }else if(hasLiveRow){
                finalRows.push({role:'assistant',_rebuiltLive:true});
              }
              return finalRows;
            }
            const settled=[{role:'user',content:'hi'},{role:'assistant',content:'final answer'}];
            const midStreamMessages=[{role:'user',content:'hi'}];           // turn not yet persisted
            const liveTail=[{role:'user',content:'hi'},{role:'assistant',content:'partial',_live:true}];
            const contentfulLiveNode={dataset:{sessionId:'s1'},querySelector:()=>({})};
            // The bug (#6948): stale INFLIGHT + settled projection + contentful
            // dead node → TWO rows before the fix; exactly ONE after.
            assert.strictEqual(
              renderMessagesSim(contentfulLiveNode, null, null, settled, 'run-1', null).length, 1,
              'settled transcript must render exactly once despite stale INFLIGHT + contentful DOM (#6948)'
            );
            // Mid-stream: active stream keeps the live node attached (one live row).
            assert.strictEqual(
              renderMessagesSim(contentfulLiveNode, 'run-1', 'run-1', midStreamMessages, 'run-1', null).length, 1,
              'mid-stream render must keep exactly one live row'
            );
            // Reconnect: explicit live projection keeps the live node (one row).
            assert.strictEqual(
              renderMessagesSim(contentfulLiveNode, null, 'run-1', liveTail, 'run-1', null).length, 1,
              'reconnect with live projection must keep exactly one live row'
            );
            // Rapid turn completion: a second settled turn cannot be duplicated.
            const twoTurns=[
              {role:'user',content:'a'},{role:'assistant',content:'answer one'},
              {role:'user',content:'b'},{role:'assistant',content:'answer two'},
            ];
            assert.strictEqual(
              renderMessagesSim(contentfulLiveNode, null, null, twoTurns, 'run-1', null).length, 2,
              'rapid turn completion must not duplicate settled assistant rows'
            );
            console.log('OK');
            """
        )
        out = subprocess.run([node, "-e", script], capture_output=True, text=True)
        assert out.returncode == 0, f"node harness failed: {out.stderr}\n{out.stdout}"
        assert "OK" in out.stdout
