import XCTest
@testable import TalariaKit

final class ChatViewModelMergeDedupTests: XCTestCase {

    // #330 regression: a server-transcribed voice note sends the bare transcript
    // (no "[Attached files:]" marker). The server frequently returns the clip
    // attachment on reload as a bare filename (no path), while the optimistic
    // bubble holds the full upload path. Dedup must still match them so the
    // optimistic message isn't re-inserted as a duplicate user turn.
    func testVoiceNoteDedupesWhenServerReturnsBareFilenameAttachment() {
        let transcript = "The last chatted about this portable monstrosity"
        let optimistic = ChatMessage(
            role: "user",
            content: transcript,
            timestamp: 1000,
            messageId: "local-ABC123",
            attachments: [
                MessageAttachment(
                    name: "voice-note-7765a1e2.m4a",
                    path: "/Users/hermes/.hermes/webui/attachments/db9/voice-note-7765a1e2.m4a",
                    mime: "audio/mp4a-latm",
                    size: 116155,
                    isImage: false
                )
            ]
        )
        let reloaded = ChatMessage(
            role: "user",
            content: transcript,
            timestamp: 1000,
            messageId: "server-1",
            attachments: [MessageAttachment(name: "voice-note-7765a1e2.m4a", path: nil)]
        )

        let merged = ChatViewModel.mergingLoadedMessages(
            [reloaded],
            withCachedLocalOptimisticMessages: [optimistic]
        )

        XCTAssertEqual(
            merged.filter { $0.role == "user" }.count, 1,
            "Optimistic voice note must dedupe against a bare-filename reload"
        )
    }

    // Sanity: a full-object reload whose path is a different directory than the
    // optimistic upload path also dedupes via basename normalization.
    func testVoiceNoteDedupesWhenReloadPathDirectoryDiffers() {
        let transcript = "Hello, hello, testing. Can you hear me?"
        let optimistic = ChatMessage(
            role: "user", content: transcript, timestamp: 2000, messageId: "local-XYZ",
            attachments: [MessageAttachment(name: "voice-note-d6.m4a", path: "/tmp/upload/voice-note-d6.m4a")]
        )
        let reloaded = ChatMessage(
            role: "user", content: transcript, timestamp: 2000, messageId: "server-2",
            attachments: [MessageAttachment(name: "voice-note-d6.m4a",
                                            path: "/Users/hermes/.hermes/webui/attachments/x/voice-note-d6.m4a")]
        )
        let merged = ChatViewModel.mergingLoadedMessages([reloaded], withCachedLocalOptimisticMessages: [optimistic])
        XCTAssertEqual(merged.filter { $0.role == "user" }.count, 1)
    }

    // Guard: genuinely different attachment filenames must NOT be deduped away.
    func testDifferentAttachmentFilenamesAreNotDeduped() {
        let optimistic = ChatMessage(
            role: "user", content: "same text", timestamp: 3000, messageId: "local-1",
            attachments: [MessageAttachment(name: "alpha.m4a", path: "/tmp/alpha.m4a")]
        )
        let reloaded = ChatMessage(
            role: "user", content: "same text", timestamp: 3000, messageId: "server-3",
            attachments: [MessageAttachment(name: "beta.m4a", path: nil)]
        )
        let merged = ChatViewModel.mergingLoadedMessages([reloaded], withCachedLocalOptimisticMessages: [optimistic])
        XCTAssertEqual(merged.filter { $0.role == "user" }.count, 2,
                       "Different attachment filenames are distinct messages")
    }

    func testReloadEnrichesMatchingAssistantWithMissingCachedActivity() {
        let cached = ChatMessage(
            role: "assistant",
            content: "Cached answer",
            timestamp: 4_000,
            messageId: "assistant-1",
            toolCalls: [.object(["id": .string("call-1")])],
            contentParts: [.object(["type": .string("reasoning"), "text": .string("Cached reasoning")])],
            reasoning: "Cached reasoning",
            turnDuration: 12,
            turnTps: 8
        )
        let loaded = ChatMessage(
            role: "assistant",
            content: "Server answer",
            timestamp: 4_001,
            messageId: "assistant-1"
        )

        let merged = ChatViewModel.mergingLoadedMessages(
            [loaded],
            withCachedLocalOptimisticMessages: [cached]
        )

        XCTAssertEqual(merged.first?.content, "Server answer")
        XCTAssertEqual(merged.first?.timestamp, 4_001)
        XCTAssertEqual(merged.first?.contentParts, cached.contentParts)
        XCTAssertEqual(merged.first?.toolCalls, cached.toolCalls)
        XCTAssertEqual(merged.first?.reasoning, "Cached reasoning")
        XCTAssertEqual(merged.first?.turnDuration, 12)
        XCTAssertEqual(merged.first?.turnTps, 8)
    }

    /// TAL-1678: every load with a cache, a cache-first open and a finished run's reload merge the whole cached
    /// transcript on the main actor, so the merge must stay linear in its length. Across this 4x span a linear merge
    /// costs ~4x; looking each reply up by scanning the cache cost ~16x.
    func testReloadMergeStaysLinearInCachedTranscriptLength() {
        func fastestMerge(messageCount: Int) -> Double {
            let messages = (0..<messageCount).map { index in
                ChatMessage(role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index)",
                            timestamp: Double(index), messageId: "message-\(index)")
            }
            return (0..<5).map { _ in
                let start = DispatchTime.now().uptimeNanoseconds
                let merged = ChatViewModel.mergingLoadedMessages(messages, withCachedLocalOptimisticMessages: messages)
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start)
                XCTAssertEqual(merged.count, messageCount)
                return elapsed
            }.min()!
        }

        let growth = fastestMerge(messageCount: 4_000) / fastestMerge(messageCount: 1_000)
        XCTAssertLessThan(growth, 8, "Merging 4x the cached messages cost \(String(format: "%.1f", growth))x")
    }
}
