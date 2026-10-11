import SwiftUI
import TalariaKit

/// A section-list row that selects its item. The item's page shows beside the list at regular
/// width and is pushed over it at compact width (TAL-643).
struct SectionSelectionRow<Label: View>: View {
    let item: SectionItem
    @Binding var selection: SectionItem?
    @ViewBuilder let label: Label

    var body: some View {
        SidebarRow(isSelected: selection == item, action: { selection = item }) {
            HStack(spacing: 8) {
                label
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
        }
    }
}

// MARK: - Sidebar kit
// Every section list draws with the Chats list's chrome: a plain list on the system
// background, bold section headings, and inset rows with the rounded selection tint.

/// A section list with the Chats list's chrome. Content is rows: `SidebarSectionHeader`s and
/// `SidebarRow`s (or any row using `sidebarRow(isSelected:)`).
struct SidebarList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        List {
            content
        }
        .listStyle(.plain)
        // Rows hug their content instead of the 44pt default minimum.
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .background(Color(.systemBackground))
    }
}

/// A section heading inside a `SidebarList`, styled like Chats' "Sessions".
struct SidebarSectionHeader<Trailing: View>: View {
    let title: String?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            if let title {
                Text(title)
                    .font(.title3.bold())
                    .foregroundStyle(.primary)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .sessionsScreenListRow()
    }
}

extension SidebarSectionHeader where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title: title) { EmptyView() }
    }
}

/// A collapsible section of a `SidebarList`: a `SidebarSectionHeader` with the Chats disclosure
/// chevron, and its rows while open. Open state is device-local and remembered per `id`.
struct SidebarDisclosureSection<Trailing: View, Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage private var isExpanded: Bool
    let title: String
    let trailing: Trailing
    let content: Content

    init(
        _ title: String,
        id: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        _isExpanded = AppStorage(wrappedValue: true, "sidebarSection.\(id).isExpanded")
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        SidebarSectionHeader(title: title) {
            trailing
            SidebarDisclosureChevron(isExpanded: isExpanded)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(isExpanded ? Text("Expanded") : Text("Collapsed"))
        .accessibilityAction(.default, toggle)

        if isExpanded {
            content
        }
    }

    private func toggle() {
        withAnimation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion)) {
            isExpanded.toggle()
        }
    }
}

extension SidebarDisclosureSection where Trailing == EmptyView {
    init(_ title: String, id: String, @ViewBuilder content: () -> Content) {
        self.init(title, id: id, trailing: { EmptyView() }, content: content)
    }
}

/// A tappable `SidebarList` row with the Chats row padding and selection tint.
struct SidebarRow<Label: View>: View {
    let isSelected: Bool
    let action: () -> Void
    @ViewBuilder let label: Label

    var body: some View {
        Button(action: action) {
            label
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .sidebarRow(isSelected: isSelected)
    }
}

extension View {
    /// The selected-row tint of the custom lists (chats, skills), with the trait VoiceOver reads.
    func selectedRowBackground(_ isSelected: Bool) -> some View {
        background(
            isSelected ? Color.accentColor.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// A `SidebarList` row's insets and selection tint.
    func sidebarRow(isSelected: Bool) -> some View {
        selectedRowBackground(isSelected)
            .sessionsScreenListRow(insets: EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
    }
}
