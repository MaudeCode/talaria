import SwiftUI

struct ApprovalBypassStatusPill: View {
    var body: some View {
        Label("Approval bypass active", systemImage: "bolt.slash.fill")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .overlay(
                Capsule()
                    .stroke(.primary.opacity(0.10), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
    }
}
