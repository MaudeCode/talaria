import SwiftUI

struct ChatToolbarActionSlot<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .labelStyle(.iconOnly)
            .font(.body)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}
