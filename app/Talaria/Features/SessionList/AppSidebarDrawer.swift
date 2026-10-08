import SwiftUI
import TalariaKit

struct AppSidebarDrawer: View {
    @AccessibilityFocusState private var closeNavigationIsFocused: Bool
    @State private var viewportHeight: CGFloat = 0
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(ProviderQuotaSidebarSettings.detailKey)
    private var quotaDetailRawValue = ProviderQuotaSidebarDetail.defaultValue.rawValue
    @AppStorage(ProviderQuotaSidebarSettings.showsRailKey) private var showsQuotaRail = true
    @AppStorage(ProviderQuotaSidebarSettings.showsMarkerKey) private var showsQuotaMarker = true
    @AppStorage(ProviderQuotaSidebarSettings.showsIconKey) private var showsQuotaIcon = true
    @AppStorage(ProviderQuotaSidebarSettings.colorsByStateKey) private var colorsQuotaByState = true

    let isPresented: Bool
    let selection: AppSidebarDestination
    let sectionVisibility: SidebarSectionVisibility
    let serverName: String
    let activeProfileName: String?
    let quotaSources: [ProviderQuotaWidgetSource]
    let newChat: () -> Void
    let select: (AppSidebarDestination) -> Void
    let close: () -> Void

    var body: some View {
        // Everything above Settings scrolls: at accessibility sizes in landscape the header and
        // New Chat alone fill the screen, and a scroll view for the rows only was left with no
        // height (TAL-416). The minimum height keeps the quota rows down by Settings when
        // everything fits.
        VStack(spacing: 0) {
            ScrollView {
                drawerContent
                    .frame(minHeight: viewportHeight, alignment: .top)
            }
            .scrollBounceBehavior(.basedOnSize)
            // The container already excludes the content insets; subtracting them again left a
            // gap the height of the top safe area under the quota rows once the drawer opened (TAL-663).
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height
            } action: { _, height in
                viewportHeight = height
            }

            Divider().padding(.horizontal, 12)
            row("Settings", icon: .system("gearshape"), destination: .settings)
                .padding(12)
        }
        .safeAreaPadding(.top, 12)
        .safeAreaPadding(.bottom, 8)
        .frame(maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(isPresented ? .isModal : [])
        .accessibilityIdentifier("app-sidebar")
        .onChange(of: isPresented) { _, isPresented in
            guard isPresented else { return }
            Task { @MainActor in
                await Task.yield()
                guard self.isPresented else { return }
                closeNavigationIsFocused = true
            }
        }
        .accessibilityHidden(!isPresented)
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Image("TalariaWordmark")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 145, height: 34, alignment: .leading)
                        .accessibilityLabel("Talaria")

