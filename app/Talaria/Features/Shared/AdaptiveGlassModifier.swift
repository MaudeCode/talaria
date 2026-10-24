import SwiftUI
import TalariaKit

/// A single root measurement, shared in physical window coordinates across navigation columns.
extension GeometryProxy {
    /// The size with the bars and keyboard it insets: what an `ArrangementView` reads when it decides to split, so a
    /// keyboard showing does not change whether a chat's companion page fits (TAL-1458).
    var sizeIncludingSafeArea: CGSize {
        CGSize(width: size.width, height: size.height + safeAreaInsets.top + safeAreaInsets.bottom)
    }
}

struct DivisionRegionGeometry: Equatable {
    var frame: CGRect = .zero
    var safeAreaInsets = EdgeInsets()
    var divisions: [CGRect] = []

    init() {}

    init(_ geometry: GeometryProxy, divisions override: [CGRect]? = nil) {
        frame = geometry.frame(in: .global)
        safeAreaInsets = geometry.safeAreaInsets
        let local: [CGRect]
        if let override {
            local = override
        } else if #available(iOS 27.1, *) {
            local = geometry.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed)
                .filter(\.isActive).map(\.frame)
        } else {
            local = []
        }
        divisions = local.map { $0.offsetBy(dx: frame.minX, dy: frame.minY) }
    }

    func needsHingeSettlement(comparedTo previous: Self?) -> Bool {
        guard let previous, previous.frame.size == frame.size else { return false }
        func verticalRanges(_ geometry: Self) -> [Range<CGFloat>] {
            geometry.divisions.filter { $0.height > $0.width }.map {
                ($0.minX - geometry.frame.minX)..<($0.maxX - geometry.frame.minX)
            }
        }
        return verticalRanges(previous) != verticalRanges(self)
    }

    func localDivisions(in geometry: GeometryProxy) -> [CGRect] {
        let origin = geometry.frame(in: .global).origin
        return divisions.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
    }
}

/// The sidebar decision's spatial inputs are admitted atomically after returning from an app-switch snapshot.
struct SidebarLayoutInputs: Equatable {
    var sizeClass: UserInterfaceSizeClass?
    var splitSize: CGSize = .zero
    var geometry = DivisionRegionGeometry()
    var hasVerticalBar = false
    var hingeStatus: SessionRunMonitor.HingeStatus?

    var isValid: Bool {
        sizeClass != nil && splitSize.width > 0 && splitSize.height > 0
            && geometry.frame.width > 0 && geometry.frame.height > 0
    }
}

/// Coalesces hinge movement only; ordinary container geometry stays live.
private struct SettledGeometryModifier<Value: Equatable>: ViewModifier {
    let measure: (GeometryProxy) -> Value
    let hingeStatus: SessionRunMonitor.HingeStatus?
    let requiresSettlement: (Value?, Value) -> Bool
    let action: (Value) -> Void
    @State private var settlement = DivisionRegionSettlement<Value>()
    @State private var pending: Task<Void, Never>?
    @State private var previous: Value?
    @State private var hingeIsChanging = false

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: Value.self, of: measure) { value in
                pending?.cancel()
                let shouldSettle = hingeIsChanging || requiresSettlement(previous, value)
                previous = value
                if let initial = settlement.observe(value, at: ProcessInfo.processInfo.systemUptime) {
                    action(initial)
                }
                if shouldSettle { scheduleSettlement() }
                else { applySettled(hingeIsSettled: true) }
            }
            .onChange(of: hingeStatus) {
                hingeIsChanging = true
                pending?.cancel()
                scheduleSettlement()
            }
            .onDisappear {
                pending?.cancel()
                hingeIsChanging = false
            }
    }

    private func scheduleSettlement() {
        pending = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(DivisionRegionSettlement<Value>.quietPeriod)) }
            catch { return }
            guard !Task.isCancelled else { return }
            hingeIsChanging = false
            applySettled()
        }
    }

    private func applySettled(hingeIsSettled: Bool = false) {
        if let value = settlement.settle(at: ProcessInfo.processInfo.systemUptime, hingeIsSettled: hingeIsSettled) {
            action(value)
        }
    }
}

extension View {
    func onSettledGeometryChange<Value: Equatable>(for type: Value.Type,
        hingeStatus: SessionRunMonitor.HingeStatus? = nil,
        requiresSettlement: @escaping (Value?, Value) -> Bool,
        of measure: @escaping (GeometryProxy) -> Value, action: @escaping (Value) -> Void) -> some View {
        modifier(SettledGeometryModifier(measure: measure, hingeStatus: hingeStatus,
            requiresSettlement: requiresSettlement, action: action))
    }
}

