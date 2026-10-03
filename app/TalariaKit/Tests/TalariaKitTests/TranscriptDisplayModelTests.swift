import XCTest
import AVFoundation
import ImageIO
import SwiftData
import SwiftUI
import UniformTypeIdentifiers
@testable import TalariaKit

final class TranscriptMessageTests: XCTestCase {
    func testOnlyTheCurrentAssistantTurnOwnsASeparateActiveStream() throws {
        let messages = [
            ChatMessage(role: "user", content: "First", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Old answer", timestamp: 2, messageId: "a1"),
            ChatMessage(role: "user", content: "Second", timestamp: 3, messageId: "u2"),
            ChatMessage(role: "assistant", content: "Streaming", timestamp: 4, messageId: "a2"),
        ]
        let transcript = ChatViewModel.transcriptMessages(from: messages)

        let oldTurn = try XCTUnwrap(transcript.first { $0.message.messageId == "a1" })
        let currentTurn = try XCTUnwrap(transcript.first { $0.message.messageId == "a2" })

        XCTAssertFalse(oldTurn.ownsActiveStream(hasLiveActivity: false, streamingAssistantMessageID: "a2"))
        XCTAssertTrue(currentTurn.ownsActiveStream(hasLiveActivity: false, streamingAssistantMessageID: "a2"))
        XCTAssertTrue(oldTurn.ownsActiveStream(hasLiveActivity: true, streamingAssistantMessageID: nil))
    }

    func testTranscriptMessagesGroupAssistantTurnsByServerTurnID() {
        // A hidden wakeup prompt separates two server turns with no visible user row between them.
        let messages = [
            ChatMessage(role: "user", content: "Check", timestamp: 1, messageId: "u1", turnId: "run-1"),
            ChatMessage(role: "assistant", content: "Part one", timestamp: 2, messageId: "a1", turnId: "run-1"),
            ChatMessage(role: "assistant", content: "Part two", timestamp: 3, messageId: "a2", turnId: "run-1"),
            ChatMessage(role: "assistant", content: "Woke up", timestamp: 4, messageId: "a3", turnId: "run-2")
        ]

        let transcript = ChatViewModel.transcriptMessages(from: messages)

        XCTAssertEqual(transcript.map(\.assistantSegments.count), [0, 2, 1])
        XCTAssertEqual(transcript[1].assistantSegments.map(\.message.messageId), ["a1", "a2"])
        XCTAssertEqual(
            TranscriptTurnClassifier.assistantTurnKeysByAnchorID(messages),
            ["a1": "turn:run-1", "a2": "turn:run-1", "a3": "turn:run-2"]
        )
    }

    func testTranscriptMessagesHideToolRowsAndPreserveLoadedIndices() {
        let messages = [
            ChatMessage(role: "user", content: "Plan it", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Working on it", timestamp: 2, messageId: "a1"),
            ChatMessage(
                role: "tool",
                content: #"{"success":true,"diff":"..."}"#,
                timestamp: 3,
                messageId: "t1",
                toolCallId: "tool-1"
            ),
            ChatMessage(role: "assistant", content: "Done. Here's what changed.", timestamp: 4, messageId: "a2")
        ]

        let transcriptMessages = ChatViewModel.transcriptMessages(from: messages)

        XCTAssertEqual(transcriptMessages.map(\.loadedIndex), [0, 3])
        XCTAssertEqual(transcriptMessages.map(\.message.id), ["u1", "a2"])
        XCTAssertEqual(transcriptMessages.last?.assistantSegments.map(\.message.id), ["a1", "a2"])
    }

    func testTranscriptMessagesCanHideActiveStreamingAssistantTurn() {
        let messages = [
            ChatMessage(role: "user", content: "Use tools", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "", timestamp: 2, messageId: "stream-1"),
            ChatMessage(
                role: "tool",
                content: #"{"success":true}"#,
                timestamp: 3,
                messageId: "t1",
                toolCallId: "tool-1"
            ),
            ChatMessage(role: "assistant", content: "Older answer", timestamp: 4, messageId: "a2")
        ]

        let transcriptMessages = ChatViewModel.transcriptMessages(
            from: messages,
            hidingStreamingAssistantID: "stream-1"
        )

        XCTAssertEqual(transcriptMessages.map(\.loadedIndex), [0, 3])
        XCTAssertEqual(transcriptMessages.map(\.message.id), ["u1", "a2"])
    }

    func testTranscriptMessagesKeepStreamingAssistantAnchorStableAcrossContentUpdates() {
        let initialMessages = [
            ChatMessage(role: "user", content: "Write a long answer", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "", timestamp: 2, messageId: "stream-1")
        ]
        let updatedMessages = [
            ChatMessage(role: "user", content: "Write a long answer", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "First streamed token.", timestamp: 2, messageId: "stream-1")
        ]

        let initialTranscriptMessages = ChatViewModel.transcriptMessages(from: initialMessages)
        let updatedTranscriptMessages = ChatViewModel.transcriptMessages(from: updatedMessages)

        XCTAssertEqual(initialTranscriptMessages.map(\.anchorID), ["u1", "stream-1"])
        XCTAssertEqual(updatedTranscriptMessages.map(\.anchorID), ["u1", "stream-1"])
        XCTAssertEqual(initialTranscriptMessages.map(\.id), updatedTranscriptMessages.map(\.id))
        XCTAssertEqual(initialTranscriptMessages.map(\.loadedIndex), updatedTranscriptMessages.map(\.loadedIndex))
    }

    func testTranscriptMessagesKeepRenderIDStableWhenServerReplacesStreamingAssistantID() {
        let streamingMessages = [
            ChatMessage(role: "user", content: "Finish the summary", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Working summary", timestamp: 2, messageId: "stream-1")
        ]
        let completedMessages = [
            ChatMessage(role: "user", content: "Finish the summary", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Final summary", timestamp: 2, messageId: "assistant-1")
        ]

        let streamingTranscriptMessages = ChatViewModel.transcriptMessages(from: streamingMessages)
        let completedTranscriptMessages = ChatViewModel.transcriptMessages(from: completedMessages)

        XCTAssertEqual(streamingTranscriptMessages.map(\.id), completedTranscriptMessages.map(\.id))
        XCTAssertEqual(streamingTranscriptMessages.map(\.anchorID), ["u1", "stream-1"])
        XCTAssertEqual(completedTranscriptMessages.map(\.anchorID), ["u1", "assistant-1"])
    }

    func testTranscriptMessagesUseRawAnchorForNilMessageIDsIndependentOfContent() {
        let initialMessages = [
            ChatMessage(role: "user", content: "Hello", timestamp: 1, messageId: nil),
            ChatMessage(role: "assistant", content: "", timestamp: 2, messageId: nil)
        ]
        let updatedMessages = [
            ChatMessage(role: "user", content: "Hello", timestamp: 1, messageId: nil),
            ChatMessage(role: "assistant", content: "A streamed response.", timestamp: 2, messageId: nil)
        ]

        let initialTranscriptMessages = ChatViewModel.transcriptMessages(
            from: initialMessages,
            messageOffset: 10
        )
        let updatedTranscriptMessages = ChatViewModel.transcriptMessages(
            from: updatedMessages,
            messageOffset: 10
        )

        XCTAssertEqual(initialTranscriptMessages.map(\.anchorID), ["raw:10", "raw:11"])
        XCTAssertEqual(updatedTranscriptMessages.map(\.anchorID), ["raw:10", "raw:11"])
        XCTAssertEqual(initialTranscriptMessages.map(\.id), updatedTranscriptMessages.map(\.id))
    }

    func testTranscriptMessagesKeepRenderIDsStableWhenOlderMessagesPrepend() {
        let initialWindow = [
            ChatMessage(role: "assistant", content: "Earlier answer", timestamp: 1, messageId: "a1"),
            ChatMessage(role: "user", content: "Follow up", timestamp: 2, messageId: "u2"),
            ChatMessage(role: "assistant", content: "Latest answer", timestamp: 3, messageId: "a2")
        ]
        let expandedWindow = [
            ChatMessage(role: "user", content: "First question", timestamp: 0, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Earlier answer", timestamp: 1, messageId: "a1"),
            ChatMessage(role: "user", content: "Follow up", timestamp: 2, messageId: "u2"),
            ChatMessage(role: "assistant", content: "Latest answer", timestamp: 3, messageId: "a2")
        ]

        let initialTranscriptMessages = ChatViewModel.transcriptMessages(
            from: initialWindow,
            messageOffset: 1
        )
        let expandedTranscriptMessages = ChatViewModel.transcriptMessages(
            from: expandedWindow,
            messageOffset: 0
        )

        XCTAssertEqual(initialTranscriptMessages.map(\.id), ["transcript:1", "transcript:2", "transcript:3"])
        XCTAssertEqual(expandedTranscriptMessages.map(\.id), ["transcript:0", "transcript:1", "transcript:2", "transcript:3"])

        let initialRenderIDsByMessageID = Dictionary(
            uniqueKeysWithValues: initialTranscriptMessages.compactMap { transcriptMessage in
                transcriptMessage.message.messageId.map { ($0, transcriptMessage.id) }
            }
        )
        for expandedTranscriptMessage in expandedTranscriptMessages {
            guard let messageID = expandedTranscriptMessage.message.messageId,
                  let initialRenderID = initialRenderIDsByMessageID[messageID]
            else { continue }

            XCTAssertEqual(
                expandedTranscriptMessage.id,
                initialRenderID,
                "renderID should stay stable for message \(messageID)"
            )
        }
    }

    func testTranscriptMessagesPreserveMessagesWithNilMessageIDsWhenNoStreamingTurnHidden() {
        let messages = [
            ChatMessage(role: "user", content: "Hello", timestamp: 1, messageId: nil),
            ChatMessage(role: "assistant", content: "Hi", timestamp: 2, messageId: nil),
            ChatMessage(
                role: "tool",
                content: #"{"success":true}"#,
                timestamp: 3,
                messageId: nil,
                toolCallId: "tool-1"
            )
        ]

        let transcriptMessages = ChatViewModel.transcriptMessages(from: messages)

        XCTAssertEqual(transcriptMessages.map(\.loadedIndex), [0, 1])
        XCTAssertEqual(transcriptMessages.map(\.message.role), ["user", "assistant"])
    }

    /// Only the server's scene folds work under "Worked"; the pre-steer part of a live turn has none, so it stays open.
    func testPreSteerActivityHasNoServerSceneUntilTheTurnSettles() {
        let messages = [
            ChatMessage(role: "user", content: "Initial request", timestamp: 1, messageId: "u1"),
            ChatMessage(role: "assistant", content: "Working", timestamp: 2, messageId: "a1"),
            ChatMessage(
                role: "user",
                content: "Stop after the next step",
                timestamp: 3,
                messageId: "local-steer-1",
                name: SteeringHintState.waiting.rawValue
            )
        ]

        let preSteerActivity = ChatViewModel.transcriptMessages(from: messages)[1]

        XCTAssertEqual(preSteerActivity.message.messageId, "a1")
        XCTAssertNil(AssistantActivityTimeline.authoritativeScene(message: preSteerActivity.message))
    }

    func testAuthoritativeConsumedSteerKeepsLaterUnresolvedHintDuringReconnect() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let serverAssistant = try decoder.decode(ChatMessage.self, from: Data("""
        {
          "role":"assistant",
          "content":"Working",
          "message_id":"assistant-server",
          "_anchor_activity_scene":{
            "version":"activity_scene_v1",
            "activity_rows":[
              {"row_id":"steering:local-steer-consumed","order_index":0,"role":"steering","text":"First hint","steering":{"steer_id":"local-steer-consumed","consumed":true,"submitted_at":null,"consumed_at":null}}
            ]
          }
        }
        """.utf8))
        let loaded = [
            ChatMessage(role: "user", content: "Initial request", timestamp: 1, messageId: "user-1"),
            serverAssistant
        ]
        let cached = [
            ChatMessage(role: "user", content: "Initial request", timestamp: 1, messageId: "user-1"),
            ChatMessage(role: "assistant", content: "Working", timestamp: 2, messageId: "assistant-local"),
            ChatMessage(
                role: "user",
                content: "First hint",
                timestamp: 3,
                messageId: "local-steer-consumed",
                name: SteeringHintState.consumed.rawValue
            ),
            ChatMessage(
                role: "user",
                content: "Second hint",
                timestamp: 4,
                messageId: "local-steer-waiting",
                name: SteeringHintState.waiting.rawValue
            )
        ]

        let merged = ChatViewModel.mergingLoadedMessages(
            loaded,
            withCachedLocalOptimisticMessages: cached
        )

        XCTAssertEqual(merged.filter(\.isLocalSteeringHint).map(\.messageId), ["local-steer-waiting"])
        XCTAssertEqual(merged.last?.content, "Second hint")
    }

}

final class ChatTranscriptDisplaySettingsTests: XCTestCase {
    func testTypingIndicatorStaysHiddenBehindVisibleThinkingAndToolCards() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldShowAssistantTypingIndicator(
            hasActiveStream: true,
            isCancellingStream: false,
            hasStreamingAssistantMessage: false,
            liveReasoningText: "Inspecting files",
            hasLiveToolCalls: false,
            showsThinkingAndToolCards: true
        ))

        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldShowAssistantTypingIndicator(
            hasActiveStream: true,
            isCancellingStream: false,
            hasStreamingAssistantMessage: false,
            liveReasoningText: "",
            hasLiveToolCalls: true,
            showsThinkingAndToolCards: true
        ))
    }

    func testTypingIndicatorShowsWhenHiddenCardsAreOnlyLiveActivity() {
        XCTAssertTrue(ChatTranscriptDisplaySettings.shouldShowAssistantTypingIndicator(
            hasActiveStream: true,
            isCancellingStream: false,
            hasStreamingAssistantMessage: false,
            liveReasoningText: "Inspecting files",
            hasLiveToolCalls: true,
            showsThinkingAndToolCards: false
        ))

        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldShowAssistantTypingIndicator(
            hasActiveStream: true,
            isCancellingStream: false,
            hasStreamingAssistantMessage: true,
            liveReasoningText: "Inspecting files",
            hasLiveToolCalls: true,
            showsThinkingAndToolCards: false
        ))
    }

