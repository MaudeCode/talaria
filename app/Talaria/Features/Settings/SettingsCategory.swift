import SwiftUI
import TalariaKit

struct SettingsCategoryPage<Content: View>: View {
    let category: SettingsCategory
    @ViewBuilder let content: Content

    init(category: SettingsCategory, @ViewBuilder content: () -> Content) {
        self.category = category
        self.content = content()
    }

    var body: some View {
        SettingsPage(title: category.title) {
            content
        }
    }
}

struct SettingsPage<Content: View>: View {
    @ScaledMetric(relativeTo: .body) private var cardSpacing: CGFloat = 18

    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(spacing: cardSpacing) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 36)
            .adaptiveReadableContent(maxWidth: AdaptiveReadableContentWidth.secondaryDestination)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(title)
    }
}
