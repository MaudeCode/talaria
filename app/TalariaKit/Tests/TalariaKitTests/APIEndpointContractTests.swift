import os
import XCTest
@testable import TalariaKit

final class ContractReadinessTests: APIClientTestCase {
    @MainActor
    func testBlueprintPickFillAndEditorDraftUseServerFields() async throws {
        let catalogLoads = OSAllocatedUnfairLock(initialState: 0)
        let client = makeClient { request in
            let json: String
            if request.url!.path == "/api/cron/blueprints" {
                XCTAssertEqual(request.httpMethod, "GET")
                catalogLoads.withLock { $0 += 1 }
                json = #"{"blueprints":[{"key":"team:brief","title":"Team brief","description":"A digest","category":"daily","source":"plugin","plugin":"team","schedule_label":"Daily","slots":[{"name":"topic","type":"text","label":"Topic","default":null,"options":[],"optional":false,"strict":true,"help":""}],"future":true}]}"#
            } else if request.url!.path == "/api/cron/blueprints/fill" {
                XCTAssertEqual(request.httpMethod, "POST")
                let body = try JSONSerialization.jsonObject(with: apiTestBodyData(from: request)!) as! [String: Any]
                XCTAssertEqual(body["key"] as? String, "team:brief")
                XCTAssertEqual(body["values"] as? [String: String], ["topic": "releases"])
                json = #"{"draft":{"name":"Team brief","prompt":"Server-filled releases","schedule":"30 8 * * *","deliver":"local","skills":["summary"],"future":true}}"#
            } else {
                json = "{}"
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, Data(json.utf8))
        }
        let catalogs = CronJobEditorCatalogs(client: client, includesBlueprints: true)
        await catalogs.load()
        await catalogs.load()
        XCTAssertEqual(catalogLoads.withLock { $0 }, 2, "Retries keep the create-only catalog option")
        let blueprint = try XCTUnwrap(catalogs.blueprints.first)
        XCTAssertEqual(blueprint.plugin, "team")
        XCTAssertEqual(blueprint.scheduleLabel, "Daily")
        catalogs.selectBlueprint(blueprint)
        catalogs.blueprintValues["topic"] = "releases"
        let filled = await catalogs.fillBlueprint()
        let draft = try XCTUnwrap(filled)
        XCTAssertEqual(draft.prompt, "Server-filled releases")
        XCTAssertEqual(draft.schedule, "30 8 * * *")
        XCTAssertEqual(draft.deliver, "local")
        XCTAssertEqual(draft.skills, ["summary"])
        XCTAssertNil(draft.validationMessage)
        var existing = CronJobEditorDraft(model: "chosen-model", profile: "work", toastNotifications: false)
        existing.applyBlueprint(draft)
        XCTAssertEqual(existing.prompt, draft.prompt)
        XCTAssertEqual(existing.skills, draft.skills)
        XCTAssertEqual(existing.model, "chosen-model")
        XCTAssertEqual(existing.profile, "work")
        XCTAssertFalse(existing.toastNotifications)
        catalogs.selectBlueprint(nil)
        XCTAssertNil(catalogs.selectedBlueprint)
        XCTAssertTrue(catalogs.blueprintValues.isEmpty)
    }

    @MainActor
    func testBlueprintFillFailureKeepsSlotsForCorrection() async throws {
        let client = makeClient { request in
            if request.url!.path == "/api/cron/blueprints/fill" {
                return (HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":"invalid time"}"#.utf8))
            }
            let root = try JSONSerialization.jsonObject(with: sharedContractFixture("cron-blueprints")) as! [String: Any]
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, try JSONSerialization.data(withJSONObject: root["catalog"]!))
        }
        let catalogs = CronJobEditorCatalogs(client: client, includesBlueprints: true)
        await catalogs.load()
        catalogs.selectBlueprint(try XCTUnwrap(catalogs.blueprints.first))
        catalogs.blueprintValues["time"] = "25:99"
        let draft = await catalogs.fillBlueprint()
        XCTAssertNil(draft)
        XCTAssertEqual(catalogs.blueprintValues["time"], "25:99")
        XCTAssertNotNil(catalogs.selectedBlueprint)
        XCTAssertTrue(catalogs.blueprintErrorMessage?.contains("invalid time") == true)
        XCTAssertFalse(catalogs.isFillingBlueprint)
    }