    func testTypingIndicatorHidesBehindPendingClarificationPrompt() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldShowAssistantTypingIndicator(
            hasActiveStream: true,
            isCancellingStream: false,
            hasStreamingAssistantMessage: false,
            hasPendingClarificationPrompt: true,
            liveReasoningText: "",
            hasLiveToolCalls: false,
            showsThinkingAndToolCards: false
        ))
    }

    func testStreamingBubbleRenderingDoesNotMatchNilMessageIDs() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldUseStreamingBubbleRendering(
            hasActiveStream: true,
            messageRole: "user",
            messageID: nil,
            streamingAssistantMessageID: nil
        ))

        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldUseStreamingBubbleRendering(
            hasActiveStream: true,
            messageRole: "assistant",
            messageID: nil,
            streamingAssistantMessageID: nil
        ))
    }

    func testStreamingBubbleRenderingMatchesActiveStreamingAssistant() {
        XCTAssertTrue(ChatTranscriptDisplaySettings.shouldUseStreamingBubbleRendering(
            hasActiveStream: true,
            messageRole: "assistant",
            messageID: "stream-1",
            streamingAssistantMessageID: "stream-1"
        ))

        XCTAssertFalse(ChatTranscriptDisplaySettings.shouldUseStreamingBubbleRendering(
            hasActiveStream: true,
            messageRole: "assistant",
            messageID: "assistant-1",
            streamingAssistantMessageID: "stream-1"
        ))
    }

    func testCardExpansionFollowsStartExpandedPreferenceUntilToggled() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.isCardExpanded(userToggled: nil, startsExpanded: false))
        XCTAssertTrue(ChatTranscriptDisplaySettings.isCardExpanded(userToggled: nil, startsExpanded: true))
    }

    func testCardExpansionTapOverrideWinsOverPreference() {
        XCTAssertTrue(ChatTranscriptDisplaySettings.isCardExpanded(userToggled: true, startsExpanded: false))
        XCTAssertFalse(ChatTranscriptDisplaySettings.isCardExpanded(userToggled: false, startsExpanded: true))
    }

    func testCardStartExpandedKeysAreStableAndDistinct() {
        XCTAssertEqual(
            ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey,
            "chatTranscript.thinkingCardsStartExpanded"
        )
        XCTAssertEqual(
            ChatTranscriptDisplaySettings.toolCardsStartExpandedKey,
            "chatTranscript.toolCardsStartExpanded"
        )
        XCTAssertNotEqual(
            ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey,
            ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey
        )
    }

    func testHidesAttachmentPathsKeyIsStableAndDistinct() {
        XCTAssertEqual(
            ChatTranscriptDisplaySettings.hidesAttachmentPathsKey,
            "chatTranscript.hidesAttachmentPaths"
        )
        XCTAssertNotEqual(
            ChatTranscriptDisplaySettings.hidesAttachmentPathsKey,
            ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey
        )
    }

    func testAssistantTurnTimestampsKeyIsStableAndDistinct() {
        XCTAssertEqual(
            ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey,
            "chatTranscript.showsAssistantTurnTimestamps"
        )
        XCTAssertNotEqual(
            ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey,
            ChatTranscriptDisplaySettings.hidesAttachmentPathsKey
        )
    }

    func testResponseSpeedKeyIsStableAndDistinct() {
        XCTAssertEqual(
            ChatTranscriptDisplaySettings.showsResponseSpeedKey,
            "chatTranscript.showsResponseSpeed"
        )
        XCTAssertNotEqual(
            ChatTranscriptDisplaySettings.showsResponseSpeedKey,
            ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey
        )
    }

    func testTimestampAndResponseSpeedTogglesAreIndependent() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: false,
            showsResponseSpeed: false,
            hasResponseSpeed: true
        ))
        XCTAssertTrue(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: true,
            showsResponseSpeed: false,
            hasResponseSpeed: true
        ))
        XCTAssertTrue(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: false,
            showsResponseSpeed: true,
            hasResponseSpeed: true
        ))
        XCTAssertTrue(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: true,
            showsResponseSpeed: true,
            hasResponseSpeed: true
        ))
    }

    func testInvalidResponseSpeedAloneDoesNotCreateHeaderRow() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: false,
            showsResponseSpeed: true,
            hasResponseSpeed: false
        ))
    }

    func testAssistantTurnHeaderShowsForAssistantTextTurnWhenEnabled() {
        XCTAssertTrue(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: true
        ))
    }

    func testAssistantTurnHeaderHiddenWhenToggleOff() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: true,
            isEnabled: false
        ))
    }

    func testAssistantTurnHeaderHiddenForEmptyOrToolOnlyAssistantRow() {
        XCTAssertFalse(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: "assistant",
            hasTextContent: false,
            isEnabled: true
        ))
    }

    func testAssistantTurnHeaderHiddenForNonAssistantRoles() {
        for role in ["user", "system", "tool", "local_assistant", "local_notice"] {
            XCTAssertFalse(
                ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
                    role: role,
                    hasTextContent: true,
                    isEnabled: true
                ),
                "Header must not render for role \(role)"
            )
        }

        XCTAssertFalse(ChatTranscriptDisplaySettings.showsAssistantTurnHeader(
            role: nil,
            hasTextContent: true,
            isEnabled: true
        ))
    }

    func testContentWithoutAttachedFilesMarkerStripsTrailingMarker() {
        // Mirrors the exact format PendingAttachment.chatMessageText appends.
        let sent = "Analyze these files\n\n[Attached files: /tmp/workspace/sample.html, /tmp/workspace/image.jpg]"
        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachedFilesMarker(in: sent),
            "Analyze these files"
        )
    }

    func testContentWithoutAttachedFilesMarkerReturnsEmptyForAttachmentOnlyMessage() {
        // No typed draft: the whole content is just the appended marker.
        let sent = "\n\n[Attached files: /tmp/workspace/image.jpg]"
        XCTAssertEqual(MessageAttachment.contentWithoutAttachedFilesMarker(in: sent), "")
    }

    func testContentWithoutAttachedFilesMarkerPreservesInteriorNewlines() {
        let sent = "line one\nline two\n\n[Attached files: /tmp/a.png]"
        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachedFilesMarker(in: sent),
            "line one\nline two"
        )
    }

    func testContentWithoutAttachedFilesMarkerLeavesPlainMessageUnchanged() {
        let plain = "Just a normal message with no attachments"
        XCTAssertEqual(MessageAttachment.contentWithoutAttachedFilesMarker(in: plain), plain)
    }

    func testContentWithoutAttachedFilesMarkerIgnoresMarkerWithTrailingText() {
        // The parser only treats the marker as a suffix; trailing prose means it
        // is not a real attachment marker, so the content is left untouched.
        let content = "hello\n\n[Attached files: /tmp/a.png] and then more text"
        XCTAssertEqual(MessageAttachment.contentWithoutAttachedFilesMarker(in: content), content)
    }

    /// TAL-158: the server replays an attachment-only send as the synthesized
    /// message, so the display transform has to hide it there too — its own
    /// attachments are the evidence that it really is one.
    func testContentWithoutAttachmentReferencesStripsReloadedSynthesizedMessage() {
        let sent = PendingAttachment.chatMessageText(draft: "", attachments: [
            PendingAttachment(name: "notes.txt", path: "/tmp/workspace/notes.txt", mime: "text/plain", size: 4, isImage: false)
        ])
        // The server commonly replays a bare filename as the path.
        let reloaded = [MessageAttachment(name: "notes.txt", path: "notes.txt", mime: "text/plain", size: 4, isImage: false)]

        XCTAssertEqual(sent, "I've uploaded 1 file(s): /tmp/workspace/notes.txt")
        XCTAssertEqual(MessageAttachment.contentWithoutAttachmentReferences(in: sent, attachments: reloaded), "")
    }

    /// Duplicate filenames get distinct server paths, and a filename may contain
    /// a comma. Containment rather than a parse of the reference list keeps both
    /// matching.
    func testContentWithoutAttachmentReferencesStripsDuplicateAndCommaFilenames() {
        let duplicates = "I've uploaded 2 file(s): /tmp/workspace/shot.jpg, /tmp/workspace/shot-2.jpg"
        let duplicateAttachments = [
            MessageAttachment(name: "shot.jpg", path: "/tmp/workspace/shot.jpg", mime: "image/jpeg", size: 4, isImage: true),
            MessageAttachment(name: "shot.jpg", path: "/tmp/workspace/shot-2.jpg", mime: "image/jpeg", size: 4, isImage: true)
        ]
        let comma = "I've uploaded 1 file(s): /tmp/workspace/a, b.txt"
        let commaAttachment = [MessageAttachment(name: "a, b.txt", path: "/tmp/workspace/a, b.txt", mime: "text/plain", size: 4, isImage: false)]

        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachmentReferences(in: duplicates, attachments: duplicateAttachments),
            ""
        )
        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachmentReferences(in: comma, attachments: commaAttachment),
            ""
        )
    }

    /// A voice note sends its bare transcript alongside the audio clip, so the
    /// shape alone must not blank it: the transcript never names the clip.
    func testContentWithoutAttachmentReferencesKeepsVoiceNoteTranscript() {
        let transcript = "I've uploaded 2 file(s): the report, the notes"
        let audioClip = [MessageAttachment(name: "voice-note.m4a", path: "/tmp/workspace/voice-note.m4a", mime: "audio/mp4", size: 4, isImage: false)]

        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachmentReferences(in: transcript, attachments: audioClip),
            transcript
        )
    }

    /// Without attachments there is no evidence at all, so pasted prose in the
    /// same shape survives — and is never turned into inferred chips.
    func testContentWithoutAttachmentReferencesKeepsUnattachedLookalikeProse() {
        let content = "I've uploaded 3 file(s): the report, the notes and the slides"

        XCTAssertEqual(MessageAttachment.contentWithoutAttachmentReferences(in: content, attachments: nil), content)
        XCTAssertEqual(MessageAttachment.contentWithoutAttachmentReferences(in: content, attachments: []), content)
        XCTAssertNil(MessageAttachment.inferredFromAttachedFilesMarker(in: content))
    }

    /// The optimistic row carries the same text the server will store, marker
    /// included, so a user who types the synthesized wording *and* attaches the
    /// file they named still sees their own words — before and after a reload.
    func testContentWithoutAttachmentReferencesKeepsTypedLookalikeNamingItsAttachment() {
        let typed = "I've uploaded 1 file(s): report.pdf"
        let attachments = [MessageAttachment(name: "report.pdf", path: "/tmp/workspace/report.pdf", mime: "application/pdf", size: 4, isImage: false)]
        let sent = PendingAttachment.chatMessageText(draft: typed, attachments: [
            PendingAttachment(name: "report.pdf", path: "/tmp/workspace/report.pdf", mime: "application/pdf", size: 4, isImage: false)
        ])

        XCTAssertEqual(sent, "\(typed)\n\n[Attached files: /tmp/workspace/report.pdf]")
        XCTAssertEqual(MessageAttachment.contentWithoutAttachmentReferences(in: sent, attachments: attachments), typed)
    }

    /// A typed message that reads like the synthesized one still ends in a real
    /// marker, so only the marker is stripped.
    func testContentWithoutAttachmentReferencesKeepsLookalikeProseAheadOfMarker() {
        let content = "I've uploaded 3 file(s): see below\n\n[Attached files: /tmp/a.png]"
        let attachments = [MessageAttachment(name: "a.png", path: "/tmp/a.png", mime: "image/png", size: 4, isImage: true)]

        XCTAssertEqual(
            MessageAttachment.contentWithoutAttachmentReferences(in: content, attachments: attachments),
            "I've uploaded 3 file(s): see below"
        )
    }
}

