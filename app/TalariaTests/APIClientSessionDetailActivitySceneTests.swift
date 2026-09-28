import XCTest
@testable import Talaria
@testable import TalariaKit

extension APIClientSessionDetailTests {
func testSessionDecodesActivitySceneInOrder() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [{
              "role": "assistant",
              "content": "After tool.",
              "message_id": "assistant-1",
              "_anchor_activity_scene": {
                "version": "activity_scene_v1",
                "final_answer": "After tool.",
                "activity_rows": [
                  {"row_id":"tool:call-1","order_index":2,"role":"tool","tool":{"id":"call-1","name":"read_file","args":{"path":"notes.md"},"preview":"contents","result":"contents","done":true,"is_error":false,"duration":null,"cost_usd":null}},
                  {"row_id":"prose-1","order_index":0,"role":"prose","text":"Before tool."},
                  {"row_id":"thinking-1","order_index":1,"role":"reasoning","text":"I should inspect now.","titles":["Planning implementation"]}
                ]
              }
            }]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)
    let timeline = AssistantActivityTimeline.persisted(
        message: message,
        reasoningGroups: [],
        toolCallGroups: []
    )

    XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "reasoning", "tools", "prose"])
    XCTAssertEqual(timeline.rows.compactMap(\.text), ["Before tool.", "I should inspect now.", "After tool."])
    guard case .reasoning(let reasoning) = timeline.rows[1].content else {
        return XCTFail("Expected a reasoning row")
    }
    XCTAssertEqual(reasoning.titles, ["Planning implementation"])
    XCTAssertEqual(timeline.toolCalls.map(\.id), ["call-1"])
    XCTAssertEqual(timeline.toolCalls.first?.preview, "contents")

    let groupedTimeline = AssistantActivityTimeline.persisted(
        assistantSegments: [
            TranscriptAssistantSegment(
                anchorID: "assistant-earlier",
                message: ChatMessage(
                    role: "assistant",
                    content: "Duplicated outside the disclosure before this fix.",
                    timestamp: nil,
                    messageId: "assistant-earlier",
                    reasoning: "Earlier reasoning."
                )
            ),
            TranscriptAssistantSegment(anchorID: "assistant-1", message: message)
        ],
        reasoningGroups: [],
        toolCallGroups: []
    )
    XCTAssertEqual(groupedTimeline.rows.map(\.kind), timeline.rows.map(\.kind))
    XCTAssertEqual(groupedTimeline.rows.compactMap(\.text), timeline.rows.compactMap(\.text))
    XCTAssertEqual(groupedTimeline.toolCalls.map(\.id), timeline.toolCalls.map(\.id))

    let completedTurn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
    XCTAssertEqual(completedTurn.workRows.map(\.kind), ["prose", "reasoning", "tools"])
    XCTAssertEqual(completedTurn.finalAnswer, "After tool.")
    XCTAssertEqual(completedTurn.segments.count, 3)
    guard case .prose("Before tool.") = completedTurn.segments[0].content,
          case .activity(let sealedRows) = completedTurn.segments[1].content,
          case .prose("After tool.") = completedTurn.segments[2].content
    else { return XCTFail("Assistant prose should seal each activity group") }
    XCTAssertEqual(sealedRows.map(\.kind), ["reasoning", "tools"])
    XCTAssertEqual(completedTurn.workSegments.count, 2)
    guard case .activity = completedTurn.workSegments.last?.content else {
        return XCTFail("Completed work must exclude the final answer segment")
    }
    XCTAssertNotNil(CompletedAssistantTurn(rows: Array(timeline.rows.dropLast())))
}

