import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TalariaKit

struct TranscriptMediaVideoTile: View {
    let reference: TranscriptMediaReference

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.secondarySystemBackground))
                .frame(width: 210, height: 132)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color(.separator).opacity(0.35), lineWidth: 0.5)
                )

            VStack(spacing: 8) {
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Color.accentColor)

                Text(reference.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 172)

                Text("Video")
                    .font(.caption2)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .padding(.horizontal, 14)
        }
    }
}
