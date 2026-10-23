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
    var divisions: [CGRect] = []

    init() {}

    init(_ geometry: GeometryProxy, divisions override: [CGRect]? = nil) {
        frame = geometry.frame(in: .global)
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

    func localDivisions(in geometry: GeometryProxy) -> [CGRect] {
        let origin = geometry.frame(in: .global).origin
        return divisions.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
    }
}

extension EnvironmentValues {
    @Entry var divisionRegionGeometry: DivisionRegionGeometry? = nil
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

    func adaptivePagePresentation() -> some View {
        presentationSizing(.page)
    }

    func adaptiveSecondaryNavigationTitle() -> some View {
        modifier(AdaptiveSecondaryNavigationTitleModifier())
    }
}

private struct AdaptiveSecondaryNavigationTitleModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        content.navigationBarTitleDisplayMode(horizontalSizeClass == .regular ? .inline : .automatic)
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

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *),
           AdaptiveScrollEdgeTreatment.resolve(
               softScrollEdgesAvailable: true,
               reduceTransparency: reduceTransparency
           ) == .soft {
            content.scrollEdgeEffectStyle(.soft, for: edges)
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

    func adaptiveSoftScrollEdges(_ edges: Edge.Set = [.top, .bottom]) -> some View {
        modifier(AdaptiveSoftScrollEdgeModifier(edges: edges))
    }
}
