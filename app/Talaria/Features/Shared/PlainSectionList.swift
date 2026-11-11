import SwiftUI

private enum PlainSectionMetrics {
    static let horizontalInset: CGFloat = 20
    static let rowInset: CGFloat = 10
    static let compactRowInset: CGFloat = 8
}

extension View {
    func plainSectionList() -> some View {
        self
            .listStyle(.plain)
            .background(Color(.systemBackground))
    }

    func plainSectionRow(compact: Bool = false, separator: Visibility = .automatic) -> some View {
        let verticalInset = compact ? PlainSectionMetrics.compactRowInset : PlainSectionMetrics.rowInset
        return self
            .listRowInsets(EdgeInsets(
                top: verticalInset, leading: PlainSectionMetrics.horizontalInset,
                bottom: verticalInset, trailing: PlainSectionMetrics.horizontalInset
            ))
            .listRowSeparator(separator)
    }
}

/// A SwiftUI Section header; SidebarSectionHeader is a selectable row inside a SidebarList.
struct PlainSectionHeader: View {
    let title: String
    var detail: String? = nil
    var isRefreshing = false
    var refreshingLabel: LocalizedStringKey = "Refreshing"

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            if isRefreshing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(Text(refreshingLabel))
            }
            Spacer(minLength: 8)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, PlainSectionMetrics.horizontalInset)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
        .listRowInsets(EdgeInsets())
    }
}
