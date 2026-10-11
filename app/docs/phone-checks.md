# Phone checks

Talaria's automated tests run in process: hosted presentation tests in `TalariaTests` and TalariaKit unit tests
(TAL-856). They cover what the App does with a gesture, a system sheet or a launch, but not the system delivering it.
The flows below need the real device, through a DevApps build (`$talaria-device-deploy`). Run the ones a release's
changes touch before it ships.

| Flow | Check on the phone | In-process coverage |
|---|---|---|
| Cold launch on a slow network | Relaunch with the server slow or unreachable: the last chats show at once | `SessionListHostedTests.testRelaunchShowsTheLastChatsBeforeTheServerAnswers` |
| Row swipe to archive | Swipe a chat left, tap Archive, then Undo on the toast | `SessionListHostedTests.testUndoRestoresAnArchivedChat` |
| Saving transcript audio | In a chat with an audio tile, tap Export and save it to Files | `ChatHostedTests.testServerMediaRendersInsideTheMarkdownAroundIt` (the exporter opens) |
| Clarification with the keyboard up | Answer a batch clarification: the keyboard is not raised at first, the grip drags the question area, and Next stays above the keyboard once typing | `StreamHostedTests.testBatchClarificationShowsChoicesAndDeliversTypedAndMultiSelectAnswers` |
| Editing a pending steer with the keyboard up | Type a draft, then tap Edit on a pending steer: the steer joins the draft | `ChatHostedTests.testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel` |