func testActivitySceneKeepsSteeringBoundaryBetweenWorkPhases() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "Done.",
      "message_id": "assistant-final",
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "Done.",
        "turn_duration": 10,
        "activity_rows": [
          {"row_id":"prose-before","order_index":0,"role":"prose","created_at":1,"text":"First phase."},
          {"row_id":"tool:call-1","order_index":1,"role":"tool","created_at":2,"tool":{"id":"call-1","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}},
          {"row_id":"steering:local-steer-1","order_index":2,"role":"steering","created_at":4,"text":"Stop after the next sleep","steering":{"steer_id":"local-steer-1","consumed":true,"submitted_at":3,"consumed_at":4}},
          {"row_id":"tool:call-2","order_index":3,"role":"tool","created_at":7,"tool":{"id":"call-2","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
        ]
      }
    }
    """.utf8))

    let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))

    XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "tools", "steering", "tools", "prose"])
    XCTAssertEqual(timeline.rows[2].text, "Stop after the next sleep")
}

func testActiveSteeringSceneKeepsPreSteerProseInTheFirstExpandedPhase() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "First phase.",
      "message_id": "assistant-live",
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "",
        "activity_rows": [
          {"row_id":"prose-before","order_index":0,"role":"prose","created_at":1,"text":"First phase."},
          {"row_id":"steering:local-steer-1","order_index":1,"role":"steering","created_at":4,"text":"Stop now","steering":{"steer_id":"local-steer-1","consumed":true,"submitted_at":3,"consumed_at":4}}
        ]
      }
    }
    """.utf8))

    let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
    let turn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))

    XCTAssertEqual(turn.finalAnswer, "")
    XCTAssertEqual(turn.phases.first?.workRows.compactMap(\.text), ["First phase."])
    XCTAssertEqual(turn.phases.first?.steeringAfter?.text, "Stop now")
}

func testContentPartsPreserveTextToolTextOrderAndOutputText() async throws {
    let client = makeClient { request in
        apiTestJSONResponse("""
        {
          "session": {
            "session_id": "abc123",
            "messages": [{
              "role": "assistant",
              "message_id": "assistant-1",
              "content": [
                {"type":"text","text":"Before tool."},
                {"type":"tool_use","id":"call-1","name":"weather","input":{"city":"Berlin"}},
                {"type":"output_text","output_text":"It is 18C and sunny."}
              ]
            }]
          }
        }
        """, for: request)
    }

    let response = try await client.session(id: "abc123")
    let message = try XCTUnwrap(response.session?.messages?.first)
    let timeline = AssistantActivityTimeline.persisted(
        message: message,
        reasoningGroups: [],
        toolCallGroups: []
    )

    XCTAssertEqual(message.content, "Before tool.It is 18C and sunny.")
    XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "tools", "prose"])
    XCTAssertEqual(timeline.rows.compactMap(\.text), ["Before tool.", "It is 18C and sunny."])
    XCTAssertEqual(timeline.toolCalls.first?.id, "call-1")
}

