import XCTest
@testable import TalariaKit

final class APIClientCronEndpointTests: APIClientTestCase {
    func testCronsBuildsExpectedPathAndDecodesTolerantJobList() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.url?.query)

            return apiTestJSONResponse("""
            {
              "jobs": [
                {
                  "id": "job123",
                  "name": "Morning digest",
                  "prompt": "Summarize overnight activity",
                  "schedule": {"kind": "cron", "expr": "0 7 * * *", "unexpected": true},
                  "schedule_display": "0 7 * * *",
                  "enabled": true,
                  "state": "scheduled",
                  "next_run_at": "2026-05-05T11:00:00Z",
                  "last_run_at": 1777892400,
                  "last_status": "ok",
                  "derived_state": "active",
                  "deliver": "local",
                  "skills": ["summarize", "notify"],
                  "ignored_new_field": {"nested": "value"}
                },
                {
                  "id": "legacy-broken",
                  "schedule": {"kind": "cron", "expr": "0 8 * * *"},
                  "repeat": {"times": null, "completed": 17},
                  "enabled": false,
                  "state": "completed",
                  "next_run_at": null,
                  "last_status": "ok",
                  "derived_state": "needs_attention",
                  "needs_attention": true,
                  "resumable": true
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.crons()
        let first = try XCTUnwrap(response.jobs?.first)
        let second = try XCTUnwrap(response.jobs?.last)

        XCTAssertEqual(first.jobId, "job123")
        XCTAssertEqual(first.displayName, "Morning digest")
        XCTAssertEqual(first.scheduleText, "0 7 * * *")
        let nextRunAt = try XCTUnwrap(first.nextRunAt)
        let lastRunAt = try XCTUnwrap(first.lastRunAt)
        XCTAssertEqual(nextRunAt.date.timeIntervalSince1970, 1_777_978_800, accuracy: 0.1)
        XCTAssertEqual(lastRunAt.date.timeIntervalSince1970, 1_777_892_400, accuracy: 0.1)
        XCTAssertFalse(nextRunAt.formatted.isEmpty)
        XCTAssertEqual(first.skills, ["summarize", "notify"])
        XCTAssertEqual(first.status, .active)

        XCTAssertEqual(second.status, .needsAttention)
        XCTAssertEqual(second.resumable, true)
        XCTAssertEqual(second.displayName, "0 8 * * *")
    }

    func testCronStatusWithoutJobIDBuildsExpectedPathAndDecodesRunningMap() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/status")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.url?.query)

            return apiTestJSONResponse("""
            {
              "running": {
                "job123": 12.4,
                "job456": 61
              }
            }
            """, for: request)
        }

        let response = try await client.cronStatus()

        XCTAssertEqual(response.runningJobs?["job123"], 12.4)
        XCTAssertEqual(response.runningJobs?["job456"], 61)
        XCTAssertNil(response.running)
    }

    func testCronStatusWithJobIDBuildsExpectedQueryAndDecodesSingleStatus() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/status")
            XCTAssertEqual(request.httpMethod, "GET")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["job_id"], "job123")

            return apiTestJSONResponse("""
            {
              "job_id": "job123",
              "running": true,
              "elapsed": 12.4
            }
            """, for: request)
        }

        let response = try await client.cronStatus(jobID: "job123")

        XCTAssertEqual(response.jobId, "job123")
        XCTAssertEqual(response.running, true)
        XCTAssertEqual(response.elapsed, 12.4)
        XCTAssertNil(response.runningJobs)
    }

    func testCronOutputBuildsExpectedQueryAndDecodesResponse() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/output")
            XCTAssertEqual(request.httpMethod, "GET")

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["job_id"], "job123")
            XCTAssertEqual(query["limit"], "5")

            return apiTestJSONResponse("""
            {
              "job_id": "job123",
              "outputs": [
                {
                  "filename": "2026-05-04_10-00-00.md",
                  "content": "## Response\\n\\nAll clear."
                },
                {
                  "filename": "2026-05-04_09-00-00.md",
                  "content": ""
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.cronOutput(jobID: "job123", limit: 5)

        XCTAssertEqual(response.jobId, "job123")
        XCTAssertEqual(response.outputs?.count, 2)
        XCTAssertEqual(response.outputs?.first?.filename, "2026-05-04_10-00-00.md")
        XCTAssertEqual(response.outputs?.first?.content, "## Response\n\nAll clear.")
        XCTAssertEqual(response.outputs?.last?.filename, "2026-05-04_09-00-00.md")
        XCTAssertEqual(response.outputs?.last?.content, "")
    }

    func testCronCreateBuildsExpectedBodyAndDecodesMutationResponse() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/create")
            XCTAssertEqual(request.httpMethod, "POST")

            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["prompt"] as? String, "Summarize overnight activity")
            XCTAssertEqual(body?["schedule"] as? String, "0 7 * * *")
            XCTAssertEqual(body?["name"] as? String, "Morning digest")
            XCTAssertEqual(body?["deliver"] as? String, "local")
            XCTAssertEqual(body?["skills"] as? [String], ["summarize", "notify"])
            XCTAssertEqual(body?["model"] as? String, "@openai:gpt-5.5")
            XCTAssertNil(body?["provider"], "Omitted provider must not be sent so the server default applies.")
            XCTAssertEqual(body?["profile"] as? String, "work")
            XCTAssertEqual(body?["toast_notifications"] as? Bool, true)

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "job_id": "job-new",
                "name": "Morning digest",
                "prompt": "Summarize overnight activity",
                "schedule": "0 7 * * *",
                "enabled": true,
                "state": "scheduled",
                "model": "@openai:gpt-5.5",
                "profile": "work",
                "toast_notifications": true
              }
            }
            """, for: request)
        }

        let response = try await client.createCron(
            prompt: "Summarize overnight activity",
            schedule: "0 7 * * *",
            name: "Morning digest",
            deliver: "local",
            skills: ["summarize", "notify"],
            model: "@openai:gpt-5.5",
            provider: nil,
            profile: "work",
            toastNotifications: true
        )

        XCTAssertEqual(response.ok, true)
        XCTAssertEqual(response.job?.jobId, "job-new")
        XCTAssertEqual(response.job?.scheduleText, "0 7 * * *")
        XCTAssertEqual(response.job?.model, "@openai:gpt-5.5")
        XCTAssertEqual(response.job?.toastNotifications, true)
    }

    func testCronUpdateBuildsExpectedBodyAndDecodesMutationResponse() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/update")
            XCTAssertEqual(request.httpMethod, "POST")

            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["job_id"] as? String, "job123")
            XCTAssertEqual(body?["prompt"] as? String, "Updated prompt")
            XCTAssertEqual(body?["schedule"] as? String, "0 8 * * *")
            XCTAssertEqual(body?["name"] as? String, "Updated digest")
            XCTAssertEqual(body?["deliver"] as? String, "local")
            XCTAssertEqual(body?["skills"] as? [String], ["swift"])
            XCTAssertEqual(body?["model"] as? String, "@anthropic:claude")
            XCTAssertEqual(body?["provider"] as? String, "anthropic")
            XCTAssertEqual(body?["profile"] as? String, "personal")
            XCTAssertEqual(body?["toast_notifications"] as? Bool, false)

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "id": "job123",
                "name": "Updated digest",
                "prompt": "Updated prompt",
                "schedule": {"kind": "cron", "expr": "0 8 * * *"},
                "enabled": true,
                "state": "scheduled",
                "model": "@anthropic:claude",
                "provider": "anthropic",
                "profile": "personal",
                "toast_notifications": false
              }
            }
            """, for: request)
        }

        let response = try await client.updateCron(
            jobID: "job123",
            prompt: "Updated prompt",
            schedule: "0 8 * * *",
            name: "Updated digest",
            deliver: "local",
            skills: ["swift"],
            model: "@anthropic:claude",
            provider: "anthropic",
            profile: "personal",
            toastNotifications: false
        )

        XCTAssertEqual(response.job?.jobId, "job123")
        XCTAssertEqual(response.job?.displayName, "Updated digest")
        XCTAssertEqual(response.job?.scheduleText, "0 8 * * *")
        XCTAssertEqual(response.job?.model, "@anthropic:claude")
        XCTAssertEqual(response.job?.provider, "anthropic")
        XCTAssertEqual(response.job?.toastNotifications, false)
    }

    func testCronCreateSendsProviderWhenSet() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/create")
            XCTAssertEqual(request.httpMethod, "POST")

            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["provider"] as? String, "openai")

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "id": "job-provider",
                "prompt": "Run it",
                "schedule": "0 7 * * *",
                "provider": "openai"
              }
            }
            """, for: request)
        }

        let response = try await client.createCron(
            prompt: "Run it",
            schedule: "0 7 * * *",
            name: nil,
            deliver: nil,
            skills: [],
            model: nil,
            provider: "openai",
            profile: nil,
            toastNotifications: true
        )

        XCTAssertEqual(response.job?.provider, "openai")
    }

    func testCronDeliveryOptionsBuildsExpectedPathAndDecodesTolerantly() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/delivery-options")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.url?.query)

            return apiTestJSONResponse("""
            {
              "platforms": [
                {"value": "local", "label": "Local (save output only)"},
                {"value": "origin", "label": "Origin (reply to creator)"},
                {"value": "slack", "label": "Slack", "unexpected_field": {"nested": true}},
                {"value": "telegram"}
              ],
              "ignored_new_field": 7
            }
            """, for: request)
        }

        let response = try await client.cronDeliveryOptions()
        let platforms = try XCTUnwrap(response.platforms)

        XCTAssertEqual(platforms.map(\.value), ["local", "origin", "slack", "telegram"])
        XCTAssertEqual(platforms.first?.label, "Local (save output only)")
        XCTAssertNil(platforms.last?.label)
    }

    func testCronDeliveryOptionsToleratesUnexpectedPlatformsShape() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"platforms": "unexpected"}"#, for: request)
        }

        let response = try await client.cronDeliveryOptions()

        XCTAssertNil(response.platforms)
    }

    func testCronJobIDMutationsBuildExpectedPathsAndBodies() async throws {
        var expectedRequests: [(path: String, reason: String?)] = [
            ("/api/crons/run", nil),
            ("/api/crons/pause", "Manual pause"),
            ("/api/crons/resume", nil),
            ("/api/crons/delete", nil)
        ]

        let client = makeClient { request in
            let expected = expectedRequests.removeFirst()
            XCTAssertEqual(request.url?.path, expected.path)
            XCTAssertEqual(request.httpMethod, "POST")

            let data = try XCTUnwrap(apiTestBodyData(from: request))
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["job_id"] as? String, "job123")
            XCTAssertEqual(body?["reason"] as? String, expected.reason)

            return apiTestJSONResponse("""
            {
              "ok": true,
              "job": {
                "id": "job123",
                "name": "Digest",
                "enabled": true,
                "state": "scheduled"
              }
            }
            """, for: request)
        }

        let runResponse = try await client.runCron(jobID: "job123")
        let pauseResponse = try await client.pauseCron(jobID: "job123", reason: "Manual pause")
        let resumeResponse = try await client.resumeCron(jobID: "job123")
        let deleteResponse = try await client.deleteCron(jobID: "job123")

        XCTAssertEqual(runResponse.job?.jobId, "job123")
        XCTAssertEqual(pauseResponse.job?.jobId, "job123")
        XCTAssertEqual(resumeResponse.job?.jobId, "job123")
        XCTAssertEqual(deleteResponse.job?.jobId, "job123")
        XCTAssertTrue(expectedRequests.isEmpty)
    }

    func testCronRecentCompletionsDecodesTolerantly() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/recent")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)

            return apiTestJSONResponse("""
            {
              "completions": [
                {
                  "job_id": "job123",
                  "name": "Digest",
                  "status": "success",
                  "outcome": "succeeded",
                  "completed_at": 1777892400.5,
                  "toast_notifications": true,
                  "session_id": "sess-1",
                  "message_count": 4
                },
                {"job_id": "job456", "name": null, "status": "error", "outcome": "failed", "completed_at": 1777892300},
                {"job_id": "job789", "outcome": "a-new-outcome", "completed_at": "1777892200"},
                {"job_id": "", "name": "Legacy", "outcome": "failed", "completed_at": 1},
                "not-a-completion",
                {}
              ],
              "since": 0
            }
            """, for: request)
        }

        let response = try await client.cronRecentCompletions()
        let completions = try XCTUnwrap(response.completions)

        XCTAssertEqual(completions.map(\.jobId), ["job123", "job456", "job789"], "Rows without a job ID must be skipped.")
        XCTAssertEqual(completions.map(\.outcome), [.succeeded, .failed, .unknown])
        XCTAssertEqual(completions[0].completedAt?.timeIntervalSince1970, 1777892400.5)
        XCTAssertEqual(completions[1].displayName, "Untitled Task")
        XCTAssertNil(completions[2].completedAt, "The app must not parse string timestamps.")
    }

    func testCronHistoryBuildsExpectedQueryAndSkipsMalformedRows() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/history")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["job_id"], "job123")
            XCTAssertEqual(query["offset"], "20")
            XCTAssertEqual(query["limit"], "20")

            return apiTestJSONResponse("""
            {
              "job_id": "job123",
              "runs": [
                {
                  "filename": "2026-05-04_10-00-00.md",
                  "size": 2048,
                  "modified": 1777892400.5,
                  "usage": {
                    "model": "fixture-model",
                    "input_tokens": "1,200",
                    "output_tokens": 300,
                    "total_tokens": 1500,
                    "estimated_cost_usd": 0.0123,
                    "duration_seconds": 4.5,
                    "unexpected": true
                  }
                },
                "not-a-run",
                {"filename": "2026-05-04_09-00-00.md", "size": "oops", "modified": "garbage", "usage": []},
                {"filename": "2026-05-04_08-00-00.md", "size": 0, "modified": 1777885200, "usage": {}}
              ],
              "total": 57,
              "offset": 20
            }
            """, for: request)
        }

        let response = try await client.cronHistory(jobID: "job123", offset: 20, limit: 20)

        XCTAssertEqual(response.jobId, "job123")
        XCTAssertEqual(response.total, 57)
        XCTAssertEqual(response.offset, 20)
        let runs = try XCTUnwrap(response.runs)
        XCTAssertEqual(runs.map(\.filename), ["2026-05-04_10-00-00.md", "2026-05-04_09-00-00.md", "2026-05-04_08-00-00.md"])

        let first = runs[0]
        XCTAssertEqual(first.size, 2048)
        XCTAssertEqual(try XCTUnwrap(first.modified).date.timeIntervalSince1970, 1_777_892_400.5, accuracy: 0.01)
        XCTAssertEqual(first.usage?.model, "fixture-model")
        XCTAssertEqual(first.usage?.inputTokens, nil, "Non-numeric token strings decode to nil rather than failing the row.")
        XCTAssertEqual(first.usage?.outputTokens, 300)
        XCTAssertEqual(first.usage?.totalTokens, 1500)
        XCTAssertEqual(first.usage?.estimatedCostUsd, 0.0123)
        XCTAssertEqual(first.usage?.durationSeconds, 4.5)

        let malformed = runs[1]
        XCTAssertNil(malformed.size)
        XCTAssertNil(malformed.modified)
        XCTAssertNil(malformed.usage)

        let empty = runs[2]
        XCTAssertEqual(empty.size, 0)
        XCTAssertEqual(empty.usage?.isEmpty, true)
    }

    func testCronHistoryDecodesEmptyAndMissingRuns() async throws {
        let client = makeClient { request in
            apiTestJSONResponse(#"{"job_id": "job123", "runs": [], "total": 0, "offset": 0}"#, for: request)
        }
        let response = try await client.cronHistory(jobID: "job123", offset: 0, limit: 20)
        XCTAssertEqual(response.runs, [])
        XCTAssertEqual(response.total, 0)

        let legacyClient = makeClient { request in
            apiTestJSONResponse("{}", for: request)
        }
        let legacy = try await legacyClient.cronHistory(jobID: "job123", offset: 0, limit: 20)
        XCTAssertNil(legacy.runs)
        XCTAssertNil(legacy.total)
    }

    func testCronRunDetailUsesGetWithoutTriggeringRunAction() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/run")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.httpBodyStream)

            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["job_id"], "job123")
            XCTAssertEqual(query["filename"], "2026-05-04_10-00-00.md")

            return apiTestJSONResponse("""
            {
              "job_id": "job123",
              "filename": "2026-05-04_10-00-00.md",
              "content": "**Model:** fixture-model\\n\\n## Response\\n\\nAll clear.",
              "snippet": "All clear.",
              "usage": {"model": "fixture-model"}
            }
            """, for: request)
        }

        let response = try await client.cronRunDetail(jobID: "job123", filename: "2026-05-04_10-00-00.md")

        XCTAssertEqual(response.filename, "2026-05-04_10-00-00.md")
        XCTAssertEqual(response.content, "**Model:** fixture-model\n\n## Response\n\nAll clear.")
        XCTAssertEqual(response.snippet, "All clear.")
        XCTAssertEqual(response.usage?.model, "fixture-model")
    }

    func testCronOutputOmitsLimitWhenNil() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/crons/output")
            XCTAssertEqual(request.httpMethod, "GET")
            let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
            XCTAssertEqual(query["job_id"], "job456")
            XCTAssertNil(query["limit"])

            return apiTestJSONResponse("""
            {
              "job_id": "job456",
              "outputs": []
            }
            """, for: request)
        }

        let response = try await client.cronOutput(jobID: "job456", limit: nil)
        XCTAssertEqual(response.outputs?.count, 0)
    }
}
