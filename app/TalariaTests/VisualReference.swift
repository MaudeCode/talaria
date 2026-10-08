import CoreGraphics
import SwiftUI
import UIKit
import XCTest

/// Off-screen visual references for SwiftUI surfaces.
///
/// A test hands over a view plus a fixed size and appearance; the harness
/// renders it with `ImageRenderer` and compares the pixels against a PNG
/// checked into `TalariaTests/VisualReferences`. Mismatches fail the test and
/// attach the reference, the render, and a diff to the result bundle, so CI
/// reports what moved instead of quietly rewriting the reference.
///
/// See `docs/visual-references.md` for the intentional-update procedure.
enum VisualReference {
    /// `xcodebuild` does not forward host environment variables into the
    /// simulator test process, so `TALARIA_RECORD_VISUAL_REFERENCES=1
    /// scripts/test-ios` drops this marker beside the references for the length
    /// of the run instead. CI never sets the variable, the marker is ignored by
    /// Git, and a recording run always fails, so a rewritten reference can only
    /// reach `main` through a reviewed commit.
    static let recordMarkerName = ".record"

    /// Per-channel difference an individual pixel may drift before it counts as
    /// changed. Absorbs subpixel antialiasing between simulator runtime builds.
    static let channelTolerance = 12

    /// Fraction of the image allowed to exceed `channelTolerance`. A moved
    /// glyph, a shifted layout, or a recolored surface moves far more than this.
    static let changedPixelTolerance = 0.002

    static let referencesDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("VisualReferences", isDirectory: true)

    @MainActor
    static func assertMatchesReference(
        _ content: some View,
        named name: String,
        size: CGSize,
        colorScheme: ColorScheme = .light,
        dynamicTypeSize: DynamicTypeSize = .large,
        background: Color = Color(.systemBackground),
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let rendered = try render(
            content,
            size: size,
            colorScheme: colorScheme,
            dynamicTypeSize: dynamicTypeSize,
            background: background
        )
        let referenceURL = referencesDirectory.appendingPathComponent("\(name).png")

        if isRecording {
            try record(rendered, to: referenceURL, name: name)
            XCTFail(
                """
                Recorded visual reference "\(name)". Re-run without \
                TALARIA_RECORD_VISUAL_REFERENCES and review the image diff before committing.
                """,
                file: file,
                line: line
            )
            return
        }

        guard let referenceData = try? Data(contentsOf: referenceURL),
              let reference = UIImage(data: referenceData)?.cgImage
        else {
            attach(rendered, name: "\(name).rendered")
            XCTFail(
                """
                No visual reference named "\(name)". Record it with \
                TALARIA_RECORD_VISUAL_REFERENCES=1 scripts/test-ios and commit \
                TalariaTests/VisualReferences/\(name).png.
                """,
                file: file,
                line: line
            )
            return
        }

        guard reference.width == rendered.width, reference.height == rendered.height else {
            attach(reference, name: "\(name).reference")
            attach(rendered, name: "\(name).rendered")
            XCTFail(
                """
                Visual reference "\(name)" changed size: expected \
                \(reference.width)x\(reference.height), rendered \
                \(rendered.width)x\(rendered.height).
                """,
                file: file,
                line: line
            )
            return
        }

        let comparison = try compare(reference: reference, rendered: rendered)
        guard comparison.changedFraction > changedPixelTolerance else { return }

        attach(reference, name: "\(name).reference")
        attach(rendered, name: "\(name).rendered")
        attach(comparison.diff, name: "\(name).diff")
        XCTFail(
            """
            Visual reference "\(name)" changed: \
            \(String(format: "%.3f%%", comparison.changedFraction * 100)) of pixels differ \
            (tolerance \(String(format: "%.3f%%", changedPixelTolerance * 100))). \
            Inspect the attached diff. If the change is intended, re-record with \
            TALARIA_RECORD_VISUAL_REFERENCES=1 scripts/test-ios.
            """,
            file: file,
            line: line
        )
    }

    // MARK: - Rendering

    @MainActor
    private static func render(
        _ content: some View,
        size: CGSize,
        colorScheme: ColorScheme,
        dynamicTypeSize: DynamicTypeSize,
        background: Color
    ) throws -> CGImage {
        let renderer = ImageRenderer(
            content: content
                .frame(width: size.width, height: size.height)
                .background(background)
                .environment(\.colorScheme, colorScheme)
                .environment(\.dynamicTypeSize, dynamicTypeSize)
                .environment(\.locale, Locale(identifier: "en_US"))
        )
        renderer.scale = 2
        renderer.isOpaque = true
        let lazyImage = try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no image")
        return try settledPixels(of: lazyImage)
    }

