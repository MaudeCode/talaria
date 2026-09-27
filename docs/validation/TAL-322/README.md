# TAL-322 visual validation

Synthetic server-owned records exercised the production notification contract without running an update.

- `web-notification-center.png` shows the persistent acknowledgement action in Talaria Web.
- `ios-notification-center.png` shows the same actionable record in the iPhone notification center.

The Web capture used the isolated local server and browser fixture. The iOS capture used the Debug-only
`--ui-test-fixture --ui-test-update-notifications` launch arguments on an iPhone simulator. No live account,
update installation, or user content appears in these artifacts.
