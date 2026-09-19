import SwiftUI

struct ProjectContextSectionFooter: View {
    let detail: String?
    let isShadowed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let detail {
                Text(verbatim: detail)
            }
            if isShadowed {
                Text("A workspace-local file is overriding the global project context.")
            }
        }
    }
}
