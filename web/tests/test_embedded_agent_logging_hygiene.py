import logging


def test_embedded_agent_lsp_debug_flood_is_suppressed_but_warnings_survive():
    from api.logging_hygiene import install_webui_dependency_log_floors

    lsp_logger = logging.getLogger("agent.lsp.client")
    previous_level = lsp_logger.level
    try:
        lsp_logger.setLevel(logging.DEBUG)
        install_webui_dependency_log_floors()

        assert lsp_logger.getEffectiveLevel() == logging.INFO
        assert not lsp_logger.isEnabledFor(logging.DEBUG)
        assert lsp_logger.isEnabledFor(logging.WARNING)
    finally:
        lsp_logger.setLevel(previous_level)


def test_embedded_agent_lsp_logger_preserves_stricter_operator_level():
    from api.logging_hygiene import install_webui_dependency_log_floors

    lsp_logger = logging.getLogger("agent.lsp.client")
    previous_level = lsp_logger.level
    try:
        lsp_logger.setLevel(logging.ERROR)
        install_webui_dependency_log_floors()

        assert lsp_logger.getEffectiveLevel() == logging.ERROR
    finally:
        lsp_logger.setLevel(previous_level)
