import XCTest
@testable import TalariaKit

extension APIClientSessionDetailTests {
func testSessionRequestBuildsExpectedQuery() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(query["session_id"], "abc123")
        XCTAssertEqual(query["messages"], "1")
        XCTAssertEqual(query["msg_limit"], "25")
        XCTAssertEqual(query["msg_before"], "50")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {"role": "user", "content": "Hello", "_ts": 1770000000},
              {"role": "assistant", "content": "Hi", "timestamp": 1770000001}
            ],
            "_messages_truncated": true,
            "_messages_offset": 25
          }
        }
        """, for: request)
    }

    let response = try await client.session(
        id: "abc123",
        includeMessages: true,
        messageLimit: 25,
        messageBefore: 50
    )

    XCTAssertEqual(response.session?.sessionId, "abc123")
    XCTAssertEqual(response.session?.messages?.count, 2)
    XCTAssertEqual(response.session?.messages?.first?.timestamp, 1_770_000_000)
    XCTAssertEqual(response.session?.messagesTruncated, true)
    XCTAssertEqual(response.session?.messagesOffset, 25)
}

func testSessionColdLoadSendsExpandRenderableFlag() async throws {
    let client = makeClient { request in
        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(query["session_id"], "abc123")
        XCTAssertEqual(query["msg_limit"], "50")
        XCTAssertEqual(query["expand_renderable"], "1")
        XCTAssertNil(query["msg_before"])

        return apiTestJSONResponse("""
        { "session": { "session_id": "abc123" } }
        """, for: request)
    }

    _ = try await client.session(
        id: "abc123",
        includeMessages: true,
        messageLimit: 50,
        expandRenderable: true
    )
}

func testSessionLoadEarlierOmitsExpandRenderableFlag() async throws {
    let client = makeClient { request in
        let components = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(query["msg_before"], "100")
        XCTAssertNil(query["expand_renderable"])

        return apiTestJSONResponse("""
        { "session": { "session_id": "abc123" } }
        """, for: request)
    }

    _ = try await client.session(
        id: "abc123",
        includeMessages: true,
        messageLimit: 50,
        messageBefore: 100
    )
}

func testSessionDecodesPersistedToolCalls() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {"role": "assistant", "content": "I checked the file.", "_ts": 1770000000}
            ],
            "tool_calls": [
              {
                "name": "read_file",
                "snippet": "let value = 42",
                "tid": "call_123",
                "assistant_msg_idx": 12,
                "args": {
                  "path": "/tmp/example.swift",
                  "limit": 120
                }
              }
            ],
            "_messages_offset": 12
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let toolCall = try XCTUnwrap(response.session?.toolCalls?.first)

    XCTAssertEqual(toolCall.name, "read_file")
    XCTAssertEqual(toolCall.snippet, "let value = 42")
    XCTAssertEqual(toolCall.tid, "call_123")
    XCTAssertEqual(toolCall.assistantMsgIdx, 12)
    XCTAssertEqual(toolCall.args?["path"], .string("/tmp/example.swift"))
    XCTAssertEqual(toolCall.args?["limit"], .number(120))
}

func testSessionDecodesPersistedAssistantReasoning() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "assistant",
                "content": "The file defines a SwiftUI view.",
                "reasoning": "I inspected the file and looked for the main type.",
                "reasoning_titles": ["Inspecting the Swift file"],
                "_ts": 1770000000
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)

    XCTAssertEqual(message.reasoning, "I inspected the file and looked for the main type.")
    XCTAssertEqual(message.reasoningTitles, ["Inspecting the Swift file"])
}

func testSessionPrefersPersistedReasoningContentOverSummary() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "assistant",
                "content": "",
                "reasoning": "Planning current directory and date usage",
                "reasoning_content": "The writing guidance is unchanged. I’ll now check the live workspace and repository independently.",
                "_turnDuration": 532,
                "tool_calls": [{"id":"call-1","function":{"name":"terminal","arguments":"{}"}}]
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)

    XCTAssertEqual(
        message.reasoning,
        "The writing guidance is unchanged. I’ll now check the live workspace and repository independently."
    )
    XCTAssertEqual(message.turnDuration, 532)
}

}
