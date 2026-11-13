import Foundation

/// Shared provider disclosure state. Only explicit collapses persist; filtered matches stay visible.
public struct ComposerModelPickerSectionExpansionState: Sendable {
    public init(collapsedGroupIDs: Set<String> = []) { self.collapsedGroupIDs = collapsedGroupIDs }
    public private(set) var collapsedGroupIDs: Set<String>
    private var isFiltering = false

    public mutating func updateSearchText(_ searchText: String) {
        isFiltering = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func isExpanded(groupID: String) -> Bool { isFiltering || !collapsedGroupIDs.contains(groupID) }

    public mutating func setExpanded(_ isExpanded: Bool, groupID: String) {
        guard !isFiltering else { return }
        if isExpanded { collapsedGroupIDs.remove(groupID) }
        else { collapsedGroupIDs.insert(groupID) }
    }
}
