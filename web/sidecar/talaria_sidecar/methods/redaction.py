"""The already loaded Agent registry; this read never imports or discovers plugins."""


def register(registry):
    @registry.method("redaction.policy", requires_agent=False)
    def policy(ctx, params):
        return ctx.server.redaction_policy.snapshot()