                    Text(serverName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    if let activeProfileName {
                        Text("Profile: \(activeProfileName)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .frame(width: 36, height: 36)
                        .background(.quaternary, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close navigation")
                .accessibilityHint("Closes navigation and returns to the current screen.")
                .accessibilityFocused($closeNavigationIsFocused)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 14)

            HapticButton(feedbackStyle: .medium, action: newChat) {
                Label("New Chat", systemImage: "square.and.pencil")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 12)
            .padding(.bottom, 14)

            VStack(alignment: .leading, spacing: 2) {
                sectionHeader("Work")
                row("Chats", icon: .system("bubble.left.and.bubble.right"), destination: .chats)
                if sectionVisibility.tasks {
                    row("Tasks", icon: .asset("LucideCalendarClock"), destination: .tasks)
                }
                if sectionVisibility.kanban {
                    row("Kanban", icon: .asset("LucideColumns3"), destination: .kanban)
                }

                if showsAgentSection {
                    sectionHeader("Agent")
                        .padding(.top, 10)
                }

                if sectionVisibility.skills {
                    row("Skills", icon: .asset("LucideHammer"), destination: .skills)
                }
                if sectionVisibility.memory {
                    row("Memory", icon: .asset("LucideBrain"), destination: .memory)
                }
                if sectionVisibility.insights {
                    row("Insights", icon: .asset("LucideChartColumnIncreasing"), destination: .insights)
                }
            }
            .padding(.horizontal, 12)

            Spacer(minLength: 0)

            if !quotaSources.isEmpty {
                Divider().padding(.horizontal, 12)
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(quotaSources) { source in
                        quotaRow(source)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
    }

    private enum Icon {
        case asset(String)
        case system(String)
    }

    private var showsAgentSection: Bool {
        sectionVisibility.skills || sectionVisibility.memory || sectionVisibility.insights
    }

    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .padding(.horizontal, 14)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private func row(
        _ title: LocalizedStringKey,
        icon: Icon,
        destination: AppSidebarDestination
    ) -> some View {
        let tint = selection == destination ? Color.accentColor : Color.primary

        return Button {
            select(destination)
        } label: {
            HStack(spacing: 12) {
                sidebarIcon(icon, tint: tint)

                Text(title)
                    .font(.body.weight(.semibold))
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 0)
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(
                selection == destination ? Color.accentColor.opacity(0.14) : Color.clear,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == destination ? .isSelected : [])
    }

    private func quotaRow(_ source: ProviderQuotaWidgetSource) -> some View {
        let options = ProviderQuotaSidebarDisplayOptions(
            detail: ProviderQuotaSidebarDetail(rawValue: quotaDetailRawValue) ?? .defaultValue,
            showsRail: showsQuotaRail,
            requestsPaceMarker: showsQuotaMarker,
            showsIcon: showsQuotaIcon,
            colorsByState: colorsQuotaByState
        )
        let state = ProviderQuotaPresentation.state(
            for: source,
            settings: ProviderQuotaEvaluationSettings.stored(),
            at: Date()
        )
        let tint = options.colorsByState
            ? ProviderQuotaWidgetPalette.arcColor(
                urgency: state.urgency,
                profile: ProviderQuotaWidgetResolvedProfile.resolve(id: nil)
            )
            : Color.accentColor
        let detail = ProviderQuotaSidebarPresentation.detail(
            mode: options.detail,
            source: source,
            state: state
        )

        return HStack(spacing: 10) {
            if options.showsIcon {
                ProviderIconView(
                    providerID: source.providerID,
                    label: providerDisplayName(source),
                    tint: tint,
                    size: 20
                )
                    .frame(width: 24)
            }

            VStack(spacing: 4) {
                HStack {
                    Text(providerDisplayName(source))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)

                    Spacer(minLength: 8)

                    if let detail {
                        Text(detail)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if options.showsRail, let percent = state.percent {
                    quotaRail(
                        percent: percent,
                        expectedPercent: options.showsPaceMarker ? state.expectedPercent : nil,
                        tint: tint
                    )
                }
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .accessibilityIdentifier("app-sidebar-quota-\(source.sourceID)")
        .accessibilityLabel(
            [providerDisplayName(source), detail, state.paceLabel].compactMap { $0 }.joined(separator: ", ")
        )
    }

    private func quotaRail(percent: Double, expectedPercent: Double?, tint: Color) -> some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(.secondary.opacity(0.18))
                Capsule()
                    .fill(tint)
                    .frame(width: width * min(max(percent, 0), 100) / 100)
                if let expectedPercent {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 1.5, height: 3)
                        .offset(
                            x: min(
                                max(width * min(max(expectedPercent, 0), 100) / 100 - 0.75, 0),
                                max(width - 1.5, 0)
                            )
                        )
                }
            }
        }
        .frame(height: 3)
    }

    private func providerDisplayName(_ source: ProviderQuotaWidgetSource) -> String {
        ProviderQuotaDisplaySettings.displayName(
            providerID: source.providerID,
            fallback: source.providerLabel,
            aliasesData: providerAliasesData
        )
    }

    @ViewBuilder
    private func sidebarIcon(_ icon: Icon, tint: Color) -> some View {
        switch icon {
        case .asset(let name):
            SidebarUtilityIcon(assetImage: name, tint: tint)
        case .system(let name):
            Image(systemName: name)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 28)
                .accessibilityHidden(true)
        }
    }
}