func testContentPartsEndingInToolDoNotHideTrailingWorkAsFinalProse() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "message_id": "assistant-tool-tail",
      "content": [
        {"type":"text","text":"I will inspect it."},
        {"type":"tool_use","id":"call-1","name":"terminal","input":{"command":"pwd"}}
      ]
    }
    """.utf8))

    let timeline = AssistantActivityTimeline.persisted(
        message: message,
        reasoningGroups: [],
        toolCallGroups: []
    )
    let turn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))

    XCTAssertEqual(timeline.rows.map(\.kind), ["prose", "tools"])
    XCTAssertEqual(turn.finalAnswer, "")
    XCTAssertEqual(turn.workSegments, turn.segments)
}

func testCombinedFallbackAssistantRowsUseMessageScopedIDs() {
    let timeline = AssistantActivityTimeline.persisted(
        assistantSegments: [
            TranscriptAssistantSegment(
                anchorID: "assistant-1",
                message: ChatMessage(
                    role: "assistant",
                    content: "First.",
                    timestamp: nil,
                    messageId: "assistant-1"
                )
            ),
            TranscriptAssistantSegment(
                anchorID: "assistant-2",
                message: ChatMessage(
                    role: "assistant",
                    content: "Second.",
                    timestamp: nil,
                    messageId: "assistant-2"
                )
            )
        ],
        reasoningGroups: [],
        toolCallGroups: []
    )

    XCTAssertEqual(timeline.rows.map(\.id), ["assistant-1:scene:final", "assistant-2:scene:final"])
    XCTAssertEqual(Set(timeline.rows.map(\.id)).count, timeline.rows.count)
}

func testTurnFallbackKeepsEarlierSegmentsWhenFinalMessageUsesOutputText() {
    let segments = [
        TranscriptAssistantSegment(
            anchorID: "assistant-work",
            message: ChatMessage(
                role: "assistant",
                content: nil,
                timestamp: 1,
                messageId: "assistant-work",
                contentParts: [
                    .object([
                        "type": .string("reasoning"),
                        "text": .string("Inspect the workspace.")
                    ]),
                    .object([
                        "type": .string("tool_use"),
                        "id": .string("call-1"),
                        "name": .string("terminal"),
                        "input": .object(["command": .string("pwd")])
                    ])
                ]
            )
        ),
        TranscriptAssistantSegment(
            anchorID: "assistant-final",
            message: ChatMessage(
                role: "assistant",
                content: "Finished.",
                timestamp: 2,
                messageId: "assistant-final",
                contentParts: [
                    .object([
                        "type": .string("output_text"),
                        "output_text": .string("Finished.")
                    ])
                ]
            )
        )
    ]

    let timeline = AssistantActivityTimeline.persisted(
        assistantSegments: segments,
        reasoningGroups: [],
        toolCallGroups: []
    )

    XCTAssertEqual(timeline.rows.map(\.kind), ["reasoning", "tools", "prose"])
    XCTAssertEqual(timeline.rows.compactMap(\.text), ["Inspect the workspace.", "Finished."])
    XCTAssertEqual(timeline.toolCalls.map(\.id), ["call-1"])
}

func testActivitySceneUsesAuthoritativeFinalAnswerInsteadOfFlattenedContent() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "message_id": "assistant-final",
      "content": [
        {"type":"text","text":"Progress update."},
        {"type":"tool_use","id":"call-1","name":"terminal","input":{"command":"pwd"}},
        {"type":"output_text","output_text":"Finished."}
      ],
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "Finished.",
        "activity_rows": [
          {"row_id":"progress","order_index":0,"role":"prose","text":"Progress update."},
          {"row_id":"tool:call-1","order_index":1,"role":"tool","tool":{"id":"call-1","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
        ]
      }
    }
    """.utf8))

    let timeline = AssistantActivityTimeline.persisted(
        message: message,
        reasoningGroups: [],
        toolCallGroups: []
    )

    XCTAssertEqual(message.content, "Progress update.Finished.")
    XCTAssertEqual(timeline.rows.compactMap(\.text), ["Progress update.", "Finished."])
    XCTAssertEqual(CompletedAssistantTurn(rows: timeline.rows)?.finalAnswer, "Finished.")
}

func testExplicitFinalProseBeforeTrailingToolKeepsTheToolInWork() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "Done.",
      "message_id": "assistant-final-before-tool",
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "Done.",
        "activity_rows": [
          {"row_id":"tool:call-1","order_index":0,"role":"tool","tool":{"id":"call-1","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
        ]
      }
    }
    """.utf8))

    let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
    let turn = try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))

    XCTAssertEqual(turn.finalAnswer, "Done.")
    XCTAssertEqual(turn.workRows.map(\.kind), ["tools"])
    XCTAssertEqual(turn.workSegments.count, 1)
    guard case .activity(let rows) = turn.workSegments[0].content else {
        return XCTFail("Expected the trailing tool to remain in Worked")
    }
    XCTAssertEqual(rows.map(\.kind), ["tools"])
}

func testActivitySceneDecodingKeepsValidRowsAroundMalformedFields() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "Finished.",
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "Finished.",
        "turn_duration": "12.5",
        "activity_rows": [
          {"row_id":"thinking","order_index":"1","role":"reasoning","text":"Inspect first.","titles":[]},
          "malformed-row",
          {"row_id":"tool:call-1","order_index":2,"role":"tool","tool":{"id":"call-1","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
        ]
      }
    }
    """.utf8))

    XCTAssertEqual(message.activityScene?.activityRows?.count, 2)
    XCTAssertEqual(message.activityScene?.activityRows?.first?.orderIndex, 1)
    XCTAssertEqual(message.turnDuration, 12.5)
    XCTAssertEqual(
        AssistantActivityTimeline.persisted(
            message: message,
            reasoningGroups: [],
            toolCallGroups: []
        ).rows.map(\.kind),
        ["reasoning", "tools", "prose"]
    )
}

