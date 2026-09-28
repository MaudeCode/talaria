import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct StreamingMarkdownChunkedView: View {
    let content: String
    let colorScheme: ColorScheme

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(StreamedTextAnimationSettings.isEnabledKey) private var isStreamedTextAnimationEnabled = true

    /// First block ordinal still in the fade window. Starts at `Int.max`
    /// (everything solid) until `onAppear` anchors it at the current block,
    /// so text already on screen when the view mounts never fades.
    @State private var firstFadeOrdinal = Int.max
    /// Ordinal of the current block at mount; only blocks created after it
    /// arm their stores (pre-existing blocks take the solid baseline).
    @State private var mountBoundaryCount = Int.max
    @State private var lastBoundaryCount = 0
    @State private var lastTouchedAt: [Int: TimeInterval] = [:]
    @State private var fadesActive = false
    /// One reveal cursor for all fade blocks of this view, so consecutive
    /// blocks (paragraphs, list items) appear in reading order even when a
    /// fast stream backlogs a block's queue toward `maxStampLead`.
    @State private var chain = StreamingTextFadeStampChain()

    private var segments: StreamingMarkdownBlockSegments {
        StreamingMarkdownBlockSplitter.split(content)
    }

    var body: some View {
        let blockSplit = StreamingTextFadeTailSplitter.split(
            segments.activeMarkdown,
            firstFadeOrdinal: StreamedTextAnimationSettings.effectiveFirstFadeOrdinal(
                firstFadeOrdinal,
                reduceMotion: reduceMotion,
                isEnabled: isStreamedTextAnimationEnabled
            )
        )

        VStack(alignment: .leading, spacing: 0) {
            ForEach(segments.stableChunks) { chunk in
                ChatMarkdownView(
                    content: chunk.text,
                    colorScheme: colorScheme,
                    isStreaming: false
                )
            }

            if !blockSplit.head.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ChatMarkdownView(
                    content: blockSplit.head,
                    colorScheme: colorScheme,
                    isStreaming: true
                )
            }

            if !blockSplit.blocks.isEmpty {
                // One shared frame clock for every fade block. Per frame only
                // the renderer's clock input changes; each block's markdown
                // inputs are untouched, so their bodies (and text layout) are
                // not re-evaluated.
                TimelineView(.animation(minimumInterval: nil, paused: !fadesActive)) { context in
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(blockSplit.blocks, id: \.ordinal) { block in
                            StreamingFadeBlockView(
                                text: block.text,
                                colorScheme: colorScheme,
                                fadeEnabled: block.fadeEnabled,
                                armOnAppear: block.ordinal > mountBoundaryCount,
                                clock: context.date.timeIntervalSinceReferenceDate,
                                chain: chain
                            )
                        }
                    }
                }
            }
        }
        .onAppear {
            anchorFadeWindowAtCurrentBlock()
        }
        .onChange(of: content) { oldContent, newContent in
            advanceFadeWindow(from: oldContent, to: newContent)
        }
        .onChange(of: isStreamedTextAnimationEnabled) { _, isEnabled in
            if isEnabled {
                anchorFadeWindowAtCurrentBlock()
            }
        }
        .onChange(of: reduceMotion) { _, reduceMotion in
            if !reduceMotion {
                anchorFadeWindowAtCurrentBlock()
            }
        }
        .task(id: content) {
            // Let queued reveals and the newest fade finish, then pause frame
            // updates until more content arrives (e.g. the stream stalls on
            // tool use). A new change cancels this task and restarts it.
            try? await Task.sleep(for: .seconds(StreamingTextFadeDefaults.framePauseDelay))
            guard !Task.isCancelled else { return }
            fadesActive = false
        }
    }

    /// Anchors the fade window at the current block: everything visible now
    /// takes the solid baseline, only text streamed afterwards fades. Used at
    /// mount, and again whenever fading becomes active mid-stream (animation
    /// setting flipped on, Reduce Motion turned off) — the window bookkeeping
    /// keeps advancing while fades route to the head, so without re-anchoring
    /// the reopened window would arm blocks the user is already reading and
    /// visibly re-fade them.
    private func anchorFadeWindowAtCurrentBlock() {
        let split = StreamingTextFadeTailSplitter.split(segments.activeMarkdown, firstFadeOrdinal: 0)
        firstFadeOrdinal = split.boundaryCount
        mountBoundaryCount = split.boundaryCount
        lastBoundaryCount = split.boundaryCount
        lastTouchedAt = [:]
    }

    private func advanceFadeWindow(from oldContent: String, to newContent: String) {
        let now = Date().timeIntervalSinceReferenceDate
        let oldActive = StreamingMarkdownBlockSplitter.split(oldContent).activeMarkdown
        let newActive = StreamingMarkdownBlockSplitter.split(newContent).activeMarkdown
        let split = StreamingTextFadeTailSplitter.split(newActive, firstFadeOrdinal: firstFadeOrdinal)

        if !newActive.hasPrefix(oldActive) {
            // Replaced content or a sealed stable chunk shifted the active
            // window: ordinals no longer line up, so restart the fade window
            // at the current block (renders solid, then new text fades).
            lastTouchedAt = [:]
            firstFadeOrdinal = split.boundaryCount
            lastBoundaryCount = split.boundaryCount
            chain.reset()
            fadesActive = true
            return
        }

        // Only the current block and any blocks newly created by this append
        // were touched; everything earlier is frozen text aging toward
        // absorption. min() also covers an item boundary vanishing when its
        // nested child arrives (the merged block is current again).
        for block in split.blocks where block.ordinal >= min(lastBoundaryCount, split.boundaryCount) {
            lastTouchedAt[block.ordinal] = now
        }
        lastBoundaryCount = split.boundaryCount

        firstFadeOrdinal = StreamingTextFadeWindow.advanceStart(
            current: min(firstFadeOrdinal, split.boundaryCount),
            boundaryCount: split.boundaryCount,
            lastTouchedAt: lastTouchedAt,
            now: now
        )
        lastTouchedAt = lastTouchedAt.filter { $0.key >= firstFadeOrdinal }
        fadesActive = true
    }
}
