import SwiftUI

/// Composes SidebarSectionHeader and the shared sidebar row chrome for Settings controls.
struct SettingsSection<Content: View, Header: View>: View {
    let content: Content
    let header: Header

    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header) {
        self.content = content()
        self.header = header()
    }

    var body: some View {
        Section {
            header
            content
                .sidebarRowPadding()
                .sidebarRow(isSelected: false)
                .navigationLinkIndicatorVisibility(.hidden)
        }
    }
}

extension SettingsSection where Header == SidebarSectionHeader<EmptyView> {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { SidebarSectionHeader(title) })
    }
}
