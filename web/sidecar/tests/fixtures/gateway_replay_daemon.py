"""Ordinary test daemon with a deliberately small production replay ring."""
import runpy

from tui_gateway import event_replay

event_replay._REPLAY_BUFFER_MAX = 2
runpy.run_module("gateway.run", run_name="__main__")
