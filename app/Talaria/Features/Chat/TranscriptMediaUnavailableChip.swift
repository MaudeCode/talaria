import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaUnavailableChip: View {
    let reference: TranscriptMediaReference

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color(.secondaryLabel))

            VStack(alignment: .leading, spacing: 2) {
                Text(reference.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text("Media unavailable")
                    .font(.caption2)
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: 240, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "Media unavailable \(reference.accessibilityName)"))
    }

    private var iconName: String {
        switch reference.mediaKind {
        case .image:
            "photo"
        case .audio:
            "waveform"
        case .video:
            "play.rectangle"
        case .unsupported:
            "doc"
        }
    }
}