    func testSharedBlueprintFixturesDecodeBothRoutes() throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("cron-blueprints")) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let catalog = try decoder.decode(CronBlueprintsResponse.self, from: JSONSerialization.data(withJSONObject: root["catalog"]!))
        XCTAssertTrue(catalog.blueprints.contains { $0.key == "morning-brief" && $0.source == "builtin" })
        let fill = try decoder.decode(CronBlueprintFillResponse.self, from: JSONSerialization.data(withJSONObject: root["fill"]!))
        XCTAssertEqual(fill.draft.schedule, "30 8 * * *")
        XCTAssertFalse(fill.draft.prompt.isEmpty)
    }

    func testEndpointContractMatrixMatchesPinnedUpstreamPathsAndQueries() throws {
        let contracts: [EndpointContract] = [
            .init(name: "health", endpoint: .health, path: "/health"),
            .init(name: "auth status", endpoint: .authStatus, path: "/api/auth/status"),
            .init(name: "login", endpoint: .login, path: "/api/auth/login"),
            .init(name: "logout", endpoint: .logout, path: "/api/auth/logout"),
            .init(name: "native OIDC start", endpoint: .nativeOIDCStart, path: "/api/auth/oidc/native/start"),
            .init(name: "native OIDC exchange", endpoint: .nativeOIDCExchange, path: "/api/auth/oidc/native/exchange"),
            .init(name: "native OIDC cancel", endpoint: .nativeOIDCCancel, path: "/api/auth/oidc/native/cancel"),
            .init(name: "sessions", endpoint: .sessions(), path: "/api/sessions"),
            .init(
                name: "sessions including archived",
                endpoint: .sessions(includeArchived: true, archivedLimit: 3),
                path: "/api/sessions",
                query: ["include_archived": "1", "archived_limit": "3"]
            ),
            .init(
                name: "sessions including archived without limit",
                endpoint: .sessions(includeArchived: true),
                path: "/api/sessions",
                query: ["include_archived": "1"]
            ),
            .init(
                name: "session search",
                endpoint: .sessionsSearch(query: "billing plan", content: true, depth: 5),
                path: "/api/sessions/search",
                query: ["q": "billing plan", "content": "1", "depth": "5"]
            ),
            .init(
                name: "session search within the sidebar filters",
                endpoint: .sessionsSearch(
                    query: "billing plan",
                    content: true,
                    depth: 5,
                    projectID: "project-1",
                    visibility: AutomatedSessionVisibility(showsCron: false, showsCli: true)
                ),
                path: "/api/sessions/search",
                query: [
                    "q": "billing plan", "content": "1", "depth": "5", "project_id": "project-1", "include_archived": "0",
                    "show_cli_sessions": "1", "show_claude_code_sessions": "1", "show_cron_sessions": "0", "show_webhook_sessions": "1"
                ]
            ),
            .init(
                name: "session detail",
                endpoint: .session(id: "session-123", includeMessages: true, messageLimit: 50, messageBefore: 100),
                path: "/api/session",
                query: ["session_id": "session-123", "messages": "1", "msg_limit": "50", "msg_before": "100"]
            ),
            .init(
                name: "session detail cold load expand_renderable",
                endpoint: .session(id: "session-123", includeMessages: true, messageLimit: 50, messageBefore: nil, expandRenderable: true),
                path: "/api/session",
                query: ["session_id": "session-123", "messages": "1", "msg_limit": "50", "expand_renderable": "1"]
            ),
            .init(
                name: "session status",
                endpoint: .sessionStatus(id: "session-123"),
                path: "/api/session/status",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "tool result",
                endpoint: .toolResult(sessionID: "session-123", toolCallID: "call-1"),
                path: "/api/session/tool-result",
                query: ["session_id": "session-123", "tool_call_id": "call-1"]
            ),
            .init(name: "new session", endpoint: .newSession, path: "/api/session/new"),
            .init(name: "execution modes", endpoint: .executionModes, path: "/api/session/execution-modes"),
            .init(name: "rename session", endpoint: .renameSession, path: "/api/session/rename"),
            .init(name: "delete session", endpoint: .deleteSession, path: "/api/session/delete"),
            .init(name: "pin session", endpoint: .pinSession, path: "/api/session/pin"),
            .init(name: "archive session", endpoint: .archiveSession, path: "/api/session/archive"),
            .init(name: "bulk sessions", endpoint: .bulkSessions, path: "/api/sessions/bulk"),
            .init(name: "branch session", endpoint: .branchSession, path: "/api/session/branch"),
            .init(name: "start session compression", endpoint: .compressSessionStart, path: "/api/session/compress/start"),
            .init(
                name: "session compression status",
                endpoint: .compressSessionStatus(id: "session-123"),
                path: "/api/session/compress/status",
                query: ["session_id": "session-123"]
            ),
            .init(name: "clear session", endpoint: .clearSession, path: "/api/session/clear"),
            .init(name: "undo session", endpoint: .undoSession, path: "/api/session/undo"),
            .init(name: "retry session", endpoint: .retrySession, path: "/api/session/retry"),
            .init(name: "truncate session", endpoint: .truncateSession, path: "/api/session/truncate"),
            .init(name: "update session", endpoint: .updateSession, path: "/api/session/update"),
            .init(name: "move session", endpoint: .moveSession, path: "/api/session/move"),
            .init(
                name: "session yolo",
                endpoint: .sessionYolo(sessionID: "session-123"),
                path: "/api/session/yolo",
                query: ["session_id": "session-123"]
            ),
            .init(name: "toolset catalog", endpoint: .toolsetsCatalog, path: "/api/toolsets"),
            .init(name: "session toolsets", endpoint: .sessionToolsets, path: "/api/session/toolsets"),
            .init(name: "projects", endpoint: .projects, path: "/api/projects"),
            .init(name: "create project", endpoint: .createProject, path: "/api/projects/create"),
            .init(name: "rename project", endpoint: .renameProject, path: "/api/projects/rename"),
            .init(name: "delete project", endpoint: .deleteProject, path: "/api/projects/delete"),
            .init(name: "chat start", endpoint: .chatStart, path: "/api/chat/start"),
            .init(
                name: "chat stream",
                endpoint: .chatStream(streamID: "stream-123"),
                path: "/api/chat/stream",
                query: ["stream_id": "stream-123"]
            ),
            .init(
                name: "chat cancel",
                endpoint: .chatCancel(streamID: "stream-123"),
                path: "/api/chat/cancel",
                query: ["stream_id": "stream-123"]
            ),
            .init(
                name: "chat stream status",
                endpoint: .chatStreamStatus(streamID: "stream-123"),
                path: "/api/chat/stream/status",
                query: ["stream_id": "stream-123"]
            ),
            .init(name: "chat steer", endpoint: .chatSteer, path: "/api/chat/steer"),
            .init(name: "chat steer withdraw", endpoint: .chatSteerWithdraw, path: "/api/chat/steer/withdraw"),
            .init(name: "chat steer send now", endpoint: .chatSteerSendNow, path: "/api/chat/steer/send-now"),
            .init(name: "chat owner action", endpoint: .chatOwnerAction, path: "/api/chat/owner-action"),
            .init(name: "goal", endpoint: .submitGoal, path: "/api/goal"),
            .init(
                name: "approval pending",
                endpoint: .approvalPending(sessionID: "session-123"),
                path: "/api/approval/pending",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "approval stream",
                endpoint: .approvalStream(sessionID: "session-123"),
                path: "/api/approval/stream",
                query: ["session_id": "session-123"]
            ),
            .init(name: "approval respond", endpoint: .approvalRespond, path: "/api/approval/respond"),
            .init(
                name: "clarification pending",
                endpoint: .clarifyPending(sessionID: "session-123"),
                path: "/api/clarify/pending",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "clarification stream",
                endpoint: .clarifyStream(sessionID: "session-123"),
                path: "/api/clarify/stream",
                query: ["session_id": "session-123"]
            ),
            .init(name: "clarification respond", endpoint: .clarifyRespond, path: "/api/clarify/respond"),
            .init(name: "btw", endpoint: .btw, path: "/api/btw"),
            .init(name: "background", endpoint: .background, path: "/api/background"),
            .init(
                name: "background tasks",
                endpoint: .backgroundTasks(sessionID: "session-123"),
                path: "/api/background/tasks",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "background result",
                endpoint: .backgroundResult(sessionID: "session-123", taskID: "task-1"),
                path: "/api/background/result",
                query: ["session_id": "session-123", "task_id": "task-1"]
            ),
            .init(name: "background dismiss", endpoint: .backgroundDismiss, path: "/api/background/dismiss"),
            .init(name: "workspaces", endpoint: .workspaces, path: "/api/workspaces"),
            .init(
                name: "workspace suggestions",
                endpoint: .workspaceSuggestions(prefix: "/Users/tester"),
                path: "/api/workspaces/suggest",
                query: ["prefix": "/Users/tester"]
            ),
            .init(name: "workspace add", endpoint: .workspaceAdd, path: "/api/workspaces/add"),
            .init(name: "workspace remove", endpoint: .workspaceRemove, path: "/api/workspaces/remove"),
            .init(name: "workspace rename", endpoint: .workspaceRename, path: "/api/workspaces/rename"),
            .init(name: "workspace reorder", endpoint: .workspaceReorder, path: "/api/workspaces/reorder"),
            .init(
                name: "directory list root",
                endpoint: .directoryList(sessionID: "session-123", path: nil),
                path: "/api/list",
                query: ["session_id": "session-123"]
            ),
            .init(
                name: "directory list nested",
                endpoint: .directoryList(sessionID: "session-123", path: "Sources/App.swift"),
                path: "/api/list",
                query: ["session_id": "session-123", "path": "Sources/App.swift"]
            ),
            .init(
                name: "file",
                endpoint: .file(sessionID: "session-123", path: "Sources/App.swift"),
                path: "/api/file",
                query: ["session_id": "session-123", "path": "Sources/App.swift"]
            ),
            .init(
                name: "raw file",
                endpoint: .rawFile(sessionID: "session-123", path: "Assets/icon.png"),
                path: "/api/file/raw",
                query: ["session_id": "session-123", "path": "Assets/icon.png"]
            ),
            .init(name: "models", endpoint: .models, path: "/api/models"),
            .init(name: "models live", endpoint: .modelsLive, path: "/api/models/live"),
            .init(name: "commands", endpoint: .commands, path: "/api/commands"),
            .init(name: "default model", endpoint: .defaultModel, path: "/api/default-model"),
            .init(name: "auxiliary models", endpoint: .auxiliaryModels, path: "/api/model/auxiliary"),
            .init(name: "model set", endpoint: .setModel, path: "/api/model/set"),
            .init(name: "reasoning read", endpoint: .reasoning(), path: "/api/reasoning"),
            .init(
                name: "reasoning read scoped to model",
                endpoint: .reasoning(model: "gpt-5.4", provider: "openai"),
                path: "/api/reasoning",
                query: ["model": "gpt-5.4", "provider": "openai"]
            ),
            .init(name: "auxiliary reasoning Auto preview", endpoint: .reasoning(model: "", provider: "auto", auxiliaryTask: "vision"),
                  path: "/api/reasoning", query: ["auxiliary_task": "vision", "model": "", "provider": "auto"]),
            .init(name: "personalities", endpoint: .personalities, path: "/api/personalities"),
            .init(name: "set personality", endpoint: .setPersonality, path: "/api/personality/set"),
            .init(name: "profiles", endpoint: .profiles, path: "/api/profiles"),
            .init(name: "switch profile", endpoint: .switchProfile, path: "/api/profile/switch"),
            .init(name: "create profile", endpoint: .createProfile, path: "/api/profile/create"),
            .init(name: "update profile", endpoint: .updateProfile, path: "/api/profile/update"),
            .init(name: "delete profile", endpoint: .deleteProfile, path: "/api/profile/delete"),
            .init(name: "providers", endpoint: .providers, path: "/api/providers"),
            .init(
                name: "provider quotas targeted refresh",
                endpoint: .providerQuotas(sourceID: "qsrc_123", refresh: true),
                path: "/api/provider/quotas",
                query: ["source": "qsrc_123", "refresh": "1"]
            ),
            .init(name: "settings", endpoint: .settings, path: "/api/settings"),
            .init(name: "updates check", endpoint: .updatesCheck, path: "/api/updates/check"),
            .init(name: "updates apply", endpoint: .updatesApply, path: "/api/updates/apply"),
            .init(name: "updates summary", endpoint: .updatesSummary, path: "/api/updates/summary"),
            .init(name: "update notifications", endpoint: .updateNotifications, path: "/api/update-notifications"),
            .init(name: "clear update notifications", endpoint: .updateNotificationsClear, path: "/api/update-notifications/clear"),
            .init(name: "read update notification", endpoint: .updateNotificationRead(id: "notice-123"), path: "/api/update-notifications/notice-123/read"),
            .init(name: "dismiss update notification", endpoint: .updateNotificationDismiss(id: "notice-123"), path: "/api/update-notifications/notice-123/dismiss"),
            .init(name: "update notification action", endpoint: .updateNotificationAction(id: "notice-123", actionID: "acknowledge"), path: "/api/update-notifications/notice-123/actions/acknowledge"),
            .init(
                name: "insights",
                endpoint: .insights(days: 30),
                path: "/api/insights",
                query: ["days": "30"]
            ),
            .init(
                name: "insights custom range",
                endpoint: .insights(days: 30, start: "2026-03-01", end: "2026-03-03"),
                path: "/api/insights",
                query: ["days": "30", "start": "2026-03-01", "end": "2026-03-03"]
            ),
            .init(name: "cron blueprints", endpoint: .cronBlueprints, path: "/api/cron/blueprints"),
            .init(name: "cron blueprint fill", endpoint: .cronBlueprintFill, path: "/api/cron/blueprints/fill"),
            .init(name: "crons", endpoint: .crons, path: "/api/crons"),
            .init(name: "cron create", endpoint: .cronCreate, path: "/api/crons/create"),
            .init(name: "cron update", endpoint: .cronUpdate, path: "/api/crons/update"),
            .init(name: "cron delete", endpoint: .cronDelete, path: "/api/crons/delete"),
            .init(name: "cron run", endpoint: .cronRun, path: "/api/crons/run"),
            .init(name: "cron pause", endpoint: .cronPause, path: "/api/crons/pause"),
            .init(name: "cron resume", endpoint: .cronResume, path: "/api/crons/resume"),
            .init(name: "cron status all", endpoint: .cronStatus(jobID: nil), path: "/api/crons/status"),
            .init(
                name: "cron status job",
                endpoint: .cronStatus(jobID: "job-123"),
                path: "/api/crons/status",
                query: ["job_id": "job-123"]
            ),
            .init(
                name: "cron output",
                endpoint: .cronOutput(jobID: "job-123", limit: 5),
                path: "/api/crons/output",
                query: ["job_id": "job-123", "limit": "5"]
            ),
            .init(
                name: "cron history",
                endpoint: .cronHistory(jobID: "job-123", offset: 40, limit: 20),
                path: "/api/crons/history",
                query: ["job_id": "job-123", "offset": "40", "limit": "20"]
            ),
            .init(
                name: "cron run detail",
                endpoint: .cronRunDetail(jobID: "job-123", filename: "2026-05-04_10-00-00.md"),
                path: "/api/crons/run",
                query: ["job_id": "job-123", "filename": "2026-05-04_10-00-00.md"]
            ),
            .init(
                name: "cron delivery options",
                endpoint: .cronDeliveryOptions,
                path: "/api/crons/delivery-options"
            ),
            .init(name: "cron recent", endpoint: .cronRecent, path: "/api/crons/recent"),
            .init(name: "memory", endpoint: .memory, path: "/api/memory"),
            .init(name: "memory write", endpoint: .memoryWrite, path: "/api/memory/write"),
            .init(name: "feedback diagnostics", endpoint: .feedbackDiagnostics, path: "/api/feedback/diagnostics"),
            .init(name: "feedback submit", endpoint: .feedbackSubmit, path: "/api/feedback/submit"),
            .init(name: "feedback options", endpoint: .feedbackOptions, path: "/api/feedback/options"),
            .init(name: "feedback attachments", endpoint: .feedbackAttachments, path: "/api/feedback/attachments"),
            .init(name: "skills", endpoint: .skills, path: "/api/skills"),
            .init(
                name: "skill content",
                endpoint: .skillContent(name: "swiftui-ui-patterns", file: nil),
                path: "/api/skills/content",
                query: ["name": "swiftui-ui-patterns"]
            ),
            .init(
                name: "skill linked file",
                endpoint: .skillContent(name: "swiftui-ui-patterns", file: "references/navigation.md"),
                path: "/api/skills/content",
                query: ["name": "swiftui-ui-patterns", "file": "references/navigation.md"]
            ),
            .init(name: "upload", endpoint: .upload, path: "/api/upload"),
            .init(name: "export html", endpoint: .exportSession(sessionID: "abc 123", format: .html), path: "/api/session/export",
                  query: ["session_id": "abc 123", "format": "html"]),
            .init(name: "export json", endpoint: .exportSession(sessionID: "abc-123", format: .json), path: "/api/session/export",
                  query: ["session_id": "abc-123", "format": "json"]),
            .init(name: "transcribe capability", endpoint: .transcribeCapability, path: "/api/transcribe/capability"),
            .init(name: "transcribe warm", endpoint: .transcribeWarm, path: "/api/transcribe/warm")
        ]

        let baseURL = URL(string: "https://example.test")!

        for contract in contracts {
            let url = contract.endpoint.url(relativeTo: baseURL)
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false), contract.name)

            XCTAssertEqual(components.path, contract.path, contract.name)
            XCTAssertEqual(queryDictionary(from: components), contract.query, contract.name)
        }
    }

    func testJSONPostRequestsOmitBrowserCSRFHeaders() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/session/pin")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let json = try JSONSerialization.jsonObject(with: try XCTUnwrap(apiTestBodyData(from: request))) as? [String: Any]
            XCTAssertEqual(json?["session_id"] as? String, "abc123")
            XCTAssertEqual(json?["pinned"] as? Bool, false)
            XCTAssertNil(json?["sessionId"])

            return apiTestJSONResponse("""
            {
              "ok": true,
              "session": {
                "session_id": "abc123",
                "pinned": false
              }
            }
            """, for: request)
        }

        let response = try await client.pinSession(id: "abc123", pinned: false)

        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.session?.sessionId, "abc123")
        XCTAssertEqual(response.session?.pinned, false)
    }

    func testMultipartPostRequestsOmitBrowserCSRFHeaders() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/upload")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
            XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data") == true)

            return apiTestJSONResponse("""
            {
              "filename": "contract.txt",
              "path": "/tmp/workspace/contract.txt",
              "size": 8,
              "mime": "text/plain",
              "is_image": false
            }
            """, for: request)
        }

        let response = try await client.uploadFile(sessionID: "abc123", data: Data("contract".utf8), filename: "contract.txt")

        XCTAssertEqual(response.filename, "contract.txt")
    }

    private func queryDictionary(from components: URLComponents) -> [String: String] {
        Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    /// The server parses queries with `URLSearchParams`, which decodes a bare `+` as a space.
    func testQueryValuesPercentEncodePlusSigns() throws {
        let base = try XCTUnwrap(URL(string: "https://example.test"))
        let file = Endpoint.file(sessionID: "s", path: "notes/a+b.md").url(relativeTo: base)
        let search = Endpoint.sessionsSearch(query: "c++", content: false, depth: 1).url(relativeTo: base)

        XCTAssertEqual(file.query(percentEncoded: true), "session_id=s&path=notes/a%2Bb.md")
        XCTAssertEqual(search.query(percentEncoded: true), "q=c%2B%2B&content=0&depth=1")
    }

    func testChatStreamReplayKeepsPlusSignsEncoded() throws {
        let client = APIClient(baseURL: try XCTUnwrap(URL(string: "https://example.test")))
        let url = client.chatStreamURL(streamID: "a+b", replayAfterSeq: 3)

        XCTAssertEqual(url.query(percentEncoded: true), "stream_id=a%2Bb&replay=1&after_seq=3")
    }

    func testUpdateNotificationPathSegmentsCannotReshapeTheRoute() throws {
        let base = try XCTUnwrap(URL(string: "https://webui.example.test"))
        let url = Endpoint.updateNotificationAction(id: "../private", actionID: "../../ack").url(relativeTo: base)
        let path = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath)
        XCTAssertEqual(path, "/api/update-notifications/%2E%2E%2Fprivate/actions/%2E%2E%2F%2E%2E%2Fack")
    }
}

