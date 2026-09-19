import SwiftUI
import UIKit

struct ChatOfflineCacheBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
                .imageScale(.small)

            Text("Offline — viewing cached version")
                .font(.subheadline)
                .fontWeight(.semibold)

            Spacer()
        }
        .foregroundStyle(.orange)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.12))
        .accessibilityElement(children: .combine)
    }
}
