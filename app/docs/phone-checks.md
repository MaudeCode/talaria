# Phone checks

Talaria's automated tests run in process: hosted presentation tests in `TalariaTests` and TalariaKit unit tests
(TAL-856). They cover what the App does with a gesture, a system sheet or a launch, but not the system delivering it.
The flows below need the real device, through a DevApps build (`$talaria-device-deploy`). Run the ones a release's
changes touch before it ships.

| Flow | Check on the phone | In-process coverage |
|---|---|---|
| Cold launch on a slow network | Relaunch with the server slow or unreachable: the last chats show at once | `SessionListHostedTests.testRelaunchShowsTheLastChatsBeforeTheServerAnswers` |
| Row swipe to archive | Swipe a chat left, tap Archive, then Undo on the toast | `SessionListHostedTests.testUndoRestoresAnArchivedChat` |
