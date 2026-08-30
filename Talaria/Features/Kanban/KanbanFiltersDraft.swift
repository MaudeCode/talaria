import SwiftUI
import UIKit

@MainActor
struct KanbanFiltersDraft {
    var profile: String?
    var tenant: String?
    var includesArchived: Bool
    var onlyMine: Bool
    var groupsByProfile: Bool

    init(model: KanbanFeatureState) {
        profile = model.selectedProfile
        tenant = model.selectedTenant
        includesArchived = model.includeArchived
        onlyMine = model.onlyMine
        groupsByProfile = model.groupByProfile
    }

    func apply(to model: KanbanFeatureState) async {
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
