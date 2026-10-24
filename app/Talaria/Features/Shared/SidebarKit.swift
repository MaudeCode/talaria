import SwiftUI
import TalariaKit

/// A list row selecting a page within a section or Settings.
struct SectionSelectionRow<Item: Hashable, Label: View>: View {
    let item: Item
    @Binding var selection: Item?
    @ViewBuilder let label: Label

    var body: some View {
        Button {
            selection = item
        } label: {
            HStack(spacing: 8) {
                label
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .sidebarRowPadding()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .sidebarRow(isSelected: selection == item)
    }
}

// MARK: - Sidebar kit
// Every section list draws with the Chats list's chrome: a plain list on the system
// background, bold section headings, and inset rows with the rounded selection tint.

/// A section list with the Chats list's chrome. Content is rows: `SidebarSectionHeader`s and
/// rows using `sidebarRow(isSelected:)`.
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
    var topPadding: CGFloat = 16
    var isCompact = false
    /// Makes the heading a button, for a collapsible section.
    var toggle: (() -> Void)?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        Group {
            if let toggle {
                HapticButton(action: toggle) {
                    label.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // The button merges its label, which drops the title's header trait.
                .accessibilityAddTraits(.isHeader)
            } else {
                label
            }
        }
        .sessionsScreenListRow()
    }

    private var label: some View {
        HStack(spacing: 10) {
            if let title {
                Text(title)
                    .font(isCompact ? .footnote.weight(.semibold) : .title3.bold())
                    .foregroundStyle(isCompact ? Color.secondary : .primary)
                    .textCase(nil)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer()
            trailing
        }
        .frame(minHeight: isCompact && toggle != nil ? 24 : 0)
        .padding(.horizontal, 24)
        .padding(.top, isCompact ? 16 : topPadding)
        .padding(.bottom, isCompact ? 4 : 8)
    }
}

extension SidebarSectionHeader where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title: title) { EmptyView() }
    }
}

/// A collapsible section of a `SidebarList`: a `SidebarSectionHeader` with the Chats disclosure
/// chevron, and its rows while open. Open state is device-local and stored under `storageKey`.
struct SidebarDisclosureSection<Trailing: View, Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage private var isExpanded: Bool
    let title: String
    let trailing: Trailing
    let content: Content

    init(
        _ title: String,
        storageKey: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        _isExpanded = AppStorage(wrappedValue: true, storageKey)
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        SidebarSectionHeader(title: title, toggle: toggle) {
            trailing
            SidebarDisclosureChevron(isExpanded: isExpanded)
        }
        .accessibilityValue(isExpanded ? Text("Expanded") : Text("Collapsed"))

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
    init(_ title: String, storageKey: String, @ViewBuilder content: () -> Content) {
        self.init(title, storageKey: storageKey, trailing: { EmptyView() }, content: content)
    }
}

extension View {

    /// A `SidebarList` row's content padding, for rows with and without an action.
    func sidebarRowPadding() -> some View {
        padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
    }

    /// A `SidebarList` row's insets and selection tint, with the trait VoiceOver reads.
    func sidebarRow(isSelected: Bool) -> some View {
        background(
            isSelected ? Color.accentColor.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .sessionsScreenListRow(insets: EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
    }
}
