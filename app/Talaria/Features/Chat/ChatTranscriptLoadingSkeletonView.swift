import SwiftUI
import UIKit

struct ChatTranscriptLoadingSkeletonView: View {
    private let rows = ChatTranscriptSkeletonRowConfiguration.loadingRows

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ForEach(rows) { row in
                    ChatTranscriptLoadingSkeletonRow(configuration: row)
                }

                Color.clear
                    .frame(height: 1)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal)
            .padding(.top, 16)
        }
        .scrollDisabled(true)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading messages")
    }
}
