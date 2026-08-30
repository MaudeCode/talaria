import AVFoundation
import AVKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct TranscriptVideoPreviewPlayerView: View {
    let url: URL

    @State private var player: AVPlayer?

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            player?.pause()
            player = AVPlayer(url: url)
        }
        .onDisappear {
            player?.pause()
        }
    }
}
