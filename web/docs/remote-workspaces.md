# Remote Terminal Workspaces

How Talaria Web treats workspaces for profiles whose terminal runs on another
host (SSH, Docker, or any non-local backend). The logic lives in
`packages/server/src/workspace/workspaces.ts`.

---

## 1. Overview

A profile is remote when its `config.yaml` sets `terminal.backend` to anything
other than `local` (`isRemoteTerminalBackend`). Its working directory
(`terminal.cwd`) then lives on the target host, not on the Talaria Web host.
The server never resolves such a path against its own filesystem: on macOS,
host resolution would expand synthetic firmlinks (for example `/home/<user>`
to `/System/Volumes/Data/home/<user>`) and produce a path that exists on
neither side.

---

## 2. Path resolution

1. **Target-side POSIX paths are kept verbatim.**
   `remoteTerminalWorkspaceCandidate` accepts a path at or beneath the
   profile's `terminal.cwd` after POSIX normalization and returns it without
   any host-local lookup. Traversal outside `terminal.cwd`, null bytes, and
   blocked system roots (`/etc`, `/usr`, `/var`, `/bin`, `/sbin`, `/boot`,
   `/proc`, `/sys`, `/dev`, `/lib`, `/lib64`, and the macOS system roots) are
   rejected.
2. **Remote recognition is scoped to one profile.** A path is remote only for
   the profile whose `terminal.cwd` contains it. A local profile never treats
   another profile's target-side path as remote.
3. **Defaults follow the backend.** For a remote profile, the configured
   `workspace`, `default_workspace`, or `terminal.cwd` is returned as written;
   for a local profile it must exist as a host directory.
4. **Saved workspace lists are filtered.** Loading a remote profile's
   workspace list keeps target-side entries under `terminal.cwd` and drops
   host-local entries.

---

## 3. Host isolation

`profileSupportsLocalIo(profile)` decides whether an operation may touch the
Talaria Web host filesystem. It answers `false` for a remote backend and also
fails closed while the profile's config is unresolved. Operations owned by a
session use the session's profile, never the ambient active profile.

When it answers `false`:

- workspace file operations, Git and worktree controls, live media serving,
  and `session/new` with an explicit `worktree` answer 400
  `remote_workspace_unsupported`; a worktree requested only by the profile's
  default is skipped and the session starts as a plain session;
- the embedded terminal answers 400 `remote_terminal_backend_unsupported`;
- project-context discovery, workspace suggestions, and media snapshot capture
  return an empty result;
- `terminal_remote_backend` is `true` in the bootstrap `features` and the
  workspace list, so clients hide host-only controls.

Chat keeps working: the profile's remote terminal backend owns the target-side
paths and runs the tools there.
