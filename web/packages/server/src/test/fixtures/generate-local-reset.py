"""Regenerate local-reset.json on the exact v0.22.1 Agent interpreter with its checkout on PYTHONPATH."""
import json, tempfile
from pathlib import Path
from dataclasses import asdict
from datetime import datetime, timezone
from hermes_state import SessionDB
import hermes_state_runtime as rt
from hermes_state_local import commit_local_session, local_receipt
from hermes_state_local_lineage import reset_local_target
from hermes_state_keys import local_identity
from gateway.config import Platform
from gateway.session import SessionEntry, SessionSource
from gateway.session_policy import build_policy

snapshots = {}
with tempfile.TemporaryDirectory() as directory:
    db = SessionDB(Path(directory) / 'state.db')
    epoch = rt.begin_runtime_epoch(db, instance_id='fixture')
    owner = local_identity('default','synthetic-human','tal-1035')
    origin = SessionSource(platform=Platform.LOCAL, chat_id=owner,user_id='synthetic-human',chat_type='dm')
    entry = SessionEntry('local:'+owner,owner,datetime(2026,1,1,tzinfo=timezone.utc),datetime(2026,1,1,tzinfo=timezone.utc),origin=origin,platform=Platform.LOCAL)
    policy = build_policy({'source':'cli','cwd':directory,'model':'fixture','toolsets':[]},{'platform_toolsets':{'cli':[]}},private_secrets={})
    commit_local_session(db, epoch=epoch,receipt={'profile_id':'default','principal_id':'synthetic-human','request_id':'tal-1035','session_id':owner,'route':entry.session_key,'entry':entry.to_dict(),'policy':asdict(policy)})
    db.set_session_title(owner,'Reset conversation')
    db.append_message(owner,'user','before reset',timestamp=1001)
    def reset(parent, child):
        saved = local_receipt(db,owner)['entry']
        reset_local_target(db,epoch=epoch,parent_session_id=parent,entry=dict(saved,session_id=child,is_fresh_reset=True))
    def snapshot(name):
        with db._read_ctx() as c:
            snapshots[name] = {'sessions':[dict(r) for r in c.execute('SELECT id,source,user_id,session_key,chat_id,model,title,started_at,last_activity_at,message_count,parent_session_id,ended_at,end_reason,model_config FROM sessions ORDER BY rowid')], 'messages':[dict(r) for r in c.execute('SELECT id,session_id,role,content,timestamp FROM messages ORDER BY id')], 'meta':[dict(r) for r in c.execute("SELECT key,value FROM state_meta WHERE key GLOB 'gateway.local*'")]}
        snapshots[name]['listedIds']=[r['id'] for r in db.list_sessions_rich(limit=50)]
    reset(owner,'reset-one')
    db.append_message('reset-one','user','after reset',timestamp=1002)
    snapshot('reset')
    db.publish_compression_child(parent_session_id='reset-one', child_session_id='compressed',source='cli',messages=[{'role':'user','content':'compressed context','timestamp':1003}],require_compression_lease=False)
    reset('compressed','reset-empty')
    snapshot('empty')
    db.append_message('reset-empty','user','latest context',timestamp=1004)
    snapshot('multiple')
    db.close()
print(json.dumps({'agentRevision':'297552a9d646119871391d202509822cd86330df','owner':owner,'snapshots':snapshots},indent=2))
