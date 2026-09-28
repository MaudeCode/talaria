import SwiftUI
import TalariaKit

struct AppSidebarContainer<Sidebar: View, Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding private var isPresented: Bool
    @State private var dragTranslation: CGFloat = 0

    private let sidebar: Sidebar
    private let content: Content

    init(
        isPresented: Binding<Bool>,
        @ViewBuilder sidebar: () -> Sidebar,
        @ViewBuilder content: () -> Content
    ) {
        _isPresented = isPresented
        self.sidebar = sidebar()
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            let revealWidth = min(360, proxy.size.width * 0.84)
            let progress = progress(revealWidth: revealWidth)
            let horizontalDirection: CGFloat = layoutDirection == .rightToLeft ? -1 : 1
            let surfaceTint = colorScheme == .dark ? Color.white : Color.black
            let surfaceWidth = proxy.size.width
                + proxy.safeAreaInsets.leading
                + proxy.safeAreaInsets.trailing
            let surfaceHeight = proxy.size.height
                + proxy.safeAreaInsets.top
                + proxy.safeAreaInsets.bottom

            ZStack(alignment: .topLeading) {
                Color(.systemBackground)
                    .ignoresSafeArea()

                sidebar
                    .frame(width: revealWidth, height: proxy.size.height)
                    .scaleEffect(reduceMotion ? 1 : 0.96 + 0.04 * progress, anchor: .leading)
                    .opacity(reduceMotion ? 1 : 0.25 + 0.75 * progress)

                content
                    .frame(width: surfaceWidth, height: surfaceHeight)
                    .overlay {
                        if isPresented {
                            surfaceTint.opacity(0.12 * progress)
                                .contentShape(Rectangle())
                                .highPriorityGesture(
                                    dragGesture(
                                        containerWidth: proxy.size.width,
                                        revealWidth: revealWidth
                                    )
                                )
                                .onTapGesture { isPresented = false }
                                .accessibilityHidden(true)
                        } else {
                            surfaceTint.opacity(0.12 * progress)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .clipShape(surfaceShape(progress: progress))
                    .shadow(
                        color: .black.opacity(0.28 * progress),
                        radius: 24 * progress,
                        x: -8 * horizontalDirection * progress
                    )
                    .offset(
                        x: revealWidth * progress * horizontalDirection
                            - proxy.safeAreaInsets.leading,
                        y: -proxy.safeAreaInsets.top
                    )
                    .accessibilityHidden(isPresented)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("app-main-surface")

                if !isPresented {
                    Color.clear
                        .frame(width: AppSidebarGesturePolicy.edgeActivationWidth)
                        .contentShape(Rectangle())
                        .gesture(
                            dragGesture(
                                containerWidth: proxy.size.width,
                                revealWidth: revealWidth
                            )
                        )
                        .accessibilityHidden(true)
                }
            }
        }
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .snappy(duration: 0.28),
            value: isPresented
        )
    }

    private func progress(revealWidth: CGFloat) -> CGFloat {
        AppSidebarGesturePolicy.progress(
            isPresented: isPresented,
            translationWidth: dragTranslation,
            revealWidth: revealWidth,
            isRightToLeft: layoutDirection == .rightToLeft
        )
    }

    private func surfaceShape(progress: CGFloat) -> AnyShape {
        if #available(iOS 26.0, *) {
            AnyShape(
                ConcentricRectangle(
                    corners: .concentric(minimum: .fixed(56 * progress))
                )
            )
        } else {
            AnyShape(RoundedRectangle(cornerRadius: 42 * progress, style: .continuous))
        }
    }

    private func dragGesture(
        containerWidth: CGFloat,
        revealWidth: CGFloat
    ) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { value in
                guard AppSidebarGesturePolicy.accepts(
                    isPresented: isPresented,
                    startX: value.startLocation.x,
                    containerWidth: containerWidth,
                    translation: value.translation,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) else { return }

                dragTranslation = value.translation.width
            }
            .onEnded { value in
                defer { dragTranslation = 0 }

                guard AppSidebarGesturePolicy.accepts(
                    isPresented: isPresented,
                    startX: value.startLocation.x,
                    containerWidth: containerWidth,
                    translation: value.translation,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) else { return }

                isPresented = AppSidebarGesturePolicy.progress(
                    isPresented: isPresented,
                    translationWidth: value.predictedEndTranslation.width,
                    revealWidth: revealWidth,
                    isRightToLeft: layoutDirection == .rightToLeft
                ) >= 0.5
            }
    }
}
