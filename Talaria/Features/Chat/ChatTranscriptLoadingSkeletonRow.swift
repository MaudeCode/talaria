import SwiftUI
import UIKit

struct ChatTranscriptLoadingSkeletonRow: View {
    let configuration: ChatTranscriptSkeletonRowConfiguration

    var body: some View {
        switch configuration.role {
        case .assistant:
            assistantRow
        case .user:
            userRow
        }
    }

    private var assistantRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(configuration.lines) { line in
                skeletonLine(line)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }

    private var userRow: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Spacer(minLength: 48)

            VStack(alignment: .trailing, spacing: 8) {
                ForEach(configuration.lines) { line in
                    skeletonLine(line)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemFill))
            .foregroundStyle(.primary)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }

    private func skeletonLine(_ line: ChatTranscriptSkeletonLine) -> some View {
        Text(verbatim: line.text)
            .font(.body)
            .lineLimit(1)
            .frame(maxWidth: line.maxWidth, alignment: configuration.role == .user ? .trailing : .leading)
    }
}
