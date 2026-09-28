import SwiftUI
import UIKit
import TalariaKit

struct ComposerModelMenu: View {
    let modelGroups: [ModelCatalogGroup]
    let selectedModelID: String?
    let selectedModelProviderID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let favoriteModelKeys: [ModelFavoriteKey]
    let recentModelKeys: [ModelFavoriteKey]
    let isDisabled: Bool
    let maxWidth: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    let onSelectModel: (ModelCatalogOption) -> Void
    let onShowAllModels: () -> Void

    var body: some View {
        ChatUIKitMenuButton(horizontalPadding: 0, verticalPadding: 14) {
            ComposerMetaControlLabel(
                title: selectedModelTitle,
                systemImage: nil,
                maxWidth: maxWidth,
                color: color,
                controlFont: controlFont,
                chevronFont: chevronFont
            )
        } menu: {
            makeModelMenu()
        }
        .tint(color)
        .disabled(isDisabled)
        .accessibilityLabel("Select model")
    }

    private func makeModelMenu() -> UIMenu {
        if isLoadingModels {
            return UIMenu(children: [disabledMenuAction(title: String(localized: "Loading models..."))])
        }

        var children: [UIMenuElement] = []
        if modelGroups.isEmpty && favoriteOptions.isEmpty && recentOptions.isEmpty && compactOptions.isEmpty {
            children.append(disabledMenuAction(title: String(localized: "No catalog models")))
        }

        if !favoriteOptions.isEmpty {
            children.append(modelSection(title: String(localized: "Favorites"), options: favoriteOptions))
        }

        if !recentOptions.isEmpty {
            children.append(modelSection(title: String(localized: "Recent"), options: recentOptions))
        }

        children.append(UIMenu(
            title: String(localized: "Model"),
            options: [.displayInline],
            children: compactOptions.map(modelAction)
                + [
                    UIAction(title: String(localized: "All Models...")) { _ in
                        Task { @MainActor in
                            await Task.yield()
                            onShowAllModels()
                        }
                    }
                ]
        ))

        return UIMenu(children: children)
    }

    private func modelSection(title: String, options: [ModelCatalogOption]) -> UIMenu {
        UIMenu(
            title: title,
            options: [.displayInline],
            children: options.map(modelAction)
        )
    }

    private func modelAction(_ option: ModelCatalogOption) -> UIAction {
        UIAction(
            title: option.displayName,
            state: isSelected(option) ? .on : .off
        ) { _ in
            Task { @MainActor in
                onSelectModel(option)
            }
        }
    }

    private func disabledMenuAction(title: String) -> UIAction {
        let action = UIAction(title: title) { _ in }
        action.attributes.insert(.disabled)
        return action
    }

    private var compactOptions: [ModelCatalogOption] {
        let allModels = modelGroups.flatMap(\.models)
        let favoriteKeys = Set(favoriteOptions.map(\.favoriteKey))
        let recentKeys = Set(recentOptions.map(\.favoriteKey))
        var seen = Set<ModelFavoriteKey>()
        var result: [ModelCatalogOption] = []

        func append(_ option: ModelCatalogOption?) {
            guard let option,
                  !favoriteKeys.contains(option.favoriteKey),
                  !recentKeys.contains(option.favoriteKey),
                  seen.insert(option.favoriteKey).inserted else { return }
            result.append(option)
        }

        append(selectedModelOption(in: allModels))

        return result
    }

    private var favoriteOptions: [ModelCatalogOption] {
        ModelFavoritesStore.visibleFavoriteOptions(
            in: modelGroups,
            favoriteKeys: favoriteModelKeys
        )
    }

    private var recentOptions: [ModelCatalogOption] {
        ModelRecentsStore.visibleRecentOptions(
            in: modelGroups,
            recentKeys: recentModelKeys,
            favoriteKeys: favoriteModelKeys
        )
    }

    private func selectedModelOption(in options: [ModelCatalogOption]) -> ModelCatalogOption? {
        guard let selectedModelID, !selectedModelID.isEmpty else { return nil }

        if let selectedModelProviderID {
            return options.firstMatchingSelection(
                modelID: selectedModelID,
                providerID: selectedModelProviderID
            )
            ?? ModelCatalogOption(
                id: selectedModelID,
                displayName: selectedModelID,
                providerID: selectedModelProviderID
            )
        }

        return options.firstMatchingSelection(modelID: selectedModelID, providerID: nil)
            ?? ModelCatalogOption(
                id: selectedModelID,
                displayName: selectedModelID,
                providerID: nil
            )
    }

    private func isSelected(_ option: ModelCatalogOption) -> Bool {
        option.matchesSelection(modelID: selectedModelID, providerID: selectedModelProviderID)
    }
}
