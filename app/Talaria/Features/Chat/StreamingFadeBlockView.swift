import Highlightr
import MarkdownUI
import OSLog
import Splash
import SwiftUI
import UIKit
import TalariaKit

struct StreamingFadeBlockView: View {
    let text: String
    let colorScheme: ColorScheme
    let fadeEnabled: Bool
    let armOnAppear: Bool
    let clock: TimeInterval

    @State private var store: StreamingTextFadeStampStore<Text.Layout.CharacterIndex>

    init(
        text: String,
        colorScheme: ColorScheme,
        fadeEnabled: Bool,
        armOnAppear: Bool,
        clock: TimeInterval,
        chain: StreamingTextFadeStampChain
    ) {
        self.text = text
        self.colorScheme = colorScheme
        self.fadeEnabled = fadeEnabled
        self.armOnAppear = armOnAppear
        self.clock = clock
        _store = State(initialValue: StreamingTextFadeStampStore(chain: chain))
    }

    var body: some View {
        Group {
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if fadeEnabled {
                    ChatMarkdownView(
                        content: text,
                        colorScheme: colorScheme,
                        isStreaming: true
                    )
                    .textRenderer(StreamingTextFadeRenderer(clock: clock, store: store))
                } else {
                    ChatMarkdownView(
                        content: text,
                        colorScheme: colorScheme,
                        isStreaming: true
                    )
                }
            }
        }
        .onAppear {
            // Blocks appearing after the view mounted are newly streamed text
            // and must fade from their first glyph; blocks present at mount
            // are pre-existing text and take the solid baseline instead.
            if armOnAppear {
                store.rolloverReset()
            }
        }
    }
}
