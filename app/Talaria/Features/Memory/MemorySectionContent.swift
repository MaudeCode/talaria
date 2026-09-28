import SwiftUI
import TalariaKit

struct MemorySectionContent: View {
    let section: MemorySection
    let content: String

    var body: some View {
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(section.emptyMessage)
                .foregroundStyle(.secondary)
                .italic()
        } else {
            MarkdownRenderer(content: content)
        }
    }
}
