# Private native passthrough fields

`gateway.groups.value` carries the private native group response from
`gateway/session_group_controls.py` and
`gateway/session_hosted_attachments.py`. Its operation-specific variants evolve
with supported Agent releases. It never crosses the HTTP boundary. The server
parses capabilities, rooms, state, log events and attachment metadata through
the typed schemas in `packages/contracts/src/groups-native.ts`, validates write
receipts, and emits only `GroupCatalog`, `GroupView` and `GroupWriteResult`.

The public transcript reuses `MessageSchema` and `AttachmentSchema`; discussion
attachments add the server-authenticated `download_url` alongside the existing
message attachment presentation fields.
