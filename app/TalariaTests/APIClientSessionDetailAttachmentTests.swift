import XCTest
@testable import Talaria
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

func testSessionInfersAttachmentsFromAttachedFilesMarkerWhenServerOmitsMetadata() async throws {
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
                "content": "Analyze these\\n\\n[Attached files: image_1778030812_E9EE.jpg, /Users/hermes/projects/workspace/17mb.csv]",
                "_ts": 1770000000
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)
    let attachments = try XCTUnwrap(message.attachments)

    XCTAssertEqual(attachments.count, 2)
    XCTAssertEqual(attachments[0].name, "image_1778030812_E9EE.jpg")
    XCTAssertEqual(attachments[0].path, "/Users/hermes/projects/workspace/image_1778030812_E9EE.jpg")
    XCTAssertEqual(attachments[0].isImage, true)
    XCTAssertEqual(attachments[1].name, "17mb.csv")
    XCTAssertEqual(attachments[1].path, "/Users/hermes/projects/workspace/17mb.csv")
    XCTAssertEqual(attachments[1].isImage, false)
}

func testSessionEnrichesLegacyAttachmentNamesFromAttachedFilesMarkerPaths() async throws {
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
                "content": "Review these\\n\\n[Attached files: /Users/hermes/projects/workspace/image_1778032969_13BE.jpg, /Users/hermes/projects/workspace/hermes-agent-slideshow.html]",
                "_ts": 1770000000,
                "attachments": [
                  "image_1778032969_13BE.jpg",
                  "hermes-agent-slideshow.html"
                ]
              }
            ]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)
    let attachments = try XCTUnwrap(message.attachments)

    XCTAssertEqual(attachments.count, 2)
    XCTAssertEqual(attachments[0].name, "image_1778032969_13BE.jpg")
    XCTAssertEqual(attachments[0].path, "/Users/hermes/projects/workspace/image_1778032969_13BE.jpg")
    XCTAssertEqual(attachments[0].isImage, true)
    XCTAssertEqual(attachments[1].name, "hermes-agent-slideshow.html")
    XCTAssertEqual(attachments[1].path, "/Users/hermes/projects/workspace/hermes-agent-slideshow.html")
    XCTAssertEqual(attachments[1].isImage, false)
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
            "context_length": 9223372036854775808,
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
    XCTAssertNil(session.contextLength)
    XCTAssertEqual(session.messages?.first?.content, "Still standing")
}

func testSessionDecodesCompressionAnchorMetadata() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "compression_anchor_visible_idx": 7,
            "compression_anchor_message_key": {
              "role": "user",
              "ts": 1770000000.5,
              "text": "What does the resolver do?",
              "attachments": 1
            },
            "compression_anchor_summary": "Summary of the compacted conversation."
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let session = try XCTUnwrap(response.session)

    XCTAssertEqual(session.compressionAnchorVisibleIdx, 7)
    XCTAssertEqual(session.compressionAnchorMessageKey?.role, "user")
    XCTAssertEqual(session.compressionAnchorMessageKey?.ts, 1_770_000_000.5)
    XCTAssertEqual(session.compressionAnchorMessageKey?.text, "What does the resolver do?")
    XCTAssertEqual(session.compressionAnchorMessageKey?.attachments, 1)
    XCTAssertEqual(session.compressionAnchorSummary, "Summary of the compacted conversation.")
}

func testSessionWithoutCompressionAnchorMetadataDecodesNil() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        { "session": { "session_id": "abc123" } }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let session = try XCTUnwrap(response.session)

    XCTAssertNil(session.compressionAnchorVisibleIdx)
    XCTAssertNil(session.compressionAnchorMessageKey)
    XCTAssertNil(session.compressionAnchorSummary)
}

func testSessionToleratesMalformedCompressionAnchorMetadata() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "compression_anchor_visible_idx": "not-a-number",
            "compression_anchor_message_key": "unexpected-string",
            "compression_anchor_summary": ["unexpected", "array"]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let session = try XCTUnwrap(response.session)

    XCTAssertEqual(session.sessionId, "abc123")
    XCTAssertNil(session.compressionAnchorVisibleIdx)
    XCTAssertNil(session.compressionAnchorMessageKey)
    XCTAssertNil(session.compressionAnchorSummary)
}

func testSessionDecodesPartialAndLossyCompressionAnchorKeyFields() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "compression_anchor_visible_idx": "12",
            "compression_anchor_message_key": {
              "role": "assistant",
              "ts": null,
              "text": "Partial key",
              "attachments": "3",
              "unexpected_extra": {"nested": true}
            }
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let session = try XCTUnwrap(response.session)

    XCTAssertEqual(session.compressionAnchorVisibleIdx, 12)
    XCTAssertEqual(session.compressionAnchorMessageKey?.role, "assistant")
    XCTAssertNil(session.compressionAnchorMessageKey?.ts)
    XCTAssertEqual(session.compressionAnchorMessageKey?.text, "Partial key")
    XCTAssertEqual(session.compressionAnchorMessageKey?.attachments, 3)
    XCTAssertNil(session.compressionAnchorSummary)
}

}
