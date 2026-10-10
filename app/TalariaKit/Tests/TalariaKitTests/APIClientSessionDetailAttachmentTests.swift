import XCTest
@testable import TalariaKit

extension APIClientSessionDetailTests {
func testSessionDecodesMessageAttachments() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "user",
                "content": "Please analyze this",
                "_ts": 1770000000,
                "attachments": [
                  {"name": "report.pdf", "path": "/uploads/abc123/report.pdf", "mime": "application/pdf", "size": 1024},
                  {"name": "image.jpg", "path": "/uploads/abc123/image.jpg", "mime": "image/jpeg", "size": 2048, "is_image": true}
                ]
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)

    XCTAssertEqual(message.attachments?.count, 2)
    XCTAssertEqual(message.attachments?.first?.name, "report.pdf")
    XCTAssertEqual(message.attachments?.first?.path, "/uploads/abc123/report.pdf")
    XCTAssertEqual(message.attachments?.first?.mime, "application/pdf")
    XCTAssertEqual(message.attachments?.first?.size, 1024)
    XCTAssertNil(message.attachments?.first?.isImage)

    XCTAssertEqual(message.attachments?.last?.name, "image.jpg")
    XCTAssertEqual(message.attachments?.last?.isImage, true)
}

func testSessionDecodesTolerantMessageAttachments() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "user",
                "content": "Normal attachments",
                "_ts": 1770000000,
                "attachments": [
                  {"name": "report.pdf", "path": "/uploads/report.pdf", "mime": "application/pdf", "size": 1024},
                  {"filename": "image.jpg", "path": "/uploads/image.jpg", "mime": "image/jpeg", "size": 2048, "is_image": true}
                ]
              },
              {
                "role": "user",
                "content": "Legacy bare string",
                "_ts": 1770000001,
                "attachments": ["legacy_file.txt"]
              },
              {
                "role": "user",
                "content": "Mixed quality",
                "_ts": 1770000002,
                "attachments": [
                  {"name": "good.csv", "path": "/uploads/good.csv", "mime": "text/csv", "size": 42},
                  12345,
                  {"path": "/uploads/minimal.txt", "mime": "text/plain"}
                ]
              },
              {
                "role": "user",
                "content": "Null attachments",
                "_ts": 1770000003,
                "attachments": null
              },
              {
                "role": "user",
                "content": "No attachments key",
                "_ts": 1770000004
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let messages = try XCTUnwrap(response.session?.messages)
    XCTAssertEqual(messages.count, 5)

    // Message 1: normal + filename alias
    let msg1 = messages[0]
    XCTAssertEqual(msg1.attachments?.count, 2)
    XCTAssertEqual(msg1.attachments?[0].name, "report.pdf")
    XCTAssertEqual(msg1.attachments?[0].size, 1024)
    XCTAssertEqual(msg1.attachments?[1].name, "image.jpg")
    XCTAssertEqual(msg1.attachments?[1].isImage, true)

    // Message 2: legacy bare string
    let msg2 = messages[1]
    XCTAssertEqual(msg2.attachments?.count, 1)
    XCTAssertEqual(msg2.attachments?.first?.name, "legacy_file.txt")
    XCTAssertNil(msg2.attachments?.first?.path)

    // Message 3: mixed quality — malformed entries are dropped
    let msg3 = messages[2]
    XCTAssertEqual(msg3.attachments?.count, 2)
    XCTAssertEqual(msg3.attachments?[0].name, "good.csv")
    XCTAssertEqual(msg3.attachments?[1].path, "/uploads/minimal.txt")
    XCTAssertNil(msg3.attachments?[1].name)

    // Message 4: explicit null
    let msg4 = messages[3]
    XCTAssertNil(msg4.attachments)

    // Message 5: missing key
    let msg5 = messages[4]
    XCTAssertNil(msg5.attachments)
}

// TAL-602: attachments come only from the server's `attachments` field. An
// assistant reply quoting the marker line gains no attachment, and the text
// renders as the server shipped it.
func testSessionShowsNoAttachmentForAnAssistantReplyEndingInTheMarker() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "assistant",
                "content": "The Web app appends this line:\\n\\n[Attached files: x.png]",
                "_ts": 1770000000
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)

    XCTAssertNil(message.attachments)
    XCTAssertEqual(message.content, "The Web app appends this line:\n\n[Attached files: x.png]")
}

func testSessionRendersUserUploadsFromTheServerAttachmentsFieldOnly() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [
              {
                "role": "user",
                "content": "Review these\\n\\n[Attached files: /Users/hermes/projects/workspace/other.jpg]",
                "_ts": 1770000000,
                "attachments": [
                  "notes.txt",
                  {"name": "photo.png", "path": "/tmp/workspace/photo.png", "isImage": true}
                ]
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)

    XCTAssertEqual(message.attachments, [
        MessageAttachment(name: "notes.txt"),
        MessageAttachment(name: "photo.png", path: "/tmp/workspace/photo.png", isImage: true)
    ])
}

