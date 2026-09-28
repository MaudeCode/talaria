import SwiftUI
import TalariaKit

struct ComposerVoiceStatusView: View {
    let status: ComposerVoiceStatus

    var body: some View {
        Label(status.text, systemImage: status.systemImage)
            .font(.caption)
            .foregroundStyle(status.isError ? Color.red : Color.secondary)
    }
}