final class ChatActiveRunStatusPolicyTests: XCTestCase {
    func testStatusHidesWhenTranscriptBottomIsVisible() {
        XCTAssertNil(ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: true,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isScrolledNearBottom: true
        ))
    }

    func testStatusShowsActiveRunWhenScrolledAwayFromBottom() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: true,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isScrolledNearBottom: false
        )

        XCTAssertEqual(presentation?.kind, .active)
        XCTAssertEqual(presentation?.label(agentName: "Maude"), "Maude is working")
    }

    func testStatusShowsStartingBeforeStreamIDExists() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: true,
            hasActiveStream: false,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isScrolledNearBottom: false
        )

        XCTAssertEqual(presentation?.kind, .starting)
    }

    func testStatusPrioritizesRecoveryStateOverGenericActiveRun() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: true,
            activeStreamRecoveryState: .reconnecting,
            isCancellingStream: false,
            isScrolledNearBottom: false
        )

        XCTAssertEqual(presentation?.kind, .reconnecting)
        XCTAssertEqual(presentation?.accessibilityLabel(agentName: "Hermes"), "Hermes is reconnecting the response stream")
    }

    func testStatusPrioritizesCancellationOverOtherStates() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: true,
            hasActiveStream: true,
            activeStreamRecoveryState: .checking,
            isCancellingStream: true,
            isScrolledNearBottom: false
        )

        XCTAssertEqual(presentation?.kind, .stopping)
    }

    func testStatusHidesWhenIdleAndNoRunIsStarting() {
        XCTAssertNil(ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: false,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isScrolledNearBottom: false
        ))
    }

    // TAL-436: syncing shows at any scroll position.
    func testSyncingShowsEvenWhenTranscriptBottomIsVisible() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: false,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isSyncingTranscript: true,
            isScrolledNearBottom: true
        )

        XCTAssertEqual(presentation?.kind, .syncing)
        XCTAssertEqual(presentation?.label(agentName: "Hermes"), "Syncing messages")
        XCTAssertEqual(presentation?.accessibilityLabel(agentName: "Hermes"), "Syncing messages with the server")
        XCTAssertEqual(presentation?.isSyncing, true)
    }

    func testSyncingHidesRunProgressAndRecovery() {
        let presentation = ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: true,
            activeStreamRecoveryState: .reconnecting,
            isCancellingStream: false,
            isSyncingTranscript: true,
            isScrolledNearBottom: false
        )

        XCTAssertEqual(presentation?.kind, .syncing)
    }

    func testRecoveryStatesMapToTheirChipsAndAHealthyStreamToNone() {
        XCTAssertNil(ChatActiveRunStatusPresentation(recoveryState: .idle))
        XCTAssertEqual(ChatActiveRunStatusPresentation(recoveryState: .checking)?.kind, .checking)
        XCTAssertEqual(ChatActiveRunStatusPresentation(recoveryState: .reconnecting)?.label(agentName: "Hermes"), "Reconnecting stream")
        let waiting = ChatActiveRunStatusPresentation(recoveryState: .waitingForNetwork)
        XCTAssertEqual(waiting?.label(agentName: "Hermes"), "Waiting for network")
        XCTAssertEqual(waiting?.accessibilityLabel(agentName: "Hermes"), "Hermes is waiting for a network connection")
        XCTAssertEqual(waiting?.isWaitingForNetwork, true)
        XCTAssertEqual(ChatActiveRunStatusPresentation(recoveryState: .reconnecting)?.isWaitingForNetwork, false)
    }

    func testSyncingPillHidesTheTranscriptRecoveryChip() {
        XCTAssertEqual(ChatActiveRunStatusPolicy.transcriptRecoveryState(
            .reconnecting,
            statusPresentation: ChatActiveRunStatusPresentation(kind: .syncing)
        ), .idle)
        XCTAssertEqual(ChatActiveRunStatusPolicy.transcriptRecoveryState(
            .checking,
            statusPresentation: ChatActiveRunStatusPresentation(kind: .checking)
        ), .checking)
        XCTAssertEqual(ChatActiveRunStatusPolicy.transcriptRecoveryState(.checking, statusPresentation: nil), .checking)
    }

    func testStoppingAndStartingOutrankSyncing() {
        XCTAssertEqual(ChatActiveRunStatusPolicy.presentation(
            isStartingChat: false,
            hasActiveStream: true,
            activeStreamRecoveryState: .idle,
            isCancellingStream: true,
            isSyncingTranscript: true,
            isScrolledNearBottom: false
        )?.kind, .stopping)
        XCTAssertEqual(ChatActiveRunStatusPolicy.presentation(
            isStartingChat: true,
            hasActiveStream: false,
            activeStreamRecoveryState: .idle,
            isCancellingStream: false,
            isSyncingTranscript: true,
            isScrolledNearBottom: false
        )?.kind, .starting)
    }

    func testSyncingPillFloatsOverTheTranscriptInsteadOfPushingItUp() {
        XCTAssertFalse(ChatActiveRunStatusPresentation(kind: .syncing).reservesTranscriptSpace)
        for kind: ChatActiveRunStatusKind in [.starting, .active, .checking, .reconnecting, .waitingForNetwork, .stopping] {
            XCTAssertTrue(ChatActiveRunStatusPresentation(kind: kind).reservesTranscriptSpace, "\(kind)")
        }
    }
}

