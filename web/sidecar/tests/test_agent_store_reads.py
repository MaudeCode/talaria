"""TAL-2591: the sidecar's stored-transcript readers through the installed Agent's own store (its storage interface from
v0.23.3): a skill replay case's recorded conversation, and a subagent's multimodal first message read back as its goal.
Pinned Agent, in its interpreter."""

from __future__ import annotations

from conftest import requires_agent, run_store_script

pytestmark = requires_agent


def test_a_replay_case_reads_its_recorded_conversation_and_prompt(hermes_home) -> None:
    run_store_script(hermes_home, """
        import sqlite3
        from talaria_sidecar.methods.skill_replay import _fixture

        call = {'id': 'call-1', 'type': 'function', 'function': {'name': 'send_email', 'arguments': '{"to": "x"}'}}
        db.create_session(session_id='recorded', source='cli')
        (store.sessions if store else db).update_system_prompt('recorded', 'Synthetic system prompt.')
        db.append_message('recorded', 'user', 'Email the summary')
        db.append_message('recorded', 'assistant', '', tool_calls=[call])
        db.append_message('recorded', 'tool', 'sent', tool_call_id='call-1', tool_name='send_email')
        db.append_message('recorded', 'assistant', 'Done')
        db.append_message('recorded', 'user', 'Thanks')
        db.append_message('recorded', 'assistant', 'Anytime')
        with sqlite3.connect(HOME / 'state.db') as conn:
            ids = [row[0] for row in conn.execute("SELECT id FROM messages WHERE session_id = 'recorded' ORDER BY id")]
        fixture = _fixture(HOME, {'id': 'case', 'session_id': 'recorded', 'message_id': str(ids[4]), 'mode': 'plan'})
        assert fixture['system'] == 'Synthetic system prompt.', fixture['system']
        assert [(m['role'], m['content']) for m in fixture['messages']] == [
            ('user', 'Email the summary'), ('assistant', ''), ('tool', 'sent'), ('assistant', 'Done'), ('user', 'Thanks')], fixture['messages']
        assert fixture['messages'][1]['tool_calls'][0]['function']['name'] == 'send_email'
    """, sidecar=True)


def test_a_multimodal_first_message_reads_as_its_goal(hermes_home) -> None:
    run_store_script(hermes_home, """
        import sqlite3
        from talaria_sidecar.methods.process import _goal_text

        image = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}
        db.create_session(session_id='child', source='subagent')
        db.append_message('child', 'user', [{'type': 'text', 'text': 'Describe it'}, image])
        with sqlite3.connect(HOME / 'state.db') as conn:
            stored = conn.execute("SELECT content FROM messages WHERE session_id = 'child'").fetchone()[0]
        assert stored.startswith('\\x00json:'), stored
        assert _goal_text(stored) == 'Describe it'
    """, sidecar=True)