/// `Endpoint` owns the URL only: the HTTP method is chosen per call site in
/// `APIClient`, so it is asserted where each call's request is intercepted
/// rather than restated here (TAL-122).
private struct EndpointContract {
    let name: String
    let endpoint: Endpoint
    let path: String
    let query: [String: String]

    init(name: String, endpoint: Endpoint, path: String, query: [String: String] = [:]) {
        self.name = name
        self.endpoint = endpoint
        self.path = path
        self.query = query
    }
}

final class SharedContractTests: XCTestCase {
    func testToolsetCatalogDecodesServerPolicy() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let catalog = try decoder.decode(ToolsetsCatalog.self, from: fixture("toolsets"))
        XCTAssertEqual(catalog.selectedToolsets, ["file"])
        XCTAssertEqual(catalog.toolsets[1].available, false)
        XCTAssertEqual(catalog.toolsets[1].unavailableReason, "disabled")
        XCTAssertEqual(catalog.toolsets[1].group, "not_available")
        XCTAssertEqual(catalog.toolsets[0].canDeselect, false)
        XCTAssertEqual(catalog.toolsets[2].canDeselect, true)
        XCTAssertEqual(catalog.defaultToolsets, ["file"])
        XCTAssertEqual(catalog.toolsets[2].strippedTools, ["web_search"])
        XCTAssertEqual(catalog.toolsets[2].strippedBy, ["search"])
        let future = try decoder.decode(ToolsetsCatalog.self, from: Data(#"{"toolsets":[{"name":"unknown","future":true}],"selected_toolsets":[],"future":{}}"#.utf8))
        XCTAssertNil(future.toolsets[0].available, "An unknown/missing availability cannot enable a choice")
        XCTAssertNil(future.toolsets[0].canDeselect, "An older catalog carries no deselection authority")
    }

    func testAppAdvertisesCanonicalContractVersions() throws {
        // app/TalariaKit/Tests/TalariaKitTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let versions = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/versions.json"))) as? [String: Any])
        let appWeb = try XCTUnwrap(versions["appWeb"] as? [String: Any])
        let appRelay = try XCTUnwrap(versions["appRelay"] as? [String: Any])
        let scene = try XCTUnwrap(versions["activityScene"] as? [String: Any])
        // The identity the App builds from its Info.plist (`AppConfig.clientIdentity` reads the bundled copy).
        let info = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: root.appendingPathComponent("app/Talaria/Resources/Info.plist")), format: nil
        ) as? [String: Any])
        let identity = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(try AppConfig.releaseIdentity(info: info).utf8)
        ) as? [String: Any])
        let supported = try XCTUnwrap(identity["contracts"] as? [String: Any])
        XCTAssertEqual(supported["appWeb"] as? [Int], [try XCTUnwrap(appWeb["fixtureVersion"] as? Int)])
        XCTAssertEqual(supported["appRelay"] as? [Int], [try XCTUnwrap(appRelay["aggregateSchemaVersion"] as? Int)])
        XCTAssertEqual(supported["activityScene"] as? [String], [try XCTUnwrap(scene["version"] as? String)])
    }

    private func fixture(_ name: String) throws -> Data {
        try sharedContractFixture(name)
    }

    private func session(_ handler: @escaping MockURLProtocol.Handler) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        return URLSession(configuration: configuration)
    }

    func testSharedWebSessionAndActivityScene() async throws {
        let data = try fixture("web-session")
        let session = session { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        defer { session.invalidateAndCancel() }
        let client = APIClient(baseURL: URL(string: "https://contract.example")!, session: session)
        let response = try await client.session(id: "contract-session")
        let message = try XCTUnwrap(response.session?.messages?.first)
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
        XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "tools", "prose"])
        XCTAssertEqual(timeline.toolCalls.map(\.id), ["contract-call"])
        XCTAssertEqual(CompletedAssistantTurn(rows: timeline.rows)?.finalAnswer, "Contract answer.")
        // A Web from before server-attributed file changes (TAL-355) ships none; its turns show no recap.
        guard let fileChanges = message.activityScene?.fileChanges else { return }
        XCTAssertEqual(fileChanges, [AssistantTurnFileChange(path: "fixture.txt", action: .edited)])
        XCTAssertEqual(TurnFileChangeAggregator.summarize(changes: fileChanges, status: nil).filesChangedTitle, "1 file changed")
    }

    func testSharedWebSessionStatesItsTranscriptCursor() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func session(_ key: String) throws -> SessionDetail {
            try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object[key])))
        }
        // A run without a journal: the transcript holds its persisted rows and states no cursor.
        XCTAssertNil(try session("session").transcriptSeq)
        // The server names the workspace (TAL-303); a Web from before that sends no name.
        if (object["session"] as? [String: Any])?["workspace_name"] != nil {
            XCTAssertEqual(try session("session").workspaceName, "Talaria")
            XCTAssertEqual(SessionSummary(from: try session("session")).workspaceName, "Talaria")
        }
        // A release checks this App against every retained Web; one from before TAL-316 has no such example.
        guard object["journaled_session"] != nil else { return }
        // A journaled run: the transcript ends at the running turn's prompt, and replay resumes after the cursor.
        let journaled = try session("journaled_session")
        XCTAssertEqual(journaled.transcriptSeq, TranscriptSeq(streamId: "contract-run-h", seq: 0))
        XCTAssertEqual(journaled.messages?.last?.role, "user")
    }

    func testSharedWebSessionCarriesTheTurnStatsRow() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        let rows = try XCTUnwrap((object["session"] as? [String: Any])?["messages"] as? [[String: Any]])
        // A release checks this App against every retained Web; one from before TAL-598 has no such row.
        guard let raw = rows.first(where: { $0["_turnTps"] != nil }) else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertEqual(message.turnDuration, 4.25)
        XCTAssertEqual(message.turnTps, 31.5)
        XCTAssertEqual(message.timestamp, 1_700_000_001)
        XCTAssertEqual(message.reasoningTitles, ["Plan"])
    }

    func testSharedWebSessionShowsARunningTurnWithoutAJournalOpenAndLetsLiveRowsContinueIt() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-374 has no such example.
        guard let example = object["running_scene_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        var rawMessages = try XCTUnwrap(example["messages"] as? [[String: Any]])
        func running() throws -> ChatMessage {
            try decoder.decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(rawMessages.last)))
        }
        let message = try running()
        XCTAssertEqual(message.activityScene?.terminalState, "running")

        // Every persisted row shows, open: no "Worked" fold, no outcome, no final answer, and the last row is active.
        let opened = AssistantTurnLayout(message: message, liveRows: [], archivedRows: [])
        XCTAssertEqual(opened.rows.map(\.kind), ["reasoning", "prose", "tools", "prose"])
        XCTAssertEqual(opened.rows.compactMap(\.text), ["Plan the read.", "Reading a.txt.", "Now b.txt."])
        XCTAssertFalse(opened.foldsWork)
        XCTAssertTrue(opened.isLive)
        XCTAssertNil(AssistantTurnOutcome.label(for: message.activityScene?.terminalState))
        XCTAssertEqual(CompletedAssistantTurn(rows: opened.rows)?.finalAnswer, "")

        // Live frames streamed after attach continue the persisted rows instead of replacing them.
        let live = [
            AssistantActivityRow(id: "live:prose", content: .prose("Reading b.txt.")),
            AssistantActivityRow(id: "live:reasoning", content: .reasoning(.init(text: "Compare them.")))
        ]
        let streaming = AssistantTurnLayout(message: message, liveRows: live, archivedRows: [])
        XCTAssertEqual(streaming.rows.map(\.id), opened.rows.map(\.id) + ["live:prose", "live:reasoning"])
        XCTAssertFalse(streaming.foldsWork)
        XCTAssertTrue(streaming.isLive)
        // Once the stream ends, its archived rows still follow the persisted ones until the settled scene arrives.
        let ended = AssistantTurnLayout(message: message, liveRows: [], archivedRows: live)
        XCTAssertEqual(ended.rows.map(\.id), streaming.rows.map(\.id))
        XCTAssertFalse(ended.foldsWork)
        XCTAssertFalse(ended.isLive)

        // The settled scene replaces both, once: its rows and its answer, folded under "Worked".
        var settledMessage = try XCTUnwrap(rawMessages.last)
        var scene = try XCTUnwrap(settledMessage["_anchor_activity_scene"] as? [String: Any])
        scene["terminal_state"] = "completed"
        scene["final_answer"] = "Both read."
        scene["expanded_by_default"] = false
        settledMessage["_anchor_activity_scene"] = scene
        rawMessages[rawMessages.count - 1] = settledMessage
        let settled = AssistantTurnLayout(message: try running(), liveRows: [], archivedRows: live)
        XCTAssertEqual(settled.rows.map(\.id), opened.rows.map(\.id) + ["scene:final"])
        XCTAssertEqual(CompletedAssistantTurn(rows: settled.rows)?.finalAnswer, "Both read.")
        XCTAssertTrue(settled.foldsWork)
        XCTAssertFalse(settled.isLive)
    }

    func testARunningScenesToolTakesItsLiveCompletionInPlace() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-374 has no such example.
        guard let example = object["running_scene_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        // The tool's call persisted before its result: the scene shows it still running.
        var raw = try XCTUnwrap((example["messages"] as? [[String: Any]])?.last)
        var scene = try XCTUnwrap(raw["_anchor_activity_scene"] as? [String: Any])
        scene["activity_rows"] = try XCTUnwrap(scene["activity_rows"] as? [[String: Any]]).map { row in
            guard var tool = row["tool"] as? [String: Any] else { return row }
            tool["done"] = false
            tool["result"] = NSNull()
            var running = row
            running["tool"] = tool
            return running
        }
        raw["_anchor_activity_scene"] = scene
        let message = try decoder.decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertEqual(
            AssistantTurnLayout(message: message, liveRows: [], archivedRows: []).rows.flatMap(\.toolCalls).map(\.isCompleted),
            [false]
        )

        // The stream's completion for that call updates the scene's card instead of adding a second one.
        let completion = ToolCall(id: "contract-read", name: "read_file", preview: "A", args: nil, duration: 0.5, isError: false, isCompleted: true)
        let live = [
            AssistantActivityRow(id: "live:tools", content: .tools([completion])),
            AssistantActivityRow(id: "live:prose", content: .prose("Reading b.txt."))
        ]
        let layout = AssistantTurnLayout(message: message, liveRows: live, archivedRows: [])
        XCTAssertEqual(
            layout.rows.map(\.id),
            ["contract-run-r-1:reasoning", "contract-run-r-1:prose", "tool:contract-read", "contract-run-r-2:prose", "live:prose"]
        )
        let calls = layout.rows.flatMap(\.toolCalls)
        XCTAssertEqual(calls.map(\.id), ["contract-read"])
        XCTAssertEqual(calls.first?.isCompleted, true)
        XCTAssertEqual(calls.first?.duration, 0.5)
        XCTAssertEqual(calls.first?.args?["path"], .string("a.txt"))
    }

    func testSharedWebSessionCollapsesOnlyItsLongBodies() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-456 has no such example.
        guard let example = object["long_body_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: example["messages"] ?? []))
        XCTAssertEqual(messages.prefix(4).map { $0.displayExcerpt != nil }, [true, true, false, false])
        XCTAssertTrue(messages.dropFirst(4).allSatisfy { $0.displayExcerpt == nil })
        for message in messages {
            if let excerpt = message.displayExcerpt {
                XCTAssertLessThan(excerpt.count, message.content?.count ?? 0)
                XCTAssertTrue(message.content?.hasPrefix(excerpt) == true)
            }
        }
        let reply = try XCTUnwrap(messages.first { $0.messageId == "long-body-reply" })
        XCTAssertEqual(reply.activityScene?.finalAnswerExcerpt, reply.displayExcerpt)
        // Retained Web releases have the original four-row fixture.
        if let newest = messages.first(where: { $0.messageId == "newest-body-reply" }) {
            XCTAssertGreaterThan(newest.content?.count ?? 0, 3000)
            XCTAssertNil(newest.displayExcerpt)
            XCTAssertNil(newest.activityScene?.finalAnswerExcerpt)
            XCTAssertEqual(MessageActionContext(message: newest, visibleIndex: 5, messagesOffset: nil)?.copyText, newest.content)
        }
        XCTAssertNil(messages.first { $0.messageId == "short-body-reply" }?.activityScene?.finalAnswerExcerpt)
    }

    func testSharedWebSessionFoldsOnlyItsLongPrompt() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-452 has no such example.
        guard let example = object["collapsible_user_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: example["messages"] ?? []))
        XCTAssertEqual(messages.map(\.collapsible), [true, false, false, false])
        let prompt = try XCTUnwrap(messages.first)
        XCTAssertEqual(prompt.content?.split(separator: "\n").count, 24)
        // Copy and edit act on the whole prompt, never the folded view of it.
        XCTAssertEqual(MessageActionContext(message: prompt, visibleIndex: 0, messagesOffset: nil)?.copyText, prompt.content)
    }

    func testOnlyAServerCollapsedExcerptIsKeptAndALongBodyGetsNoLinkPreview() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func message(_ json: String) throws -> ChatMessage { try decoder.decode(ChatMessage.self, from: Data(json.utf8)) }
        let collapsed = try message(#"{"role":"user","content":"See https://example.test/page and more","_display_truncated":true,"_display_excerpt":"See"}"#)
        let unflagged = try message(#"{"role":"user","content":"See https://example.test/page","_display_excerpt":"See"}"#)
        XCTAssertEqual(collapsed.displayExcerpt, "See")
        XCTAssertNil(unflagged.displayExcerpt)
        XCTAssertNil(TranscriptLinkPreviewEligibility.previewURL(for: collapsed, isStreaming: false))
        XCTAssertEqual(TranscriptLinkPreviewEligibility.previewURL(for: unflagged, isStreaming: false)?.absoluteString, "https://example.test/page")
    }

    func testSharedWebSessionNamesItsAgent() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        var session = try XCTUnwrap(object["session"] as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func decoded() throws -> SessionDetail {
            try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: session))
        }
        // A release checks this App against every retained Web; one from before TAL-458 names no agent.
        if session["assistant_name"] != nil {
            XCTAssertEqual(try decoded().assistantName, "Hermes")
        }
        session["assistant_name"] = "Maude"
        XCTAssertEqual(try decoded().assistantName, "Maude")
        session.removeValue(forKey: "assistant_name")
        XCTAssertNil(try decoded().assistantName)
    }

    func testSharedWebSessionMarksOnlyWakeupsAsBackgroundUpdates() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-371 has no such example.
        guard let example = object["background_update_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: example["messages"] ?? []))
        let byID = Dictionary(uniqueKeysWithValues: messages.compactMap { m in m.messageId.map { ($0, m) } })
        // A person typing the marker text stays an ordinary user message.
        XCTAssertNil(byID["typed-marker-user"]?.backgroundUpdate)
        XCTAssertNotNil(byID["wakeup-legacy-user"]?.backgroundUpdate)
        XCTAssertNil(byID["wakeup-mixed-reply"]?.backgroundUpdate)
        // A Web from before TAL-460 sends no lines; its summary is the one line.
        guard (example["background_updates"] as? [String: Any])?["wake-silent"] != nil else { return }
        // Retained pre-TAL-1022 Web fixtures omit review_state; current historical rows have no review proof.
        let rawMixed = (example["messages"] as? [[String: Any]])?.first { $0["message_id"] as? String == "wakeup-mixed-user" }
        let hasReviewState = (rawMixed?["_background_update"] as? [String: Any])?["review_state"] != nil
        XCTAssertEqual(byID["wakeup-mixed-user"]?.backgroundUpdate?.lines, [
            BackgroundLine(kind: .agent, status: .completed, label: "Audit the PVC backups", reviewState: hasReviewState ? .unknown : nil),
            BackgroundLine(kind: .command, status: .failed, label: "make test", exitCode: 1, reviewState: hasReviewState ? .failed : nil),
        ])
        // Only the background turn's silence marker is silent; the same words the user asked for are shown.
        XCTAssertEqual(messages.filter(\.backgroundSilent).map(\.messageId), ["wakeup-silent-reply"])
        XCTAssertFalse(try XCTUnwrap(byID["user-no-reply-answer"]).backgroundSilent)
        let shown = ChatViewModel.transcriptMessages(from: messages).map(\.message.messageId)
        XCTAssertFalse(shown.contains("wakeup-silent-reply"))
        XCTAssertTrue(shown.contains("wakeup-silent-user"))
        XCTAssertTrue(shown.contains("user-no-reply-answer"))
    }

    func testBackgroundReviewStatesDecodeWithoutInventingOlderOrFutureValues() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("background-review")) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: object["messages"]!))
        XCTAssertEqual(messages.compactMap { $0.backgroundUpdate?.reviewState }, BackgroundReviewState.allCases)
        XCTAssertEqual(messages.compactMap { $0.backgroundUpdate?.lines.first?.reviewState }, BackgroundReviewState.allCases)
        for raw in ["{}", #"{"review_state":"future","lines":[{"kind":"agent","status":"completed","label":"Goal","review_state":"future"}]}"#] {
            let update = try decoder.decode(BackgroundUpdate.self, from: Data(raw.utf8))
            XCTAssertNil(update.reviewState)
            XCTAssertNil(update.lines.first?.reviewState)
        }
    }

    func testLegacyBackgroundFailurePresentationDoesNotInventReviewProof() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        for status in ["failed", "completed", "notice"] {
            let raw = "{\"kind\":\"agent\",\"status\":\"\(status)\",\"label\":\"Legacy goal\"}"
            let line = try decoder.decode(BackgroundLine.self, from: Data(raw.utf8))
            XCTAssertNil(line.reviewState)
            XCTAssertEqual(line.reviewStateForDisplay, status == "failed" ? .failed : .unknown)
            XCTAssertNil(try decoder.decode(BackgroundLine.self, from: JSONEncoder().encode(line)).reviewState)
        }
        let explicit = BackgroundLine(kind: .agent, status: .failed, label: "Server choice", reviewState: .unknown)
        XCTAssertEqual(explicit.reviewStateForDisplay, .unknown)
    }

    func testSharedWebSessionMarksOnlyTheServersMarkers() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-305 has no such example.
        guard let example = object["marker_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: example["messages"] ?? []))
        XCTAssertEqual(messages.map { $0.markerKind }, [nil, nil, .contextCompaction, .preservedTaskList, nil, nil])
        XCTAssertEqual(messages[3].markerBody, "- [x] Draft the plan\n- [ ] Review the plan")
        // Each marker is a row of its own; the reply about compaction stays an ordinary assistant turn.
        let rows = ChatViewModel.transcriptMessages(from: messages)
        XCTAssertEqual(rows.map { $0.message.messageId }, ["marker-prompt", "marker-reply", "marker-compaction", "marker-task-list", "marker-question", "marker-prose"])
        XCTAssertEqual(rows.last?.assistantSegments.count, 1)
    }

    /// TAL-2058: each `content_refused` row decodes as that marker with the server's notice, and opens no turn.
    func testSharedWebSessionDecodesTheRefusedAskWithItsNotice() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2057 has no such example.
        guard let example = object["content_refused_session"] as? [String: Any] else { return }
        let raw = try XCTUnwrap(example["messages"] as? [[String: Any]])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(withJSONObject: raw))
        let notices = raw.map { $0["_marker_kind"] as? String == "content_refused" ? $0["_refused_notice"] as? String : nil }
        XCTAssertTrue(notices.contains { $0 != nil }, "The example has no refused ask")
        XCTAssertEqual(messages.map { $0.markerKind?.title }, notices)
        for (message, notice) in zip(messages, notices) where notice != nil {
            XCTAssertFalse(TranscriptTurnClassifier.isUserTurnBoundary(message), "A refused ask opens a turn")
        }
    }

    func testSharedWebSessionShowsTheCompactionAsItsOwnRowInPlace() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-1566 has no such example.
        guard let example = object["compaction_row_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] ?? [:]))
        let messages = try XCTUnwrap(detail.messages)
        let offset = try XCTUnwrap(detail.messagesOffset)
        let transcript = ChatViewModel.transcriptMessages(from: messages, messageOffset: offset)
        // The tail window starts at the anchor, "Step one done."; the compaction's own row follows it, before step two.
        XCTAssertEqual(transcript.map { $0.message.markerKind }, [nil, .contextCompaction, nil, nil])
        let row = transcript[1]
        XCTAssertEqual(row.message.content, "Earlier turns were summarised.")
        XCTAssertEqual(row.renderID, "marker:\(try XCTUnwrap(row.message.messageId))")
        XCTAssertFalse(TranscriptTurnClassifier.isUserTurnBoundary(row.message))
    }

    func testSharedWebSessionLinksOnlyTheBranchToItsParent() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-454 has no such example.
        guard let example = object["branched_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let branch = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] ?? [:]))
        XCTAssertEqual(branch.branchedFrom, SessionBranchLink(sessionId: "contract-branch-parent", title: "Plan the migration"))
        let ordinary = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: object["session"] ?? [:]))
        XCTAssertNil(ordinary.branchedFrom)
    }

    func testABackgroundUpdateShowsOnlyItsLines() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"x","_background_update":{"lines":[{"kind":"command","status":"failed","label":"Nightly"}]}}"#.utf8))
        XCTAssertEqual(message.backgroundUpdate?.lines, [BackgroundLine(kind: .command, status: .failed, label: "Nightly")])
        // A record with only a `summary` has no lines to show.
        let summaryOnly = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"x","_background_update":{"attention":true,"summary":"s"}}"#.utf8))
        XCTAssertEqual(summaryOnly.backgroundUpdate?.lines, [])
    }

    func testSharedWebSessionDecodesTheServersPendingSteers() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-424 has no such example.
        guard let example = object["pending_steers_session"] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example))
        XCTAssertEqual(detail.pendingSteers?.map(\.steerId), ["steer-contract-1", "steer-contract-2"])
        XCTAssertEqual(detail.pendingSteers?.first?.actions, PendingSteer.Actions(edit: true, cancel: true, sendNow: true))
        XCTAssertEqual(detail.pendingSteers?.last?.state, .sendingNow)
        XCTAssertEqual(detail.pendingSteers?.last?.actions, PendingSteer.Actions.none)
        // A detail without the list (a CLI session) decodes none; the chat reads it as an empty list.
        XCTAssertNil(try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s"}"#.utf8)).pendingSteers)
    }

    func testSharedNativeIdleNoticesUseExistingSessionFields() throws {
        let data: Data
        do { data = try fixture("web-native-notices") }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            throw XCTSkip("The retained Web fixture predates native idle notices")
        }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object["session"])))
        XCTAssertEqual(detail.notices?.map(\.text), ["Project plugins were skipped", "Plugin finished"])
        XCTAssertEqual(detail.notices?.map(\.level), [.warn, .info])
        XCTAssertNil(detail.activeStreamId)
        let invalidation = try XCTUnwrap(object["invalidation"] as? [String: Any])
        let frame = SessionEventFrameDecoder.decode(eventType: "session-updated", data: String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(invalidation["data"])), as: UTF8.self))
        XCTAssertEqual(frame, .changed(.changed(reason: "session-updated", sessionID: detail.sessionId)))
    }

    func testSharedWebSessionDecodesTheAgentsNotices() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-803 has no such example.
        guard let example = object["notices_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example))
        XCTAssertEqual(detail.notices?.map(\.key), ["startup-warning.1a2b3c4d", "credits.usage_band"])
        XCTAssertEqual(detail.notices?.map(\.level), [.warn, .info])
        // The stream's frames: the full list, then the list after the Agent cleared its startup warning.
        let frames = try XCTUnwrap(example["events"] as? [[String: Any]]).map { frame in
            SSEEventDecoder.decode(
                eventType: frame["event"] as? String ?? "",
                data: String(decoding: try JSONSerialization.data(withJSONObject: frame["data"] ?? [:]), as: UTF8.self)
            )
        }
        XCTAssertEqual(frames, [
            .notices(SessionNoticesEvent(sessionId: "contract-notices", notices: detail.notices ?? [])),
            .notices(SessionNoticesEvent(sessionId: "contract-notices", notices: Array((detail.notices ?? []).suffix(1))))
        ])
        // A detail without the list (a Web older than TAL-803) decodes none.
        XCTAssertNil(try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s"}"#.utf8)).notices)
        XCTAssertEqual(try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s","notices":[]}"#.utf8)).notices, [])
    }

    func testSessionDetailDecodesWhoStartedTheRunningTurn() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let detail = try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s","active_stream_id":"run","active_turn_origin":"background"}"#.utf8))
        XCTAssertEqual(detail.activeTurnOrigin, "background")
    }

    func testSharedWebSessionContextRingComesFromServerFigures() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-299 has no such example.
        guard let examples = object["context_usage_sessions"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func label(_ key: String) throws -> String {
            let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(examples[key])))
            return ContextWindowIndicatorPresentation(snapshot: ContextWindowSnapshot(session: session)).percentageLabel
        }
        XCTAssertEqual(try label("populated"), "50")
        XCTAssertEqual(try label("unknown_window"), "–")
    }

    func testSharedWebSessionShowsTheMediaExampleAsTheServerRewroteIt() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-186 has no such example.
        guard let example = object["media_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode(
            [ChatMessage].self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(example["messages"]))
        )
        let reply = try XCTUnwrap(messages.first { $0.role == "assistant" })
        let display = try XCTUnwrap(reply.displayBody)
        // `content` stays as written for copy and edit; the display text carries the server's media URLs.
        XCTAssertTrue(reply.content?.contains("MEDIA:/talaria-contract/out/chart.png") == true)
        XCTAssertFalse(display.text.contains("MEDIA:/talaria-contract/out/chart.png"))
        XCTAssertTrue(display.text.contains("MEDIA:/talaria-contract/out/secret.png"), "Fenced code stays literal")
        XCTAssertEqual(display.media.map(\.mediaKind), [.image, .audio])
        XCTAssertEqual(display.tiles.map(\.name), ["narration.mp3"])
        let chart = try XCTUnwrap(display.media.first)
        XCTAssertEqual(display.image(for: URL(string: chart.url)), chart)
        XCTAssertEqual(
            APIClient(baseURL: URL(string: "https://example.test/talaria")!).transcriptMediaURL(for: chart.url)?.absoluteString,
            "https://example.test/talaria/api/media?path=%2Ftalaria-contract%2Fout%2Fchart.png&session_id=contract-media-session"
        )
        // The final answer renders the scene's display text, as Web does.
        let sceneRows = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: reply)).rows
        let turn = try XCTUnwrap(CompletedAssistantTurn(rows: [AssistantActivityRow(id: "work", content: .reasoning(.init(text: "Plan")))] + sceneRows))
        XCTAssertEqual(turn.finalAnswerDisplay, display)
    }

    func testSharedWebSessionShowsEachInlineThinkingExampleAsTheServerSplitIt() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-302 has no such example.
        guard let example = object["inline_thinking_session"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let messages = try decoder.decode(
            [ChatMessage].self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(example["messages"]))
        )
        let expected = try XCTUnwrap(example["expected"] as? [String: [String: String]])
        XCTAssertFalse(expected.isEmpty)
        for (id, want) in expected {
            let message = try XCTUnwrap(messages.first { $0.messageId == id }, id)
            let rows = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message), id).rows
            // The same prose and reasoning Web shows, from the server's fields alone.
            XCTAssertEqual(rows.filter(\.isFinalAnswer).compactMap(\.text), [want["prose"]].compactMap { $0 }, id)
            XCTAssertEqual(
                rows.filter { $0.kind == "reasoning" }.compactMap(\.text).joined(separator: "\n\n"),
                want["reasoning"],
                id
            )
            XCTAssertEqual(message.reasoning ?? "", want["reasoning"], id)
        }
    }

    func testSharedWebSessionResolvesEveryToolCallOutcome() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-313 has no such example.
        guard let example = object["tool_outcomes_session"] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example))
        let messages = try XCTUnwrap(session.messages)
        func outcomes(_ calls: [ToolCall]) -> [String] {
            calls.map { "\($0.id) done=\($0.isCompleted) error=\($0.isError ?? false) duration=\($0.duration.map { "\($0)" } ?? "nil")" }
        }
        let expected: [String: [String]] = [
            "tool-openai": ["call-read done=true error=false duration=1.25", "call-exit done=true error=true duration=3.5"],
            "tool-anthropic": ["toolu-search done=true error=true duration=nil"],
            "tool-session": ["call-date done=true error=false duration=0.42"]
        ]
        // Completed turns render their scene; the same calls on the assistant rows carry the same outcomes.
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for (turn, calls) in expected {
            let answer = try XCTUnwrap(messages.first { $0.messageId == "\(turn)-answer" })
            let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
            XCTAssertEqual(outcomes(timeline.toolCalls), calls, turn)
            XCTAssertEqual(outcomes(groups.first { $0.anchorMessageID == "\(turn)-calls" }?.toolCalls ?? []), calls, turn)
        }
        // The running turn's unanswered call is not done.
        XCTAssertEqual(
            outcomes(groups.first { $0.anchorMessageID == "tool-live-calls" }?.toolCalls ?? []),
            ["call-build done=false error=false duration=nil"]
        )
    }

    func testSharedWebSessionRendersEachToolResultFromTheServerView() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-315 has no such example.
        guard let example = object["tool_result_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        // The same sections, in the same order, that Web renders from the same fields.
        let expected = [
            "call-make": "built\nok\nwarning: deprecated\nExit code: 2",
            "call-nested": "line one\nline two",
            "call-parts": "first\nsecond",
            "call-date": "Sat Sep 27"
        ]
        func results(_ calls: [ToolCall]) -> [String: String] {
            Dictionary(uniqueKeysWithValues: calls.map { ($0.id, ToolCallDisplayFormatter.content(for: $0).result?.text ?? "") })
        }
        let answer = try XCTUnwrap(messages.first { $0.messageId == "view-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        XCTAssertEqual(results(timeline.toolCalls), expected)
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        XCTAssertEqual(results(groups.first { $0.anchorMessageID == "view-calls" }?.toolCalls ?? []), expected)
    }

    func testSharedWebSessionCarriesEachReadAndSearchSection() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2323 has no such example.
        guard let example = object["tool_file_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "file-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "file-calls" }?.toolCalls ?? []] {
            let views = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0.resultView) })
            let excerpt = try XCTUnwrap(views["call-read"]??.fileExcerpt)
            XCTAssertEqual(excerpt.path, "src/app.ts")
            XCTAssertEqual(excerpt.focusPath, "src/app.ts")
            XCTAssertEqual(excerpt.language, "ts")
            XCTAssertEqual(excerpt.lines.map(\.n), [12, 13])
            XCTAssertEqual(excerpt.lines.last?.text, "run(2)")
            XCTAssertEqual([excerpt.totalLines, excerpt.nextOffset], [40, 14])
            XCTAssertTrue(excerpt.truncated)
            let search = try XCTUnwrap(views["call-search"]??.matches)
            XCTAssertEqual(search.files.map(\.path), ["src/app.ts", "src/run.ts"])
            XCTAssertEqual(search.files.last?.matches.map(\.line), [1, 4, 9])
            XCTAssertEqual(search.files.first?.focusPath, "src/app.ts")
            XCTAssertEqual(views["call-count"]??.matches?.files.map(\.count), [2, 3])
            XCTAssertEqual(views["call-again"]??.text, "Unchanged since the last read")
        }
    }

    func testSharedWebSessionCarriesEachWebSearchAndExtractSection() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2324 has no such example.
        guard let example = object["tool_web_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "web-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "web-calls" }?.toolCalls ?? []] {
            let views = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0.resultView) })
            let search = try XCTUnwrap(views["call-web"]??.links)
            XCTAssertNil(search.answer)
            XCTAssertEqual(search.items.map(\.title), ["Hermes Agent", "Docs"])
            XCTAssertEqual(search.items.first?.url, "https://www.example.com/hermes")
            XCTAssertEqual(search.items.map(\.domain), ["example.com", "docs.example.org"])
            XCTAssertEqual(search.items.first?.snippet, "An open agent.")
            let x = try XCTUnwrap(views["call-x"]??.links)
            XCTAssertEqual(x.answer, "People **like** it.")
            XCTAssertEqual(x.items.map(\.url), ["https://x.com/b/status/2", "https://x.com/a/status/1"])
            XCTAssertNil(x.items.first?.snippet)
            let pages = try XCTUnwrap(views["call-extract"]??.pages)
            XCTAssertEqual(pages.map(\.title), ["Hermes", "https://blocked.example/"])
            XCTAssertEqual(pages.first?.excerpt, "# Hermes\n\nAn open agent.")
            XCTAssertNil(pages.first?.error)
            XCTAssertEqual(pages.last?.error, "Blocked by website policy")
        }
    }

    func testSharedWebSessionCarriesEachMediaAndAnalysisSection() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2325 has no such example.
        guard let example = object["tool_media_views"] as? [String: Any] else { return }
        let expectedImageMedia = try XCTUnwrap(((example["expected"] as? [String: Any])?["call-image"] as? [String: Any])?["media"] as? [[String: Any]])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "media-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "media-calls" }?.toolCalls ?? []] {
            let byID = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0) })
            let image = try XCTUnwrap(byID["call-image"])
            XCTAssertEqual(image.kind, .image)
            XCTAssertEqual(image.resultView?.media?.map(\.mediaKind), [.image, .image])
            XCTAssertEqual(image.resultView?.media?.first?.url, "./api/media?path=%2Fsrv%2Fhermes%2Fcache%2Fgenerated%2Fimages%2Fcat.png&session_id=media-session")
            // The remote image's URL is whatever this fixture's Web shipped: as written before TAL-2199, its relay after.
            XCTAssertEqual(image.resultView?.media?.last?.url, expectedImageMedia.last?["url"] as? String)
            XCTAssertEqual(AssistantActivitySummary.label(for: image), "Generated an image")
            XCTAssertEqual(AssistantActivitySummary.icon(for: image), "photo")
            let speech = try XCTUnwrap(byID["call-speech"])
            XCTAssertEqual(speech.kind, .audio)
            XCTAssertEqual(speech.resultView?.media?.map(\.mediaKind), [.audio])
            XCTAssertEqual(AssistantActivitySummary.icon(for: speech), "waveform")
            let video = try XCTUnwrap(byID["call-video"])
            XCTAssertEqual(video.kind, .video)
            XCTAssertEqual(video.resultView?.media?.map(\.url), ["https://cdn.example/wave.mp4"])
            let failed = try XCTUnwrap(byID["call-failed"])
            XCTAssertEqual(failed.resultView?.error, "FAL_KEY is not set")
            XCTAssertNil(failed.resultView?.media)
            XCTAssertEqual(AssistantActivitySummary.label(for: failed), "Failed to generate an image")
            let vision = try XCTUnwrap(byID["call-vision"])
            XCTAssertEqual(vision.kind, .imageAnalysis)
            XCTAssertEqual(vision.resultView?.analysis, "A **cat** on a sofa.")
            XCTAssertEqual(AssistantActivitySummary.label(for: vision), "Analyzed an image")
            XCTAssertEqual(byID["call-native"]?.resultView?.analysis, "Image loaded into your context.")
        }
    }

    func testSharedWebSessionCarriesEachToolRowsSection() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2326 has no such example.
        guard let example = object["tool_rows_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "rows-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "rows-calls" }?.toolCalls ?? []] {
            let byID = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0) })
            let memory = try XCTUnwrap(byID["call-memory"]?.resultView?.rows)
            XCTAssertEqual(memory.title, "User profile · 4% — 88/2,200 chars")
            XCTAssertEqual(memory.rows.map(\.label), ["Added: Prefers short replies"])
            let staged = try XCTUnwrap(byID["call-skill"]?.resultView?.rows)
            XCTAssertEqual(staged.rows.map(\.status), ["pending", "pending"])
            XCTAssertEqual(staged.rows.first?.label, "Waiting for approval")
            XCTAssertEqual(staged.rows.last?.link?.destinationURL, TalariaDeepLink.sectionURL(.skills))
            let view = try XCTUnwrap(byID["call-view"]?.resultView?.rows)
            XCTAssertEqual(view.markdown, "# PDF\n\nUse **pdftotext**.")
            XCTAssertEqual(view.rows.last?.status, "warn")
            let search = try XCTUnwrap(byID["call-search"])
            XCTAssertEqual(search.kind, .session)
            XCTAssertEqual(search.resultView?.rows?.rows.first?.link?.destinationURL, TalariaDeepLink.sessionURL(sessionID: "past-1"))
            XCTAssertEqual(AssistantActivitySummary.label(for: search), "Searched past chats for deploy")
            XCTAssertEqual(AssistantActivitySummary.icon(for: search), "bubble.left.and.bubble.right")
            let cron = try XCTUnwrap(byID["call-cron"])
            XCTAssertEqual(cron.kind, .schedule)
            XCTAssertEqual(cron.resultView?.rows?.rows.first?.link?.destinationURL, TalariaDeepLink.sectionURL(.tasks))
            XCTAssertEqual(AssistantActivitySummary.label(for: cron), "Managed a scheduled job")
            XCTAssertEqual(AssistantActivitySummary.icon(for: cron), "calendar.badge.clock")
            let connect = try XCTUnwrap(byID["call-connect"])
            XCTAssertEqual(connect.kind, .connection)
            XCTAssertEqual(connect.resultView?.rows?.rows.first?.link?.destinationURL, TalariaDeepLink.sectionURL(.tools))
            XCTAssertEqual(AssistantActivitySummary.label(for: connect), "Managed connections")
            XCTAssertEqual(AssistantActivitySummary.icon(for: connect), "powerplug")
            let question = try XCTUnwrap(byID["call-clarify"])
            XCTAssertEqual(question.kind, .question)
            XCTAssertEqual(question.resultView?.rows?.rows.map { [$0.label, $0.detail] }, [["Which branch?", "dev"]])
            XCTAssertEqual(AssistantActivitySummary.label(for: question), "Asked a question")
            XCTAssertEqual(AssistantActivitySummary.icon(for: question), "questionmark.bubble")
            // TAL-2027: the App reads the server's `shows_card` on an answered question; a Web from before it sends none.
            let messagesJSON = (example["session"] as? [String: Any])?["messages"] as? [[String: Any]] ?? []
            let rawQuestion = messagesJSON.flatMap { $0["tool_calls"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == "call-clarify" }
            XCTAssertEqual(question.displayFlags.showsCard, rawQuestion?["shows_card"] as? Bool == true)
        }
    }

    /// TAL-2335: each call's outcome in the shared tool-rows session, on the scene and the calls alike.
    func testSharedWebSessionCarriesEachToolOutcome() throws {
        let data = try fixture("web-session")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2335 ships no outcome.
        guard let example = object["tool_rows_views"] as? [String: Any], String(decoding: data, as: UTF8.self).contains(#""memory_added""#) else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "rows-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "rows-calls" }?.toolCalls ?? []] {
            let outcomes = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0.resultView?.outcome) })
            XCTAssertEqual(outcomes, [
                "call-memory": ToolOutcome(key: .memoryAdded, tone: .neutral, count: 1),
                "call-skill": ToolOutcome(key: .pendingApproval, tone: .attention),
                "call-view": nil, "call-search": nil,
                "call-cron": ToolOutcome(key: .paused, tone: .neutral),
                "call-connect": ToolOutcome(key: .needsSignIn, tone: .attention),
                "call-clarify": ToolOutcome(key: .answered, tone: .neutral, value: "dev"),
            ])
        }
    }

    /// TAL-2339: each reply's turn summary in the shared tool-outcome session, as the App decodes it.
    func testSharedWebSessionCarriesEachTurnSummary() throws {
        let data = try fixture("web-session")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2339 ships no summary.
        guard let example = object["tool_outcome_views"] as? [String: Any], String(decoding: data, as: UTF8.self).contains(#""turn_summary""#) else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let summaries = (1...3).map { turn in messages.first { $0.messageId == "outcome-answer-\(turn)" }?.turnSummary }
        XCTAssertEqual(summaries, [
            [TurnSummaryPart(key: .memoriesSaved, count: 1), TurnSummaryPart(key: .schedulesChanged, count: 1), TurnSummaryPart(key: .messagesSent, count: 1)],
            [TurnSummaryPart(key: .filesChanged, count: 1)],
            [TurnSummaryPart(key: .tasksUpdated, count: 1)],
        ])
    }

    /// TAL-2339: a summary part a newer server adds, or a malformed one, drops alone; an older server's scene carries none.
    func testTurnSummaryDecodesEachPartOnItsOwn() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let scene = try decoder.decode(AssistantActivityScene.self, from: Data(#"""
        {"version": "activity_scene_v1", "activity_rows": [], "turn_summary": [
          {"key": "files_changed", "count": 3}, {"key": "widgets_built", "count": 2}, {"key": "memories_saved", "count": 0},
          {"key": "skills_updated", "count": 1.5}, {"key": "messages_sent", "count": 2}
        ]}
        """#.utf8))
        XCTAssertEqual(scene.turnSummary, [TurnSummaryPart(key: .filesChanged, count: 3), TurnSummaryPart(key: .messagesSent, count: 2)])
        XCTAssertEqual(AssistantTurnSummary.changes(scene.turnSummary), "Changed 3 files · Sent 2 messages")
        let older = try decoder.decode(AssistantActivityScene.self, from: Data(#"{"version": "activity_scene_v1", "activity_rows": []}"#.utf8))
        XCTAssertNil(older.turnSummary)
        XCTAssertNil(AssistantTurnSummary.changes([]))
    }

    func testSharedWebSessionCarriesEachKanbanRow() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2327 has no such example.
        guard let example = object["tool_kanban_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "kanban-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "kanban-calls" }?.toolCalls ?? []] {
            let byID = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0) })
            XCTAssertEqual(calls.map(\.kind), Array(repeating: .kanban, count: 4))
            XCTAssertEqual(calls.map(\.verb), [.list, .create, .complete, .comment])
            XCTAssertEqual(calls.map { AssistantActivitySummary.label(for: $0) }, ["Listed tasks", "Created Write release notes", "Completed t_1", "Commented on t_1"])
            XCTAssertEqual(calls.map { AssistantActivitySummary.icon(for: $0) }, Array(repeating: "rectangle.split.3x1", count: 4))
            let created = try XCTUnwrap(byID["call-create"]?.resultView?.rows?.rows.first)
            XCTAssertEqual(created.label, "Write release notes")
            XCTAssertEqual(created.link?.destinationURL, TalariaDeepLink.kanbanCardURL(cardID: "t_9", board: "ops"))
            let listed = try XCTUnwrap(byID["call-list"]?.resultView?.rows?.rows)
            XCTAssertEqual(listed.map { [$0.label, $0.detail] }, [["Fix login", "ready · scout"]])
            XCTAssertEqual(listed.first?.link?.destinationURL, TalariaDeepLink.kanbanCardURL(cardID: "t_1"))
        }
    }

    func testSharedWebSessionLeavesOutTheToolLookupsTheServerHides() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2331 has no such example.
        guard let example = object["tool_lookup_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let answer = try XCTUnwrap(session.messages?.first { $0.messageId == "lookup-answer" })
        let layout = AssistantTurnLayout(message: answer, liveRows: [], archivedRows: [])
        // The lookup that worked is hidden; the failed one and the call it led to show.
        XCTAssertEqual(layout.rows.flatMap(\.toolCalls).map(\.id), ["call-search", "call-list"])
    }

    func testSharedWebSessionNamesEachMCPAndConnectorCallByItsApp() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2330 has no such example.
        guard let example = object["tool_app_views"] as? [String: Any] else { return }
        // Only Gmail has a logo; its URL is whatever this fixture's Web shipped: remote before TAL-2199, inline after.
        let rawCalls = (((example["session"] as? [String: Any])?["messages"] as? [[String: Any]])?.first { $0["message_id"] as? String == "app-calls" }?["tool_calls"] as? [[String: Any]]) ?? []
        let expectedLogos = rawCalls.map { (($0["app"] as? [String: Any])?["logo_url"] as? String).flatMap(URL.init(string:)) }
        XCTAssertEqual(expectedLogos.map { $0 != nil }, [false, true, false])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "app-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "app-calls" }?.toolCalls ?? []] {
            XCTAssertEqual(calls.map(\.kind), [.mcp, .connector, .connector])
            XCTAssertEqual(calls.map { AssistantActivitySummary.label(for: $0) }, ["GitHub · Create issue", "Gmail · Send email (work)", "Notion · Create page"])
            XCTAssertEqual(calls.map { AssistantActivitySummary.icon(for: $0) }, ["server.rack", "cable.connector", "cable.connector"])
            XCTAssertEqual(calls.map { $0.app?.logoURL }, expectedLogos)
            var failed = try XCTUnwrap(calls.first)
            failed.isError = true
            XCTAssertEqual(AssistantActivitySummary.label(for: failed), "Failed to use GitHub · Create issue")
        }
        // Live, a tool frame carries the same app.
        let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id": "g", "name": "connectors__gmail__GMAIL_SEND_EMAIL", "kind": "connector", "target": "Send email", "app": {"name": "Gmail", "logo_url": null}}"#.utf8))
        XCTAssertEqual(event.app, ToolApp(name: "Gmail"))
        XCTAssertEqual(event.kind, .connector)
    }

    func testSharedWebSessionCarriesEachBrowserAndComputerCall() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-2328 has no such example.
        guard let example = object["tool_browser_views"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let answer = try XCTUnwrap(messages.first { $0.messageId == "browser-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        for calls in [timeline.toolCalls, groups.first { $0.anchorMessageID == "browser-calls" }?.toolCalls ?? []] {
            let byID = Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0) })
            XCTAssertEqual(calls.map(\.kind), [.browser, .browser, .browser, .browser, .browser, .computer, .computer])
            XCTAssertEqual(calls.map(\.verb), [.run, .send, .answer, .list, .fill, .capture, .click])
            XCTAssertEqual(calls.map { AssistantActivitySummary.label(for: $0) }, [
                "Ran Open the pricing page", "Sent Page.captureScreenshot", "Answered a dialog", "Listed saved logins", "Filled a login",
                "Captured the screen", "Clicked on the screen",
            ])
            XCTAssertEqual(calls.map { AssistantActivitySummary.icon(for: $0) }, Array(repeating: "macwindow", count: 5) + ["desktopcomputer", "desktopcomputer"])
            let ran = try XCTUnwrap(byID["call-exec"]?.resultView)
            XCTAssertEqual(ran.fileExcerpt?.path, "")
            XCTAssertEqual(ran.fileExcerpt?.lines.map(\.text), ["# Open the pricing page", "goto(\"https://example.com/pricing\")", "print(page_info())"])
            XCTAssertEqual(ran.stdout, "Pricing: $10/month")
            XCTAssertEqual(ran.media?.map(\.name), ["pricing.png"])
            XCTAssertEqual(byID["call-cdp"]?.resultView?.rows?.rows.map(\.label), ["Page.captureScreenshot"])
            XCTAssertEqual(byID["call-fill"]?.resultView?.rows?.rows.map(\.label), ["Filled 2 fields on https://example.com"])
            let capture = try XCTUnwrap(byID["call-capture"]?.resultView)
            XCTAssertEqual(capture.rows?.rows.map { [$0.label, $0.detail] }, [["Safari", "Pricing · 2 elements"]])
            XCTAssertEqual(capture.media?.map(\.name), ["cap_1.png"])
        }
    }

    func testSharedWebSessionCarriesEachFileEditsDiff() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // A release checks this App against every retained Web; one from before TAL-448 has no such example.
        guard let example = object["tool_edit_diffs"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let wantDiff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n import { run } from './run'\n-run(1)\n+run(2)\n+run(3)\n export {}"
        let expected = try XCTUnwrap(example["expected"] as? [String: Any])
        let want = try XCTUnwrap(ToolEditDiff(try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: expected["call-patch"] as Any))))
        XCTAssertEqual([want.added, want.removed], [2, 1])
        XCTAssertEqual(want.diff, wantDiff)
        // TAL-604: the server's hunks.
        XCTAssertEqual(want.hunks.map(\.displayLabel), ["Lines 1-4"])
        XCTAssertEqual(want.hunks.first?.lines.map(\.gutterLabel), ["1", "2", "2", "3", "4"])
        func edits(_ calls: [ToolCall]) -> [String: ToolEditDiff?] {
            Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0.editDiff) })
        }
        // The patch carries its change on the call and its scene row alike; the write, whose result has no diff, carries none.
        let answer = try XCTUnwrap(messages.first { $0.messageId == "edit-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        XCTAssertEqual(edits(timeline.toolCalls), ["call-patch": want, "call-write": nil])
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        XCTAssertEqual(edits(groups.first { $0.anchorMessageID == "edit-calls" }?.toolCalls ?? []), ["call-patch": want, "call-write": nil])
    }

    func testSharedWebSessionCarriesWriteAndSkillEditDiffsFromMetadata() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("web-session")) as? [String: Any])
        // TAL-909: a Web from before it has no such example.
        guard let example = object["tool_edit_metadata_diffs"] as? [String: Any] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: example["session"] as Any))
        let messages = try XCTUnwrap(session.messages)
        let expected = try XCTUnwrap(example["expected"] as? [String: Any])
        let want = try expected.mapValues { try ToolEditDiff(JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: $0))) }
        XCTAssertEqual(want["call-write"]??.added, 1)
        XCTAssertEqual(want["call-skill"]??.added, 1)
        func edits(_ calls: [ToolCall]) -> [String: ToolEditDiff?] {
            Dictionary(uniqueKeysWithValues: calls.map { ($0.id, $0.editDiff) })
        }
        let answer = try XCTUnwrap(messages.first { $0.messageId == "meta-answer" })
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: answer))
        XCTAssertEqual(edits(timeline.toolCalls), want)
        let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)
        XCTAssertEqual(edits(groups.first { $0.anchorMessageID == "meta-calls" }?.toolCalls ?? []), want)
    }

    func testSharedWebSessionRendersServerBuiltTurnScenes() async throws {
        let data = try fixture("web-session")
        let session = session { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, data)
        }
        defer { session.invalidateAndCancel() }
        let client = APIClient(baseURL: URL(string: "https://contract.example")!, session: session)
        let response = try await client.session(id: "contract-session")
        let messages = try XCTUnwrap(response.session?.messages)
        // A release checks this App against every retained Web. A Web from before server-built scenes stamps no turn
        // ids; against it every reply still yields its answer, from its stored scene or as plain text.
        guard messages.contains(where: { $0.turnId != nil }) else {
            let replies = messages.filter { $0.role == "assistant" }
            XCTAssertFalse(replies.isEmpty)
            for reply in replies {
                let answer = AssistantActivityTimeline.authoritativeScene(message: reply)
                    .flatMap { CompletedAssistantTurn(rows: $0.rows)?.finalAnswer } ?? reply.content
                XCTAssertFalse((answer ?? "").isEmpty, "\(reply.messageId ?? "reply") renders no answer")
            }
            return
        }
        func turn(_ messageID: String) throws -> CompletedAssistantTurn {
            let message = try XCTUnwrap(messages.first { $0.messageId == messageID })
            let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
            return try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
        }

        // Codex commentary is prose under Worked, before its tool; the answer renders below Worked.
        let codex = try turn("contract-run-c-2")
        XCTAssertEqual(codex.workRows.map(\.kind), ["reasoning", "prose", "tools"])
        XCTAssertEqual(codex.finalAnswer, "The service uses port 8080.")
        XCTAssertEqual(try turn("contract-run-d-2").finalAnswer, "Tool budget exhausted; here is the saved explanation.")
        // Earlier prose alone still folds under Worked; only the server's final answer stays visible.
        let twoReplies = try turn("contract-run-a-2")
        XCTAssertEqual(twoReplies.workRows.map(\.kind), ["prose"])
        XCTAssertEqual(twoReplies.finalAnswer, "Second reply in the same turn.")
        // A turn the server says has no answer never promotes its last prose.
        XCTAssertEqual(try turn("contract-run-e-1").finalAnswer, "")
        XCTAssertEqual(messages.first { $0.messageId == "contract-run-d-2" }?.activityScene?.expandedByDefault, true)
        XCTAssertEqual(messages.first { $0.messageId == "contract-run-c-2" }?.activityScene?.expandedByDefault, false)
        // The server's outcome decodes and renders in its localized wording; a completed turn shows none.
        func outcome(_ messageID: String) -> String? {
            AssistantTurnOutcome.label(for: messages.first { $0.messageId == messageID }?.activityScene?.terminalState)
        }
        XCTAssertEqual(outcome("contract-run-d-2"), "Tool limit reached")
        XCTAssertEqual(outcome("contract-run-e-1"), "No answer produced.")
        XCTAssertNil(outcome("contract-run-c-2"))
        // Stamped and legacy failed turns end their Live Activity by the server's outcome (fixtures from TAL-297 on).
        for (messageID, status) in [
            ("contract-run-x-1", AgentRunActivityStatus.cancelled),
            ("contract-run-y-1", .failed),
            ("contract-run-z-1", .cancelled),
        ] {
            guard let scene = messages.first(where: { $0.messageId == messageID })?.activityScene else { continue }
            XCTAssertEqual(LiveActivityReconciler.outcome(forTurnTerminalState: scene.terminalState).status, status, messageID)
        }
        // Persisted steers split the turn into phases whose lengths the server measured.
        let steered = try turn("contract-run-g-3")
        XCTAssertTrue(steered.hasSteering)
        XCTAssertEqual(steered.finalAnswer, "Both files read.")
        XCTAssertEqual(steered.phaseDurations(totalDuration: 12, finalPhaseDuration: 3), [5, 4, 3])
        XCTAssertNil(ChatViewModel.transcriptMessages(from: messages).first { $0.message.messageId == "contract-steer-1" })
        // The running turn has no scene: the live stream renders it.
        let running = try XCTUnwrap(messages.first { $0.messageId == "contract-run-f-1" })
        XCTAssertNil(AssistantActivityTimeline.authoritativeScene(message: running))
    }

    func testSharedWebSessionFlagsDriveStreamingAndReadOnly() throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("web-session")) as? [String: Any])
        // A Web from before server-validated flags (TAL-312) ships neither example; its session keeps the older shape.
        guard let stale = root["stale_stream_session"], let child = root["subagent_session"], let live = root["session"] else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        func summary(_ object: Any) throws -> SessionSummary {
            SessionSummary(from: try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: object)))
        }

        let running = try summary(live)
        XCTAssertEqual(running.isStreaming, true)
        XCTAssertTrue(SessionRowPresentation.isActiveStreaming(running))
        XCTAssertFalse(running.isSessionReadOnly)
        XCTAssertFalse(SessionRowPresentation.isActiveStreaming(try summary(stale)))
        XCTAssertTrue(try summary(child).isSessionReadOnly)
        XCTAssertEqual(running.canBranch, true)
        XCTAssertEqual(try summary(child).canBranch, false)
    }

    func testSharedRelaySnapshotAndRegistration() async throws {
        let snapshot = try fixture("relay-snapshot")
        let registration = try JSONSerialization.jsonObject(with: fixture("app-registration")) as! NSDictionary
        let session = session { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer contract-session-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            if request.httpMethod == "PUT" {
                let body = try XCTUnwrap(apiTestBodyData(from: request))
                XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? NSDictionary, registration)
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
            }
            XCTAssertEqual(request.url?.path, "/v1/activity-snapshot")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Device-Id"), "contract-device")
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, snapshot)
        }
        defer { session.invalidateAndCancel() }
        let credentials = TalariaRelayCredentials(
            baseURL: URL(string: "https://relay.example")!, deviceID: "contract-device",
            userID: "contract-user", appleUserID: "contract-apple", sessionToken: "contract-session-token"
        )
        let client = TalariaRelayClient(credentials: credentials, session: session)
        let aggregate = try await client.snapshot()
        XCTAssertEqual(aggregate?.schemaVersion, 1)
        XCTAssertEqual(aggregate?.rows.first?.publisherId, "https://contract.example")
        XCTAssertEqual(aggregate?.rows.first?.sessionId, "contract-session")
        // TAL-1422: the row carries the publisher's plan and worker counts.
        XCTAssertEqual(aggregate?.rows.first?.workCounts?.text, "Plan 2/5 · 3 workers")
        try await client.registerPerSession(
            activityID: "contract-activity", pushToken: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            publisherID: "https://contract.example", sessionID: "contract-session", streamID: "contract-stream"
        )
    }
}
