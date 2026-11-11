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
    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        SidebarList {
            content
        }
        .navigationTitle(title)
        .adaptiveSecondaryNavigationTitle(title: title)
    }
}
