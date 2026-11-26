import SwiftUI
import TalariaKit
import UIKit

/// Native fit and zoom for the framebuffer, with input attached only while this viewer owns the lease.
struct ScreenCanvas: UIViewRepresentable {
    let viewer: ScreenSession
    let image: CGImage
    let canSendInput: Bool
    let showsKeyboard: Bool

    func makeUIView(context: Context) -> ScreenCanvasView {
        ScreenCanvasView(viewer: viewer)
    }

    func updateUIView(_ view: ScreenCanvasView, context: Context) {
        view.update(image: image, canSendInput: canSendInput, showsKeyboard: showsKeyboard)
    }
}

final class ScreenCanvasView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate, UIKeyInput {
    private let viewer: ScreenSession
    private let scroll = UIScrollView()
    private let picture = UIImageView()
    private let hiddenKeyboard = UIView(frame: .zero)
    private var fit = CGSize.zero
    private var pixels = CGSize.zero
    private var canSendInput = false
    private var showsKeyboard = false
    private var wheelTravel: CGFloat = 0
    private var pressedKeys: [UIKeyboardHIDUsage: UInt32] = [:]

    init(viewer: ScreenSession) {
        self.viewer = viewer
        super.init(frame: .zero)
        accessibilityLabel = String(localized: "Agent desktop")
        isAccessibilityElement = true
        accessibilityTraits = .image
        accessibilityIdentifier = "screen-desktop"
        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.contentInsetAdjustmentBehavior = .never
        addSubview(scroll)
        picture.isUserInteractionEnabled = true
        scroll.addSubview(picture)
        picture.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(clicked)))
        picture.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(rightClicked)))
        let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged))
        drag.maximumNumberOfTouches = 1
        picture.addGestureRecognizer(drag)
        let wheel = UIPanGestureRecognizer(target: self, action: #selector(scrolled))
        wheel.minimumNumberOfTouches = 2
        wheel.maximumNumberOfTouches = 2
        wheel.delegate = self
        picture.addGestureRecognizer(wheel)
        picture.gestureRecognizers?.forEach { $0.isEnabled = false }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func update(image: CGImage, canSendInput: Bool, showsKeyboard: Bool) {
        if picture.image?.cgImage !== image { picture.image = UIImage(cgImage: image) }
        let size = CGSize(width: image.width, height: image.height)
        if size != pixels {
            pixels = size
            setNeedsLayout()
        }
        guard self.canSendInput != canSendInput || self.showsKeyboard != showsKeyboard else { return }
        self.canSendInput = canSendInput
        self.showsKeyboard = showsKeyboard
        picture.gestureRecognizers?.forEach { $0.isEnabled = canSendInput }
        scroll.panGestureRecognizer.minimumNumberOfTouches = canSendInput ? 2 : 1
        updateKeyboard()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { updateKeyboard() }
    }

    private func updateKeyboard() {
        if canSendInput {
            if isFirstResponder { reloadInputViews() } else { becomeFirstResponder() }
        } else {
            resignFirstResponder()
            pressedKeys.removeAll()
        }
    }

    override var canBecomeFirstResponder: Bool { canSendInput }
    override var inputView: UIView? { showsKeyboard ? nil : hiddenKeyboard }
    var hasText: Bool { true }

    func insertText(_ text: String) {
        for scalar in text.unicodeScalars {
            if let key = Self.symbol(for: scalar) { press(key) }
        }
    }

    func deleteBackward() { press(0xFF08) }

    private func press(_ symbol: UInt32) {
        viewer.key(symbol, down: true)
        viewer.key(symbol, down: false)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let unhandled = presses.filter { press in
            guard let key = press.key, let symbol = Self.symbol(for: key) else { return true }
            pressedKeys[key.keyCode] = symbol
            viewer.key(symbol, down: true)
            return false
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let unhandled = release(presses)
        if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let unhandled = release(presses)
        if !unhandled.isEmpty { super.pressesCancelled(unhandled, with: event) }
    }

    private func release(_ presses: Set<UIPress>) -> Set<UIPress> {
        presses.filter { press in
            guard let key = press.key, let symbol = pressedKeys.removeValue(forKey: key.keyCode) else { return true }
            viewer.key(symbol, down: false)
            return false
        }
    }

    private static func symbol(for scalar: Unicode.Scalar) -> UInt32? {
        switch scalar.value {
        case 9: 0xFF09
        case 10, 13: 0xFF0D
        case 32...126, 160...255: scalar.value
        case 256...: 0x0100_0000 | scalar.value
        default: nil
        }
    }

    private static func symbol(for key: UIKey) -> UInt32? {
        switch key.keyCode {
        case .keyboardEscape: return 0xFF1B
        case .keyboardTab: return 0xFF09
        case .keyboardReturnOrEnter, .keypadEnter: return 0xFF0D
        case .keyboardDeleteOrBackspace: return 0xFF08
        case .keyboardDeleteForward: return 0xFFFF
        case .keyboardLeftArrow: return 0xFF51
        case .keyboardUpArrow: return 0xFF52
        case .keyboardRightArrow: return 0xFF53
        case .keyboardDownArrow: return 0xFF54
        case .keyboardLeftShift, .keyboardRightShift: return 0xFFE1
        case .keyboardLeftControl, .keyboardRightControl: return 0xFFE3
        case .keyboardLeftAlt, .keyboardRightAlt: return 0xFFE9
        case .keyboardLeftGUI, .keyboardRightGUI: return 0xFFEB
        default:
            let chord = !key.modifierFlags.intersection([.control, .alternate, .command]).isEmpty
            let text = chord ? key.charactersIgnoringModifiers : key.characters
            return text.unicodeScalars.first.flatMap { symbol(for: $0) }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scroll.frame = bounds
        guard pixels.width > 0, pixels.height > 0, !bounds.isEmpty else { return }
        let scale = min(bounds.width / pixels.width, bounds.height / pixels.height)
        let size = CGSize(width: pixels.width * scale, height: pixels.height * scale)
        if fit != size {
            let zoom = scroll.zoomScale
            scroll.zoomScale = 1
            picture.frame = CGRect(origin: .zero, size: size)
            scroll.contentSize = size
            fit = size
            scroll.zoomScale = zoom
        }
        centerPicture()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerPicture() }

    private func centerPicture() {
        let x = max(0, (bounds.width - scroll.contentSize.width) / 2)
        let y = max(0, (bounds.height - scroll.contentSize.height) / 2)
        scroll.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let pan = recognizer as? UIPanGestureRecognizer, pan.minimumNumberOfTouches == 2 else {
            return super.gestureRecognizerShouldBegin(recognizer)
        }
        return canSendInput && scroll.zoomScale == scroll.minimumZoomScale
    }

    @objc private func clicked(_ recognizer: UITapGestureRecognizer) {
        click(at: recognizer.location(in: picture), mask: 1)
    }

    @objc private func rightClicked(_ recognizer: UILongPressGestureRecognizer) {
        if recognizer.state == .began { click(at: recognizer.location(in: picture), mask: 4) }
    }

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        let down = recognizer.state == .began || recognizer.state == .changed
        pointer(at: recognizer.location(in: picture), mask: down ? 1 : 0)
    }

    @objc private func scrolled(_ recognizer: UIPanGestureRecognizer) {
        if recognizer.state == .began { wheelTravel = 0 }
        wheelTravel += recognizer.translation(in: self).y
        recognizer.setTranslation(.zero, in: self)
        while abs(wheelTravel) >= 24 {
            click(at: recognizer.location(in: picture), mask: wheelTravel > 0 ? 8 : 16)
            wheelTravel += wheelTravel > 0 ? -24 : 24
        }
    }

    private func click(at point: CGPoint, mask: UInt8) {
        pointer(at: point, mask: mask)
        pointer(at: point, mask: 0)
    }

    private func pointer(at point: CGPoint, mask: UInt8) {
        guard canSendInput, fit.width > 0, fit.height > 0 else { return }
        viewer.pointer(x: Int(point.x / fit.width * pixels.width), y: Int(point.y / fit.height * pixels.height),
                       buttonMask: mask)
    }
}
