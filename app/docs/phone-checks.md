# Phone checks

Talaria's automated tests run in process: hosted presentation tests in `TalariaTests` and TalariaKit unit tests
(TAL-856). They cover what the App does with a gesture, a system sheet or a launch, but not the system delivering it.
The flows below need the real device, through a DevApps build (`$talaria-device-deploy`). Run the ones a release's
changes touch before it ships.

| Flow | Check on the phone | In-process coverage |
|---|---|---|
| Cold launch on a slow network | Relaunch with the server slow or unreachable: the last chats show at once | `SessionListHostedTests.testRelaunchShowsTheLastChatsBeforeTheServerAnswers` |
| Pending chat and project changes | Pin/unpin, rename/move, archive and Undo, then create/rename/recolor/delete a disposable project. Submitted choices say Pending while saving; refusals leave the affected action available. Confirm deletion before the row changes. | `SessionListHostedTests.testPendingPinIsVisibleBeforeTheServerAnswers`, TalariaKit `SessionListPendingChangeTests` |
| Row swipe to archive | Swipe a chat left, tap Archive, then Undo on the toast | `SessionListHostedTests.testUndoRestoresAnArchivedChat` |
| Saving transcript audio | In a chat with an audio tile, tap Export and save it to Files | `ChatHostedTests.testServerMediaRendersInsideTheMarkdownAroundIt` (the exporter opens) |
| Clarification with the keyboard up | Answer a batch clarification: the keyboard is not raised at first, the grip drags the question area, and Next stays above the keyboard once typing | `StreamHostedTests.testBatchClarificationShowsChoicesAndDeliversTypedAndMultiSelectAnswers` |
| Editing a pending steer with the keyboard up | Type a draft, then tap Edit on a pending steer: the steer joins the draft | `ChatHostedTests.testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel` |
| Long press on Show more | Hold Show more past half a second: the body expands and no message menu opens | `ChatHostedTests.testLongBodiesOpenCollapsedAndExpandInPlace` (the press resolves to the control) |
| Approval bypass chip | Turn off approval bypass from its chip: it asks first, Cancel keeps it, and confirming removes it | `ChatHostedTests.testApprovalBypassChipTurnsBypassOffForTheSession` |
| New chat that fails to start | Start a New Chat with the server refusing it: the composer says so with Retry, and Retry starts the chat | `SessionListHostedTests.testNewChatReportsAFailedStartInItsComposerAndRetries` |
| Opening a chat and its menus | Open a chat from the list: the composer offers workspace and profile, and a long press on prose, a link and a heading link each opens its own menu at the finger | — |
| Load Older | On a long chat, Load Older while toggling a Worked disclosure: the row you are reading does not move | — |
| Project filter | Filter to a project, then New Chat: the chat joins the project and stays in the list after pull to refresh | TalariaKit `SessionListLoadProfileTests`, `SessionListAutomatedVisibilityTests` |
| Chats bottom bar (iOS 26) | New Chat sits beside Search, hides while searching, and the list does not jump when Search opens or closes | — |
| Notifications sheet | The bell's sheet swipes down to dismiss; on iPad it is form width | — |
| Backgrounding mid-run | Background during a reply and return: it keeps streaming. Background, reply from Web, return: the open chat catches up | TalariaKit `ChatViewModelSendTests` live sync |
| Kill and relaunch mid-run | Kill the App during a reply and relaunch: the cached run shows with Syncing, rejoins, and finishes once | — |
| Network drop mid-run | Drop the network during a reply: the pill shows reconnecting with elapsed time, no sign-in prompt, and the run finishes once; a run that ends while offline settles to the server's transcript | TalariaKit `StreamReconnectContractTests` |
| Provider warnings | With a test provider that interrupts a stream, confirm the composer shows retry notices and the closing diagnosis; tokens and Stop still work, and a new response clears the notice | `StreamHostedTests.testProviderWarningsRemainVisibleWhileTheTurnContinues`, TalariaKit `SSEClientTests`, `ChatStreamCoordinatorTests` |
| Agent notices | In a chat whose Agent cannot load its memory provider, the warning shows above the composer with its tint, fits the phone width, and Dismiss hides it until the text changes | `ChatHostedTests.testTheAgentsNoticesShowAboveTheComposerAndDismiss`, TalariaKit `ChatViewModelSendTests`, `SSEClientTests` |
| Chat notices | In a running chat, tap Send now on a pending steer several times: one notice chip in the Agent notices' look, with an info icon, shows above the composer, fits one line, and goes after about 2.5 s or on its ×; when the run ends no notice row is added | `ChatHostedTests.testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel`, TalariaKit `ChatViewModelSendTests` |
| Background tasks | Start `/background say hi`: one "Background tasks · 1" chip shows above the composer with no notice beside it; tapping it opens a sheet with the task and its status, a finished task opens its full result, and Dismiss removes it | `ChatHostedTests.testBackgroundWorkChipOpensTheServersRecordsWithResultAndDismiss` |
| Session expiry while reconnecting | Expire the session while a reply reconnects: the App asks to sign in, then rejoins the run | TalariaKit `AuthManagerStateTests` |
| Response Complete Alerts | Turn them on (system prompt), background during a reply: the banner arrives and opens the chat | — |
| Composer | Collapse and expand; the chevron hides the strip; attach from Photos and remove from the strip; the toolsets sheet saves and restores defaults; Return, Command-Return and Control-Return on a hardware keyboard; chips at the largest text size | `ComposerChipLayoutTests`, `ComposerVoiceDraftComposerTests` |
| New chat while it starts | Type into a New Chat before its session exists: the text stays and the controls join it | TalariaKit `ChatViewModelAdoptSessionTests` |
| Links and reading width | A web link opens in-app Safari and Close keeps the chat; on iPad in landscape the transcript and composer share one centred column | TalariaKit `TranscriptLinkRouteTests` |
| Settings | Root categories and routes; notification alerts; acknowledgements; editing the server name saves on close and a failed save offers Retry; server update phases and failure; relay sync error copies; connected relay status and Disconnect | TalariaKit `AuthManagerStateTests`, `ConfigurationSyncTests`, `APIClientUpdatesApplyTests` |
| Workspace | Changes sheet and file browser load and navigate; a file diff shows the server's hunks; file preview actions; Files opens beside the chat on iPad and pushes on iPhone; Memory and Files headers at the largest text size | TalariaKit `GitWorkspaceViewModelTests`, `APIClientWorkspaceFileTests` |
| Agent panels | Tasks, Kanban, Memory, Skills and Insights load, show a failure and retry; an open Tasks list catches up after the App returns; Refresh keeps its bar while loading; Insights shows quotas | TalariaKit `CronManagementTests`, `SkillsViewModelTests`, `InsightsViewModelTests`, `LiveUpdatesTests` |
| App entry | New Chat intent and deep links open their own screens; a share arriving while backgrounded reaches the composer once; theme and App icon pickers apply; re-authentication offers SSO first and a trusted-header retry | `AppIntentNewChatTests`, TalariaKit `SharedDraftStoreTests`, `AuthManagerStateTests` |
| Share extension | Share text, a URL and attachments: they reach the composer once; a refused or unopened share explains itself | TalariaKit `ShareInputReaderTests`, `SharedDraftStoreTests` |
| iPad regular width | Chats keep the list and search beside the chat; Settings, Memory, Skills and Tasks list beside their selection; Kanban and Insights fill the width; the scheduled and archived lists keep their chat; rotating across the size class keeps the section and item | TalariaKit `AppSectionLayoutTests`, `SessionNavigationStateTests` |
| Sidebar | Open, close and New Chat from the sidebar; the edge swipe goes back in pushed screens and opens the sidebar at roots, mirrored in RTL; the pinned quota sits above Settings | `SidebarEdgePanGestureTests`, `ProviderQuotaWidgetTests` |
| Accessibility | VoiceOver and the largest text size on the core screens, in light, dark and RTL; onboarding keeps a readable column and its titles scale | — |
| Performance | Cold and warm launch, opening and scrolling a dense transcript, long bodies, repeated open and dismiss, and closing the sidebar stay within `performance-budgets.md` in Instruments | `PerformanceBudgetTests`, `ReplayCatchUpPerformanceTests` |