func testActivitySceneIgnoresEmptyTimestampedRowsWithoutTouchingAdjacentRows() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "Done.",
      "_anchor_activity_scene": {
        "version": "activity_scene_v1",
        "final_answer": "Done.",
        "activity_rows": [
          {"row_id":"empty-prose","order_index":0,"role":"prose","created_at":1,"text":"   "},
          {"row_id":"empty-thinking","order_index":1,"role":"reasoning","created_at":2,"text":"","titles":[]},
          {"row_id":"tool:call-1","order_index":2,"role":"tool","created_at":3,"tool":{"id":"call-1","name":"terminal","args":null,"preview":null,"result":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}
        ]
      }
    }
    """.utf8))

    let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))

    XCTAssertEqual(timeline.rows.map(\.kind), ["tools", "prose"])
    XCTAssertEqual(timeline.rows.first?.createdAt, 3)
    XCTAssertEqual(timeline.rows.last?.text, "Done.")
}

func testContentPartToolsUseResolvedResultsWithoutCompletingUnresolvedCalls() {
    let message = ChatMessage(
        role: "assistant",
        content: nil,
        timestamp: 1,
        messageId: "assistant-tools",
        contentParts: [
            .object([
                "type": .string("tool_use"),
                "id": .string("call-failed"),
                "name": .string("terminal"),
                "input": .object(["command": .string("false")])
            ]),
            .object([
                "type": .string("tool_use"),
                "id": .string("call-pending"),
                "name": .string("search_files"),
                "input": .object(["pattern": .string("*.md")])
            ])
        ]
    )
    let resolvedGroups = [
        ToolCallGroup(
            id: "resolved",
            anchorMessageID: "assistant-tools",
            toolCalls: [
                ToolCall(
                    id: "call-failed",
                    name: "terminal",
                    preview: "Command failed",
                    args: ["command": .string("false")],
                    isError: true,
                    isCompleted: true
                )
            ]
        )
    ]

    let timeline = AssistantActivityTimeline.persisted(
        message: message,
        reasoningGroups: [],
        toolCallGroups: resolvedGroups
    )

    XCTAssertEqual(timeline.toolCalls.map(\.id), ["call-failed", "call-pending"])
    XCTAssertEqual(timeline.toolCalls.first?.preview, "Command failed")
    XCTAssertEqual(timeline.toolCalls.first?.isError, true)
    XCTAssertEqual(timeline.toolCalls.first?.isCompleted, true)
    XCTAssertEqual(timeline.toolCalls.last?.isCompleted, false)
}

func testEmptyTerminalSceneStillCarriesTheServerOutcome() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "content": "",
      "message_id": "assistant-empty-outcome",
      "_anchor_activity_scene": {"version": "activity_scene_v1", "final_answer": "", "terminal_state": "no_response", "expanded_by_default": false, "activity_rows": []}
    }
    """.utf8))

    // No rows and no answer: the block renders the plain message, and the outcome label alongside it.
    XCTAssertNil(AssistantActivityTimeline.authoritativeScene(message: message))
    XCTAssertEqual(AssistantTurnOutcome.label(for: message.activityScene?.terminalState), "No answer produced.")
}

func testOlderServerSceneWithoutFinalAnswerKeepsTheMessageTextAsTheAnswer() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    func turn(_ rows: String) throws -> CompletedAssistantTurn {
        let message = try decoder.decode(ChatMessage.self, from: Data("""
        {"role":"assistant","content":"Final answer.","message_id":"old-server","_anchor_activity_scene":{"version":"activity_scene_v1","activity_rows":[\(rows)]}}
        """.utf8))
        let timeline = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message))
        return try XCTUnwrap(CompletedAssistantTurn(rows: timeline.rows))
    }
    let tool = #"{"row_id":"tool:t","order_index":1,"role":"tool","tool":{"id":"t","name":"read_file","done":true,"is_error":false}}"#

    // Work rows only: the message text becomes the visible answer.
    let workOnly = try turn(#"{"row_id":"r","order_index":0,"role":"reasoning","text":"Plan"},"# + tool)
    XCTAssertEqual(workOnly.finalAnswer, "Final answer.")
    XCTAssertEqual(workOnly.workRows.map(\.kind), ["reasoning", "tools"])

    // The older server kept the answer's own row in the scene: it is matched, not repeated.
    let withAnswerRow = try turn(tool + #",{"row_id":"f","order_index":2,"role":"prose","text":"Final answer."}"#)
    XCTAssertEqual(withAnswerRow.finalAnswer, "Final answer.")
    XCTAssertEqual(withAnswerRow.workRows.map(\.kind), ["tools"])
}
}
