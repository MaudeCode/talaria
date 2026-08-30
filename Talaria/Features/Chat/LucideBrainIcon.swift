import SwiftUI
import UIKit

struct LucideBrainIcon: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / 24, size.height / 24)
            let xOffset = (size.width - (24 * scale)) / 2
            let yOffset = (size.height - (24 * scale)) / 2

            context.translateBy(x: xOffset, y: yOffset)
            context.scaleBy(x: scale, y: scale)

            let strokeStyle = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
            for path in Self.paths {
                context.stroke(path, with: .foreground, style: strokeStyle)
            }
        }
        .accessibilityHidden(true)
    }

    private static let paths: [Path] = [
        Path { path in
            path.move(to: CGPoint(x: 12, y: 18))
            path.addLine(to: CGPoint(x: 12, y: 5))
        },
        Path { path in
            path.move(to: CGPoint(x: 15, y: 13))
            path.addCurve(
                to: CGPoint(x: 12, y: 9),
                control1: CGPoint(x: 13.4, y: 12.4),
                control2: CGPoint(x: 12, y: 10.8)
            )
            path.addCurve(
                to: CGPoint(x: 9, y: 13),
                control1: CGPoint(x: 12, y: 10.8),
                control2: CGPoint(x: 10.6, y: 12.4)
            )
        },
        Path { path in
            path.move(to: CGPoint(x: 17.6, y: 6.5))
            path.addCurve(to: CGPoint(x: 12, y: 5), control1: CGPoint(x: 18.2, y: 3.7), control2: CGPoint(x: 14.1, y: 2.4))
            path.addCurve(to: CGPoint(x: 6.4, y: 6.5), control1: CGPoint(x: 9.9, y: 2.4), control2: CGPoint(x: 5.8, y: 3.7))
        },
        Path { path in
            path.move(to: CGPoint(x: 18, y: 5.1))
            path.addCurve(to: CGPoint(x: 20.5, y: 10.9), control1: CGPoint(x: 21, y: 5.6), control2: CGPoint(x: 22, y: 8.7))
        },
        Path { path in
            path.move(to: CGPoint(x: 18, y: 18))
            path.addCurve(to: CGPoint(x: 20, y: 10.5), control1: CGPoint(x: 22, y: 17.1), control2: CGPoint(x: 22.7, y: 12.4))
        },
        Path { path in
            path.move(to: CGPoint(x: 20, y: 17.5))
            path.addCurve(to: CGPoint(x: 12, y: 18), control1: CGPoint(x: 19.4, y: 22.5), control2: CGPoint(x: 12.6, y: 22.8))
            path.addCurve(to: CGPoint(x: 4, y: 17.5), control1: CGPoint(x: 11.4, y: 22.8), control2: CGPoint(x: 4.6, y: 22.5))
        },
        Path { path in
            path.move(to: CGPoint(x: 6, y: 18))
            path.addCurve(to: CGPoint(x: 4, y: 10.5), control1: CGPoint(x: 2, y: 17.1), control2: CGPoint(x: 1.3, y: 12.4))
        },
        Path { path in
            path.move(to: CGPoint(x: 6, y: 5.1))
            path.addCurve(to: CGPoint(x: 3.5, y: 10.9), control1: CGPoint(x: 3, y: 5.6), control2: CGPoint(x: 2, y: 8.7))
        }
    ]
}
