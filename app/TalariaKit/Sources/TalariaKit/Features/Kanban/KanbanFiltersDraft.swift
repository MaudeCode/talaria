import SwiftUI

@MainActor
public struct KanbanFiltersDraft {
    public var profile: String?
    public var tenant: String?
    public var includesArchived: Bool
    public var onlyMine: Bool
    public var groupsByProfile: Bool

    public init(model: KanbanFeatureState) {
        profile = model.selectedProfile
        tenant = model.selectedTenant
        includesArchived = model.includeArchived
        onlyMine = model.onlyMine
        groupsByProfile = model.groupByProfile
    }

    public func apply(to model: KanbanFeatureState) async {
        let serverFiltersChanged = profile != model.selectedProfile
            || tenant != model.selectedTenant
            || includesArchived != model.includeArchived
            || onlyMine != model.onlyMine
        model.groupByProfile = groupsByProfile
        guard serverFiltersChanged else { return }
        await model.applyFilters(
            profile: profile,
            tenant: tenant,
            includeArchived: includesArchived,
            onlyMine: onlyMine
        )
    }
}
