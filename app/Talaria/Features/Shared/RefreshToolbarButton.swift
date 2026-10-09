import SwiftUI

/// A screen's toolbar Refresh, disabled while it loads. It keeps the same label throughout: a
/// `ProgressView` in its place is a custom view, which iPhone Duo keeps out of its vertical bar
/// (TAL-483). The toolbar bridge also drops symbol effects, so the dimmed button is the cue.
struct RefreshToolbarButton: View {
    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Refresh", systemImage: "arrow.clockwise")
        }
        .disabled(isLoading)
    }
}
