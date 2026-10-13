"""Profile toolset policy and catalog. All callers run under ``scoped_home``."""

from ..home import profile_home_param, scoped_home


def disabled_toolsets() -> list[str]:
    from agent.skill_utils import parse_config_string_list
    from hermes_cli.config import load_config

    section = (load_config() or {}).get('agent') or {}
    return [name.strip() for name in parse_config_string_list(section.get('disabled_toolsets')) if name.strip()]


def catalog(override) -> dict:
    from model_tools import get_tool_definitions
    import toolsets
    from toolsets import get_all_toolsets, resolve_toolset
    from .chat import _profile_toolsets

    definitions = get_all_toolsets()
    disabled = disabled_toolsets()
    platform_policy = getattr(toolsets, "session_disabled_toolsets", None)
    effective_disabled = platform_policy(disabled, "webui") if platform_policy else disabled
    selected = _profile_toolsets() if override is None else list(dict.fromkeys(override))
    # Resolve once through the same Agent filter used at execution, before deferred-tool assembly.
    tools = {item['function']['name'] for item in get_tool_definitions(
        enabled_toolsets=list(definitions), disabled_toolsets=effective_disabled,
        quiet_mode=True, skip_tool_search_assembly=True,
    )}
    rows = []
    for name in sorted(set(definitions) | set(selected)):
        available = name in definitions and name not in disabled and bool(set(resolve_toolset(name)) & tools)
        rows.append({
            'name': name, 'description': str(definitions.get(name, {}).get('description') or ''),
            'available': available, 'selected': name in selected,
            'unavailable_reason': None if available else 'disabled' if name in disabled else 'unavailable',
        })
    return {'toolsets': rows, 'selected_toolsets': selected, 'using_defaults': override is None}


def register(registry) -> None:
    @registry.method('toolsets.catalog')
    def catalog_(ctx, params):
        with scoped_home(profile_home_param(params)):
            return catalog(params.get('enabled_toolsets'))