extension EnvironmentValues {
    @Entry var divisionRegionGeometry: DivisionRegionGeometry? = nil
    /// The sidebar's foreground gate also protects chat wrapping from app-switch snapshot sizes.
    @Entry var holdsForegroundLayout = false
    /// The split's destination width, independent of its moving column boundary.
    @Entry var targetChatLayoutWidth: CGFloat? = nil
    /// How much wider the composer will be at that destination; its strips' scroll views take that width early.
    @Entry var composerStripOverhang: CGFloat = 0
    @Entry var tabletopComposerHeight: CGFloat? = nil
}

/// Extends the shared adaptive-content modifiers to place a centered state inside one usable pane.
private struct FoldAvoidingPlacementModifier: ViewModifier {
    var avoidsHorizontalDivisions = true
    var isEnabled = true
    @Environment(\.divisionRegionGeometry) private var divisions
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var frame: CGRect = .zero

    func body(content: Content) -> some View {
        FoldAvoidingPlacementLayout(geometry: isEnabled ? divisions : nil, contentFrame: frame,
            layoutDirection: layoutDirection, avoidsHorizontalDivisions: avoidsHorizontalDivisions) {
            content
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
    }
}

/// Unlike the alert card's width-capped layout, states also occupy intrinsic-height List rows.
private struct FoldAvoidingPlacementLayout: Layout {
    let geometry: DivisionRegionGeometry?
    let contentFrame: CGRect
    let layoutDirection: LayoutDirection
    let avoidsHorizontalDivisions: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        size(proposal: proposal, subviews: subviews)
    }

    private func size(proposal: ProposedViewSize, subviews: Subviews) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let natural = content.sizeThatFits(proposal)
        guard let geometry, !geometry.divisions.isEmpty else { return natural }
        // An unavailable-state row may use the remaining viewport; populated lists never use this modifier.
        return CGSize(width: proposal.width ?? natural.width,
            height: proposal.height ?? max(natural.height, geometry.frame.maxY - contentFrame.minY))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let content = subviews.first else { return }
        let globalBounds = CGRect(origin: contentFrame.origin, size: bounds.size)
        let available = DivisionRegionLayout.availableFrame(in: globalBounds,
            divisions: geometry?.divisions ?? [], layoutDirection: layoutDirection,
            avoidsHorizontalDivisions: avoidsHorizontalDivisions, horizontalPlacement: .bottom)
        guard !available.isNull else { return }
        content.place(at: CGPoint(x: bounds.minX + available.midX - globalBounds.minX,
                                  y: bounds.minY + available.midY - globalBounds.minY), anchor: .center,
                      proposal: ProposedViewSize(available.size))
    }
}

private struct AdaptiveReadableContentModifier: ViewModifier {
    let maxWidth: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: maxWidth)
            .frame(maxWidth: .infinity)
    }
}

private struct AdaptiveReadableScrollContentModifier: ViewModifier {
    let maxWidth: CGFloat
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .background {
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, newWidth in
                            width = newWidth
                        }
                }
            }
            .contentMargins(
                .horizontal,
                max((width - maxWidth) / 2, 0),
                for: .scrollContent
            )
    }
}

extension View {
    func foldAvoidingPlacement(avoidsHorizontalDivisions: Bool = true, isEnabled: Bool = true) -> some View {
        modifier(FoldAvoidingPlacementModifier(avoidsHorizontalDivisions: avoidsHorizontalDivisions, isEnabled: isEnabled))
    }

    func adaptiveReadableContent(maxWidth: CGFloat) -> some View {
        modifier(AdaptiveReadableContentModifier(maxWidth: maxWidth))
    }

    func adaptiveReadableScrollContent(maxWidth: CGFloat) -> some View {
        modifier(AdaptiveReadableScrollContentModifier(maxWidth: maxWidth))
    }

    func adaptiveFormPresentation() -> some View {
        presentationSizing(.form)
    }

    func adaptivePagePresentation(width: CGFloat? = nil) -> some View {
        frame(width: width)
            .presentationSizing(.page.fitted(horizontal: width != nil, vertical: false))
    }

    func adaptiveSecondaryNavigationTitle(title: String? = nil) -> some View {
        modifier(AdaptiveSecondaryNavigationTitleModifier(title: title))
    }
}

private struct AdaptiveSecondaryNavigationTitleModifier: ViewModifier {
    var title: String?

    func body(content: Content) -> some View {
        content.navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let title {
                    ToolbarItem(placement: .principal) { Text(title).font(.headline).lineLimit(1) }
                }
            }
    }
}

