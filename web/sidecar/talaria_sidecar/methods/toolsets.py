"""Profile toolset policy and catalog. All callers run under ``scoped_home``."""

from __future__ import annotations

from ..errors import InvalidParams
from ..home import profile_home_param, scoped_home
from .. import harness_toolset, talaria_toolset

# Registry-only toolsets the Agent would describe as "Plugin toolset: <name>".
_OWN_DESCRIPTIONS = {talaria_toolset.TOOLSET: talaria_toolset.TOOLSET_DESCRIPTION, harness_toolset.TOOLSET: harness_toolset.TOOLSET_DESCRIPTION}


def disabled_toolsets(cfg: dict | None = None) -> list[str]:
    from agent.skill_utils import parse_config_string_list
    from hermes_cli.config import load_config

    section = ((load_config() or {}) if cfg is None else cfg).get('agent') or {}
    return [name.strip() for name in parse_config_string_list(section.get('disabled_toolsets')) if name.strip()]


def catalog(override) -> dict:
    from hermes_cli import tools_config
    from hermes_cli.plugins import discover_plugins
    from model_tools import get_tool_definitions
    import toolsets
    from toolsets import get_all_toolsets, resolve_toolset
    from .chat import _profile_toolsets
    from .commands import discover_profile_mcp_tools

    discover_plugins()
    discover_profile_mcp_tools()
    definitions = get_all_toolsets()
    disabled = disabled_toolsets()
    effective_disabled = toolsets.session_disabled_toolsets(disabled, "webui")
    defaults = _profile_toolsets()
    selected = defaults if override is None else list(dict.fromkeys(override))
    # Resolve once through the same Agent filter used at execution, before deferred-tool assembly.
    tools = {item['function']['name'] for item in get_tool_definitions(
        enabled_toolsets=list(definitions), disabled_toolsets=effective_disabled,
        quiet_mode=True, skip_tool_search_assembly=True,
    )}
    names = set(definitions) | set(selected)
    # The configured entries only: platform gating is not a setting the operator can repair.
    stripped = tools_config.toolsets_partially_stripped({'agent': {'disabled_toolsets': disabled}}, names)
    rows = []
    for name in sorted(names):
        available = name in definitions and name not in disabled and bool(set(resolve_toolset(name)) & tools)
        stripped_tools, stripped_by, *_ = stripped.get(name, ([], []))
        # A toolset an entry empties is disabled, whether or not the entry names it (legacy ``vision_tools``).
        wholly_disabled = name in disabled or (bool(stripped_tools) and set(resolve_toolset(name)) <= set(stripped_tools))
        rows.append({
            'name': name, 'description': _OWN_DESCRIPTIONS.get(name) or str(definitions.get(name, {}).get('description') or ''),
            'available': available, 'selected': name in selected,
            'unavailable_reason': None if available else 'disabled' if wholly_disabled else 'unavailable',
            'stripped_tools': [] if wholly_disabled else list(stripped_tools),
            'stripped_by': [] if wholly_disabled else list(stripped_by),
            'group': 'available' if available else 'not_available',
        })
    return {'toolsets': rows, 'selected_toolsets': selected, 'using_defaults': override is None, 'default_toolsets': list(defaults)}


# TAL-2282: Talaria's own toolsets. ``talaria`` is an entry in ``platform_toolsets.cli`` that the Agent keeps as written;
# ``harness`` is on unless ``agent.disabled_toolsets`` names it (TAL-1963).
_OWN = (talaria_toolset.TOOLSET, harness_toolset.TOOLSET)


def _checklist() -> set[str]:
    """The toolsets the defaults editor sets: what ``hermes tools`` offers for ``cli``, plus Talaria's own."""
    from hermes_cli import tools_config

    return tools_config._checklist_toolset_keys('cli') | set(_OWN)


def defaults() -> dict:
    """The profile's default toolsets as an editor shows them. A toolset ``agent.disabled_toolsets`` turns off is just off
    here: choosing it clears that entry, as ``hermes tools`` does. MCP servers keep their own controls."""
    result = catalog(None)
    editable = _checklist()
    rows = []
    for row in result['toolsets']:
        if row['name'] not in editable:
            continue
        if row['unavailable_reason'] == 'disabled':
            row = {**row, 'available': True, 'unavailable_reason': None, 'group': 'available'}
        rows.append(row)
    return {**result, 'toolsets': rows}


def set_default(name, enabled) -> dict:
    """Turn one toolset on or off in the profile's saved defaults, read fresh, so each write changes only its own toolset."""
    if not isinstance(name, str) or not isinstance(enabled, bool):
        raise InvalidParams('name must be a toolset name and enabled a boolean')
    current = defaults()  # discovers the profile's plugins, so their toolsets are choices too
    if name not in _checklist():
        raise InvalidParams(f'unknown toolset: {name}')
    chosen = [row['name'] for row in current['toolsets'] if row['selected'] and row['name'] != name]
    _save_defaults(chosen + [name] if enabled else chosen)
    return defaults()


def _save_defaults(names: list[str]) -> None:
    """Save ``names`` as the profile's ``platform_toolsets.cli`` with the Agent's own ``hermes tools`` saver, which keeps
    MCP server entries and clears the ``agent.disabled_toolsets`` entries a chosen toolset covers."""
    from agent.skill_utils import parse_config_string_list
    from hermes_cli import tools_config
    from hermes_cli.config import load_config

    config = load_config()
    platforms = config.get('platform_toolsets') if isinstance(config.get('platform_toolsets'), dict) else {}
    saved = tools_config._coerce_platform_toolsets_value(platforms.get('cli'), 'cli')
    talaria = talaria_toolset.TOOLSET
    platforms['cli'] = [entry for entry in (saved if isinstance(saved, list) else []) if entry != talaria] + ([talaria] if talaria in names else [])
    config['platform_toolsets'] = platforms
    agent = config.get('agent') if isinstance(config.get('agent'), dict) else {}
    disabled = [name for name in parse_config_string_list(agent.get('disabled_toolsets')) if name not in _OWN or name not in names]
    if harness_toolset.TOOLSET not in names and harness_toolset.TOOLSET not in disabled:
        disabled.append(harness_toolset.TOOLSET)
    config['agent'] = {**agent, 'disabled_toolsets': disabled}
    tools_config._save_platform_tools(config, 'cli', set(names) - set(_OWN))  # also saves the config


def register(registry) -> None:
    @registry.method('toolsets.catalog')
    def catalog_(ctx, params):
        with scoped_home(profile_home_param(params)):
            return catalog(params.get('enabled_toolsets'))

    @registry.method('toolsets.defaults')
    def defaults_(ctx, params):
        with scoped_home(profile_home_param(params)):
            return defaults()

    @registry.method('toolsets.set_default')
    def set_default_(ctx, params):
        with scoped_home(profile_home_param(params)):
            return set_default(params.get('name'), params.get('enabled'))
