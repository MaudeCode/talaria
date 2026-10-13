/** Embedded Agent imports must never install dependencies or replace their host process. */
export const AGENT_IMPORT_ENV = { HERMES_DISABLE_LAZY_INSTALLS: '1' }