private struct AdaptiveGlassModifier<S: Shape>: ViewModifier {
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(GlassPreference.isEnabledKey) private var isGlassEnabled = GlassPreference.defaultIsEnabled

    let style: AdaptiveGlassStyle
    let isInteractive: Bool
    let tint: Color?
    let fallbackMaterial: Material
    let shape: S

    @ViewBuilder
    func body(content: Content) -> some View {
        switch resolvedSurface {
        case .liquidGlass:
            if #available(iOS 26, *) {
                liquidGlassContent(content)
            } else {
                materialContent(content)
            }
        case .material:
            materialContent(content)
        case .opaque:
            opaqueContent(content)
        }
    }

    private var resolvedSurface: AdaptiveGlassSurface {
        AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: GlassPreference.isLiquidGlassSupported,
            isGlassEnabled: isGlassEnabled,
            reduceTransparency: reduceTransparency
        )
    }

    private var showsContrastStroke: Bool {
        reduceTransparency || colorSchemeContrast == .increased
    }

    private var contrastStrokeOpacity: Double {
        colorSchemeContrast == .increased ? 0.22 : 0.14
    }

    @available(iOS 26, *)
    private var resolvedGlass: Glass {
        switch style {
        case .regular:
            var glass = Glass.regular
            if let tint {
                glass = glass.tint(tint)
            }
            if isInteractive {
                glass = glass.interactive()
            }
            return glass
        }
    }

    @available(iOS 26, *)
    private func liquidGlassContent(_ content: Content) -> some View {
        content
            .glassEffect(resolvedGlass, in: shape)
            .adaptiveGlassAccessibilityStroke(
                shape: shape,
                isVisible: showsContrastStroke,
                opacity: contrastStrokeOpacity
            )
    }

    private func materialContent(_ content: Content) -> some View {
        content
            .background(fallbackMaterial, in: shape)
            .adaptiveGlassAccessibilityStroke(
                shape: shape,
                isVisible: showsContrastStroke,
                opacity: contrastStrokeOpacity
            )
    }

    private func opaqueContent(_ content: Content) -> some View {
        content
            .background(Color(.secondarySystemBackground), in: shape)
            .adaptiveGlassAccessibilityStroke(
                shape: shape,
                isVisible: true,
                opacity: contrastStrokeOpacity
            )
    }
}

private struct AdaptiveSoftScrollEdgeModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    let edges: Edge.Set
    var emphasizesTop = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *),
           AdaptiveScrollEdgeTreatment.resolve(
               softScrollEdgesAvailable: true,
               reduceTransparency: reduceTransparency
           ) == .soft {
            if emphasizesTop {
                content.scrollEdgeEffectStyle(.soft, for: edges.subtracting(.top))
                    .scrollEdgeEffectStyle(.hard, for: .top)
            } else {
                content.scrollEdgeEffectStyle(.soft, for: edges)
            }
        } else {
            content
        }
    }
}

struct AdaptiveGlassContainer<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(GlassPreference.isEnabledKey) private var isGlassEnabled = GlassPreference.defaultIsEnabled

    let spacing: CGFloat
    private let content: () -> Content

    init(spacing: CGFloat = 16, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        if #available(iOS 26, *), isGlassEnabled, !reduceTransparency {
            GlassEffectContainer(spacing: spacing) {
                content()
            }
        } else {
            content()
        }
    }
}

private extension View {
    @ViewBuilder
    func adaptiveGlassAccessibilityStroke<S: Shape>(
        shape: S,
        isVisible: Bool,
        opacity: Double
    ) -> some View {
        if isVisible {
            overlay(
                shape
                    .stroke(Color.primary.opacity(opacity), lineWidth: 1)
                    .allowsHitTesting(false)
            )
        } else {
            self
        }
    }
}

extension View {
    func adaptiveGlass(
        _ style: AdaptiveGlassStyle = .regular,
        isInteractive: Bool = false,
        tint: Color? = nil,
        fallbackMaterial: Material = .regularMaterial,
        in shape: some Shape
    ) -> some View {
        modifier(AdaptiveGlassModifier(
            style: style,
            isInteractive: isInteractive,
            tint: tint,
            fallbackMaterial: fallbackMaterial,
            shape: shape
        ))
    }

    func adaptiveSoftScrollEdges(_ edges: Edge.Set = [.top, .bottom], emphasizesTop: Bool = false) -> some View {
        modifier(AdaptiveSoftScrollEdgeModifier(edges: edges, emphasizesTop: emphasizesTop))
    }
}
