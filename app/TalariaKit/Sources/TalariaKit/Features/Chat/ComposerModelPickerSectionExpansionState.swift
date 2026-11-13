import Foundation

public struct ComposerModelPickerSectionExpansionState: Sendable {

    public init(initiallyExpanded: Bool = false, collapsedGroupIDs: Set<String> = []) {
        self.initiallyExpanded = initiallyExpanded
        self.collapsedGroupIDs = collapsedGroupIDs
    }

    private let initiallyExpanded: Bool
    public private(set) var collapsedGroupIDs: Set<String>

    private var expandedGroupIDs: Set<String> = []
    private var collapsedSearchGroupIDs: Set<String> = []
    private var searchQuery = ""

    public mutating func updateSearchText(_ searchText: String) {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query != searchQuery else { return }

        searchQuery = query
        collapsedSearchGroupIDs.removeAll()
    }

    public func isExpanded(groupID: String) -> Bool {
        if searchQuery.isEmpty {
            return initiallyExpanded ? !collapsedGroupIDs.contains(groupID) : expandedGroupIDs.contains(groupID)
        }

        return !collapsedSearchGroupIDs.contains(groupID)
    }

    public mutating func setExpanded(_ isExpanded: Bool, groupID: String) {
        if searchQuery.isEmpty {
            if isExpanded {
                expandedGroupIDs.insert(groupID)
                collapsedGroupIDs.remove(groupID)
            } else {
                expandedGroupIDs.remove(groupID)
                collapsedGroupIDs.insert(groupID)
            }
        } else if isExpanded {
            collapsedSearchGroupIDs.remove(groupID)
        } else {
            collapsedSearchGroupIDs.insert(groupID)
        }
    }
}