func testSessionDecodesWebUICreatedSessionWithUnexpectedOptionalFieldTypes() async throws {
    let client = makeClient { request in
        XCTAssertEqual(request.url?.path, "/api/session")
        XCTAssertEqual(request.httpMethod, "GET")

        return apiTestJSONResponse("""
        {
          "session": {
            "session_id": 12345,
            "title": 987,
            "message_count": "2",
            "pinned": "false",
            "estimated_cost": "0.12",
            "pending_attachments": {"unexpected": true},
            "messages": [
              {
                "role": "user",
                "content": [
                  {"type": "text", "text": "Hello from rich content"}
                ],
                "_ts": "1770000000.5",
                "message_id": 42,
                "attachments": [
                  {"filename": "image.png", "path": "/uploads/image.png", "size": "2048", "is_image": "true"},
                  12345
                ]
              },
              {
                "role": "assistant",
                "content": "Loaded",
                "timestamp": 1770000001,
                "tool_calls": {"unexpected": "shape"},
                "reasoning": {"text": "not the persisted string"}
              }
            ],
            "tool_calls": [
              {
                "name": "read_file",
                "snippet": 123,
                "tid": 456,
                "assistant_msg_idx": "4",
                "args": ["unexpected"]
              },
              "malformed"
            ],
            "_messages_offset": "4",
            "_messages_truncated": "true"
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "webui-created")
    let session = try XCTUnwrap(response.session)

    XCTAssertEqual(session.sessionId, "12345")
    XCTAssertEqual(session.title, "987")
    XCTAssertEqual(session.messageCount, 2)
    XCTAssertEqual(session.pinned, false)
    XCTAssertEqual(session.estimatedCost ?? -1, 0.12, accuracy: 0.0001)
    XCTAssertNil(session.pendingAttachments)
    XCTAssertEqual(session.messagesOffset, 4)
    XCTAssertEqual(session.messagesTruncated, true)

    let messages = try XCTUnwrap(session.messages)
    XCTAssertEqual(messages.count, 2)
    XCTAssertEqual(messages[0].role, "user")
    XCTAssertTrue(messages[0].content?.contains("Hello from rich content") == true)
    XCTAssertEqual(messages[0].timestamp, 1_770_000_000.5)
    XCTAssertEqual(messages[0].messageId, "42")
    XCTAssertEqual(messages[0].attachments?.count, 1)
    XCTAssertEqual(messages[0].attachments?.first?.name, "image.png")
    XCTAssertEqual(messages[0].attachments?.first?.size, 2048)
    XCTAssertEqual(messages[0].attachments?.first?.isImage, true)

    XCTAssertEqual(messages[1].content, "Loaded")
    XCTAssertNil(messages[1].toolCalls)
    XCTAssertNil(messages[1].reasoning)

    let toolCall = try XCTUnwrap(session.toolCalls?.first)
    XCTAssertEqual(session.toolCalls?.count, 1)
    XCTAssertEqual(toolCall.name, "read_file")
    XCTAssertEqual(toolCall.snippet, "123")
    XCTAssertEqual(toolCall.tid, "456")
    XCTAssertEqual(toolCall.assistantMsgIdx, 4)
    XCTAssertNil(toolCall.args)
}

func testSessionToleratesNumericFieldsOutsideIntRange() async throws {
    // Values beyond Int range reach the lossy int decoder's Double branch,
    // which used to trap instead of decoding to nil (#62).
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "huge-numbers",
            "message_count": 1e300,
            "input_tokens": -1e300,
            "output_tokens": "1e300",
            "context_window_tokens": 9223372036854775808,
            "messages": [
              {"role": "assistant", "content": "Still standing"}
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "huge-numbers")
    let session = try XCTUnwrap(response.session)

    XCTAssertNil(session.messageCount)
    XCTAssertNil(session.inputTokens)
    XCTAssertNil(session.outputTokens)
    XCTAssertNil(session.contextWindowTokens)
    XCTAssertEqual(session.messages?.first?.content, "Still standing")
}

func testSessionDecodesCompressionReference() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "compression_reference": {"text": "Summary of the compacted conversation.", "after_message_index": 7}
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let session = try XCTUnwrap(response.session)

    XCTAssertEqual(session.compressionReference, CompressionReference(text: "Summary of the compacted conversation.", afterMessageIndex: 7))
}

func testSessionCompressionReferenceAboveTranscriptOrAbsent() async throws {
    let bodies = [
        "a": #"{"session": {"session_id": "a", "compression_reference": {"text": "Only a summary.", "after_message_index": null}}}"#,
        "b": #"{"session": {"session_id": "b", "compression_reference": null}}"#,
        "c": #"{"session": {"session_id": "c", "compression_reference": "unexpected-string"}}"#,
        "d": #"{"session": {"session_id": "d"}}"#,
    ]
    let client = makeClient { request in
        let id = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "session_id" }?.value
        return apiTestJSONResponse(try XCTUnwrap(bodies[id ?? ""]), for: request)
    }

    let aboveResponse = try await client.session(id: "a")
    let above = try XCTUnwrap(aboveResponse.session)
    XCTAssertEqual(above.compressionReference, CompressionReference(text: "Only a summary.", afterMessageIndex: nil))
    for id in ["b", "c", "d"] {
        let response = try await client.session(id: id)
        let session = try XCTUnwrap(response.session)
        XCTAssertEqual(session.sessionId, id)
        XCTAssertNil(session.compressionReference)
    }
}

}
