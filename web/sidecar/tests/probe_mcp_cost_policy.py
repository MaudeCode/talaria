"""Real native parser and trust gate, synthetic declarations and approval answers."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods.mcp import cost_policies
from tools import mcp_tool_costs as costs
from tools import mcp_tool_handlers as handlers
from tools.mcp_tool_common import _core
from tools.mcp_tool_scope import _server_key

package = {'paid': {'command': 'never-spawn', 'tool_costs': {'search': {'credits': [1, 3], 'note': ' estimate '}}, 'spend_limit': 5, 'cost_unit': 'credits'}}
with patch('hermes_cli.plugins.get_plugin_manager', return_value=SimpleNamespace(get_portable_mcp_servers=lambda: package)):
    native = {'paid': {'command': 'never-spawn', 'trust': 'full', 'spend_limit': 0}}
    row = cost_policies(native)['policies'][0]
    assert row['valid'] and row['can_edit'] and row['source'] == 'native_override', row
    assert row['spend_limit'] == 0 and not row['budget_enabled'], row
    assert row['tool_costs'] == [{'name': 'search', 'low': 1, 'high': 3, 'note': 'estimate'}], row
    fixture = json.loads((Path(__file__).resolve().parents[3] / 'contracts' / 'fixtures' / 'mcp-cost-policy.json').read_text())
    assert {k: v for k, v in row.items() if k != 'package_revision'} == {k: fixture[k] for k in row if k != 'package_revision'}
    assert row['field_sources'] == {'tool_costs': 'package', 'spend_limit': 'native', 'cost_unit': 'package'}, row
    assert cost_policies({})['policies'][0]['can_edit'] is False
    inherited = cost_policies({'paid': {'command': 'never-spawn'}})['policies'][0]
    assert inherited['spend_limit'] == 5 and inherited['budget_enabled'], inherited
    for field, value in [('spend_limit', -1), ('spend_limit', float('nan')), ('spend_limit', True), ('cost_unit', ' '), ('cost_unit', 'a' * 33), ('tool_costs', {'search': [3, 1]}), ('tool_costs', {'search': {'credits': 1, 'note': 7}}), ('tool_costs', {'search': {'credits': 1, 'extra': 2}})]:
        invalid = cost_policies({'paid': {'command': 'never-spawn', field: value}})['policies'][0]
        assert invalid['valid'] is False, (field, value, invalid)
    free = cost_policies({'paid': {'command': 'never-spawn', 'tool_costs': {'search': 0}}})['policies'][0]
    assert free['tool_costs'][0]['high'] == 0 and not free['budget_enabled'], free
    package['paid']['spend_limit'] = -1
    assert cost_policies({'paid': {'command': 'never-spawn', 'tool_costs': {'search': 1}}})['policies'][0]['spend_limit'] == 0
    package['paid']['spend_limit'] = 5
    # Empty table is an explicit override, omission inherits package facts.
    assert cost_policies({'paid': {'command': 'never-spawn', 'tool_costs': {}}})['policies'][0]['tool_costs'] == []

# Full trust must not bypass the real budget gate. The only replaced boundary is the human answer.
key = _server_key('synthetic-paid')
_core._server_cost_policies[key] = costs.config_cost_policy('synthetic-paid', {'tool_costs': {'search': [1, 3]}, 'spend_limit': 5})
_core._server_trust_levels[key] = _core._TRUST_FULL
answers = []
def deny(*args, **kwargs):
    answers.append(args)
    return 'decline'
with patch('tools.approval_context.get_current_session_key', return_value='synthetic-chat'), patch('tools.approval_prompt.request_elicitation_consent', side_effect=deny):
    assert handlers._trust_gate_check('synthetic-paid', 'search') is None
    refusal = handlers._trust_gate_check('synthetic-paid', 'search')
    assert refusal is not None and 'NOT run' in str(refusal), refusal
    assert len(answers) == 1, answers
    assert costs.pending_charge(key, 'synthetic-paid', 'search', 'synthetic-chat').spent() == 3
print(json.dumps({'native_parser': 'passed', 'over_limit_full_trust': 'explicit approval required', 'paid_calls': 0}))

# Invoke the registered RPC in two real profile scopes. Cached portable declarations stay private.
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods.mcp import register
from hermes_cli.plugins import get_plugin_manager

methods = {}
class Registry:
    def method(self, name):
        def decorate(fn):
            methods[name] = fn
            return fn
        return decorate
register(Registry())
for name, limit in [('a', 2), ('b', 9)]:
    home = Path(os.environ['HERMES_HOME']) / 'profiles' / name
    home.mkdir(parents=True)
    with scoped_home(home, load_plugins=False):
        get_plugin_manager()._portable_mcp_servers = {'scoped': {'command': 'never-spawn', 'tool_costs': {'search': 1}, 'spend_limit': limit}}
for name, limit in [('a', 2), ('b', 9)]:
    result = methods['mcp.cost_policies'](None, {'profile_home': str(Path(os.environ['HERMES_HOME']) / 'profiles' / name), 'servers': {}})
    assert result['policies'][0]['spend_limit'] == limit, result