final class AssistantTurnTimestampFormatterTests: XCTestCase {
    // 2021-01-01 14:14:00 UTC
    private let fixedTimestamp: Double = 1_609_510_440
    private let utc = TimeZone(identifier: "UTC")!

    func testFormatsTwelveHourLocaleAsShortTime() {
        let result = AssistantTurnTimestampFormatter.shortTime(
            forUnixTimestamp: fixedTimestamp,
            locale: Locale(identifier: "en_US"),
            timeZone: utc
        )

        XCTAssertNotNil(result)
        XCTAssertTrue(result?.contains("2:14") == true, "Expected 12h time, got \(result ?? "nil")")
        XCTAssertTrue(result?.contains("PM") == true, "Expected PM marker, got \(result ?? "nil")")
    }

    func testFormatsTwentyFourHourLocaleAsShortTime() {
        let result = AssistantTurnTimestampFormatter.shortTime(
            forUnixTimestamp: fixedTimestamp,
            locale: Locale(identifier: "en_GB"),
            timeZone: utc
        )

        XCTAssertNotNil(result)
        XCTAssertTrue(result?.contains("14:14") == true, "Expected 24h time, got \(result ?? "nil")")
        XCTAssertFalse(result?.contains("PM") == true, "24h time must not carry a PM marker")
    }

