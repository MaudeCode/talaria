import SwiftUI

/// Composes SidebarSectionHeader and the shared sidebar row chrome for Settings controls.
struct SettingsSection<Content: View, Header: View>: View {
    let content: Content
    let header: Header
    var help: SettingsSectionHelp?
    @State private var presentedHelp: SettingsSectionHelp?

    init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Header) {
        self.content = content()
        self.header = header()
    }

    var body: some View {
        Section {
            if let help {
                SettingsSectionHeader(title: help.title) { presentedHelp = help }
            } else {
                header
            }
            content
                .sidebarRowPadding()
                .sidebarRow(isSelected: false)
                .navigationLinkIndicatorVisibility(.hidden)
        }
        .settingsSectionHelp($presentedHelp)
    }
}

extension SettingsSection where Header == SidebarSectionHeader<EmptyView> {
    init(title: String, help: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(content: content, header: { SidebarSectionHeader(title) })
        self.help = help.map { SettingsSectionHelp(title: title, message: $0) }
    }
}
