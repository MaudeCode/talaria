import SwiftUI

struct SidebarSelectedSubrowIndicator: View {
    var body: some View {
        Image(systemName: "checkmark")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(Color.accentColor, in: Circle())
            .accessibilityHidden(true)
    }
}