    func testReturnsNilForNilTimestamp() {
        XCTAssertNil(AssistantTurnTimestampFormatter.shortTime(forUnixTimestamp: nil))
        XCTAssertNil(AssistantTurnTimestampFormatter.shortTime(
            forUnixTimestamp: nil,
            locale: Locale(identifier: "en_US"),
            timeZone: utc
        ))
    }

    func testReturnsNilForNonFiniteTimestamp() {
        XCTAssertNil(AssistantTurnTimestampFormatter.shortTime(forUnixTimestamp: .nan))
        XCTAssertNil(AssistantTurnTimestampFormatter.shortTime(forUnixTimestamp: .infinity))
    }

    func testCurrentLocaleOverloadFormatsFiniteTimestamp() {
        XCTAssertNotNil(AssistantTurnTimestampFormatter.shortTime(forUnixTimestamp: fixedTimestamp))
    }
}

final class ResponseSpeedFormatterTests: XCTestCase {
    func testFormatsOneDecimalWithCompactAndAccessibleUnits() {
        let locale = Locale(identifier: "en_US")

        XCTAssertEqual(ResponseSpeedFormatter.compactText(12.34, locale: locale), "12.3 t/s")
        XCTAssertEqual(
            ResponseSpeedFormatter.accessibilityText(12.34, locale: locale),
            "12.3 tokens per second"
        )
    }

    func testReturnsNilForMissingNonPositiveOrNonFiniteValues() {
        XCTAssertNil(ResponseSpeedFormatter.compactText(nil))
        XCTAssertNil(ResponseSpeedFormatter.compactText(0))
        XCTAssertNil(ResponseSpeedFormatter.compactText(-1))
        XCTAssertNil(ResponseSpeedFormatter.compactText(.infinity))
        XCTAssertNil(ResponseSpeedFormatter.compactText(.nan))
    }
}

final class ReasoningBlockViewTests: XCTestCase {

    func testStartsAtFirstTitleAndStopsForReduceMotion() {
        let titles = ["Plan", "Inspect", "Test"]

        XCTAssertEqual(
            ReasoningTitleRotation.displayedTitle(titles: titles, index: 0, isActive: true),
            "Plan"
        )
        XCTAssertTrue(ReasoningTitleRotation.shouldRotate(isActive: true, reduceMotion: false, titleCount: 3))
        XCTAssertFalse(ReasoningTitleRotation.shouldRotate(isActive: true, reduceMotion: true, titleCount: 3))
        XCTAssertEqual(
            ReasoningTitleRotation.displayedTitle(titles: titles, index: 2, isActive: false),
            "Test"
        )
    }

}