    /// `ImageRenderer.cgImage` draws its pixels lazily on the GPU. On a cold simulator a slow
    /// pipeline build outlasted the image provider's wait, so the first read returned an
    /// unfinished image (TAL-675). Reads until two in a row agree, turning the run loop in
    /// between, so comparison, attachments and recording all see the finished pixels.
    /// ponytail: two equal unfinished reads would still pass; a bounded wait covers the
    /// observed 10 s pipeline build.
    @MainActor
    private static func settledPixels(of lazyImage: CGImage) throws -> CGImage {
        var previous = try pixels(of: lazyImage)
        for _ in 0..<20 {
            var current = try pixels(of: lazyImage)
            if current == previous {
                return try image(from: &current, width: lazyImage.width, height: lazyImage.height)
            }
            previous = current
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.5))
        }
        throw VisualReferenceError.renderNeverSettled
    }

    private static var isRecording: Bool {
        FileManager.default.fileExists(
            atPath: referencesDirectory.appendingPathComponent(recordMarkerName).path
        )
    }

    private static func record(_ image: CGImage, to url: URL, name: String) throws {
        try FileManager.default.createDirectory(
            at: referencesDirectory,
            withIntermediateDirectories: true
        )
        let data = try XCTUnwrap(UIImage(cgImage: image).pngData(), "PNG encoding failed")
        try data.write(to: url, options: .atomic)
        attach(image, name: "\(name).recorded")
    }

    // MARK: - Comparison

    private struct Comparison {
        let changedFraction: Double
        let diff: CGImage
    }

    private static func compare(reference: CGImage, rendered: CGImage) throws -> Comparison {
        let width = reference.width
        let height = reference.height
        let referencePixels = try pixels(of: reference)
        let renderedPixels = try pixels(of: rendered)

        var diffPixels = [UInt8](repeating: 0, count: width * height * 4)
        var changedCount = 0

        for index in stride(from: 0, to: referencePixels.count, by: 4) {
            let delta = (0..<3).reduce(0) { partial, channel in
                max(partial, abs(Int(referencePixels[index + channel]) - Int(renderedPixels[index + channel])))
            }
            let isChanged = delta > channelTolerance
            if isChanged { changedCount += 1 }

            // Changed pixels burn red; everything else fades to a grey plate so
            // the reviewer sees where in the layout the change landed.
            let luminance = UInt8(
                (Int(renderedPixels[index]) + Int(renderedPixels[index + 1]) + Int(renderedPixels[index + 2])) / 3
            )
            diffPixels[index] = isChanged ? 255 : luminance / 3 + 160
            diffPixels[index + 1] = isChanged ? 0 : luminance / 3 + 160
            diffPixels[index + 2] = isChanged ? 0 : luminance / 3 + 160
            diffPixels[index + 3] = 255
        }

        return Comparison(
            changedFraction: Double(changedCount) / Double(width * height),
            diff: try image(from: &diffPixels, width: width, height: height)
        )
    }

    private static func pixels(of image: CGImage) throws -> [UInt8] {
        let width = image.width
        let height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let drew = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let context = makeContext(raw.baseAddress, width: width, height: height) else {
                return false
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else { throw VisualReferenceError.bitmapContextUnavailable }
        return buffer
    }

    private static func image(from buffer: inout [UInt8], width: Int, height: Int) throws -> CGImage {
        let made = buffer.withUnsafeMutableBytes { raw -> CGImage? in
            makeContext(raw.baseAddress, width: width, height: height)?.makeImage()
        }
        guard let made else { throw VisualReferenceError.bitmapContextUnavailable }
        return made
    }

    private static func makeContext(
        _ data: UnsafeMutableRawPointer?,
        width: Int,
        height: Int
    ) -> CGContext? {
        CGContext(
            data: data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    }

    // MARK: - Reporting

    private static func attach(_ image: CGImage, name: String) {
        XCTContext.runActivity(named: name) { activity in
            let attachment = XCTAttachment(image: UIImage(cgImage: image))
            attachment.name = name
            attachment.lifetime = .keepAlways
            activity.add(attachment)
        }
    }
}

enum VisualReferenceError: Error, CustomStringConvertible {
    case bitmapContextUnavailable
    case renderNeverSettled

    var description: String {
        switch self {
        case .bitmapContextUnavailable:
            "Could not create the bitmap context used to compare visual references."
        case .renderNeverSettled:
            "ImageRenderer kept returning different pixels for 10 seconds."
        }
    }
}
