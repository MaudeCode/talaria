import SwiftUI
import UIKit

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
                providerIcon: Self.providerIcon(
                    modelGroups: modelGroups,
                    selectedModelID: selectedModelID,
                    selectedModelProviderID: selectedModelProviderID
                ),
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
            children: compactOptions.map { modelAction($0, subtitle: nil) }
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
        let subtitles = Self.providerSubtitles(for: options, in: modelGroups)
        return UIMenu(
            title: title,
            options: [.displayInline],
            children: zip(options, subtitles).map { modelAction($0, subtitle: $1) }
        )
    }

    private func modelAction(_ option: ModelCatalogOption, subtitle: String?) -> UIAction {
        UIAction(
            title: option.displayName,
            subtitle: subtitle,
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

        append(Self.selectedModelOption(
            in: allModels,
            selectedModelID: selectedModelID,
            selectedModelProviderID: selectedModelProviderID
        ))

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

    /// Provider identity behind the active-model control, resolved through the
    /// catalog so a bare active-provider model id still finds its group, then
    /// the server's `@provider:` tag. Nil when the selection names no provider
    /// anywhere; the model name itself is never used to guess one.
    static func providerIcon(
        modelGroups: [ModelCatalogGroup],
        selectedModelID: String?,
        selectedModelProviderID: String?
    ) -> (id: String, label: String)? {
        let providerID = selectedModelOption(
            in: modelGroups.flatMap(\.models),
            selectedModelID: selectedModelID,
            selectedModelProviderID: selectedModelProviderID
        )?.providerID ?? selectedModelID.flatMap { ProviderQualifiedModelID($0).providerPrefix }
        guard let providerID, let label = modelGroups.providerName(for: providerID) else { return nil }
        return (providerID, label)
    }

    /// Provider names for one section's rows, present only when the section
    /// mixes providers so two same-named models stay distinguishable.
    static func providerSubtitles(
        for options: [ModelCatalogOption],
        in modelGroups: [ModelCatalogGroup]
    ) -> [String?] {
        guard Set(options.map(\.providerID)).count > 1 else { return options.map { _ in nil } }
        return options.map { modelGroups.providerName(for: $0.providerID) }
    }

    private static func selectedModelOption(
        in options: [ModelCatalogOption],
        selectedModelID: String?,
        selectedModelProviderID: String?
    ) -> ModelCatalogOption? {
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
