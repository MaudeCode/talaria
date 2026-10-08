import AVFoundation
import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of ComposerVoiceDraftComposerTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class ComposerVoiceDraftComposerTests: XCTestCase {
    func testReturnModeSendsOnReturnAndInsertsANewlineOnCommandReturn() {
        let commands = ComposerKeyboardCommand.commands(sendKey: .return, alternateBehavior: .queue)
        XCTAssertEqual(commands, [
            .init(action: .send, modifierFlags: [], title: "Send Message"),
            .init(action: .newline, modifierFlags: .command, title: "New Line"),
            .init(action: .alternateSend, modifierFlags: .control, title: "Queue Message")
        ])
    }

    func testCommandReturnModeSendsOnCommandReturnAndLeavesReturnToTheTextView() {
        let commands = ComposerKeyboardCommand.commands(sendKey: .commandReturn, alternateBehavior: .steer)
        XCTAssertEqual(commands, [
            .init(action: .send, modifierFlags: .command, title: "Send Message"),
            .init(action: .alternateSend, modifierFlags: .control, title: "Send Now")
        ])
    }

    @MainActor
    func testTextViewInstallsPriorityReturnCommandsForEachAction() {
        let textView = ComposerTextView.PastingTextView()
        let installed = (textView.keyCommands ?? []).filter { $0.input == ComposerKeyboardCommand.input }
        XCTAssertEqual(installed.map(\.action), [
            ComposerTextView.PastingTextView.selector(for: .send),
            ComposerTextView.PastingTextView.selector(for: .newline),
            ComposerTextView.PastingTextView.selector(for: .alternateSend)
        ])
        XCTAssertEqual(installed.map(\.modifierFlags), [[], .command, .control])
        XCTAssertTrue(installed.allSatisfy(\.wantsPriorityOverSystemBehavior))
    }

    @MainActor
    func testKeyboardSendsWaitForTheGateAndMarkedTextWhileTheNewlineOnlyWaitsForMarkedText() {
        let textView = ComposerTextView.PastingTextView()
        var sent: [StreamingSendBehavior?] = []
        textView.onKeyboardSend = { sent.append($0) }
        textView.alternateSendBehavior = .queue
        let send = ComposerTextView.PastingTextView.selector(for: .send)
        let alternateSend = ComposerTextView.PastingTextView.selector(for: .alternateSend)
        let newline = ComposerTextView.PastingTextView.selector(for: .newline)

        textView.isKeyboardSendEnabled = false
        XCTAssertFalse(textView.canPerformAction(send, withSender: nil))
        XCTAssertFalse(textView.canPerformAction(alternateSend, withSender: nil))
        XCTAssertTrue(textView.canPerformAction(newline, withSender: nil))
        textView.sendMessageFromKeyboard()
        textView.sendAlternateFromKeyboard()
        XCTAssertEqual(sent, [])

        textView.isKeyboardSendEnabled = true
        textView.sendMessageFromKeyboard()
        textView.sendAlternateFromKeyboard()
        XCTAssertEqual(sent, [nil, .queue])

        textView.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        XCTAssertNotNil(textView.markedTextRange)
        XCTAssertFalse(textView.canPerformAction(send, withSender: nil))
        XCTAssertFalse(textView.canPerformAction(alternateSend, withSender: nil))
        XCTAssertFalse(textView.canPerformAction(newline, withSender: nil))
        textView.unmarkText()

        textView.insertNewlineFromKeyboard()
        XCTAssertEqual(textView.text, "か\n")
    }

    func testVoiceInputAudioSessionConfigurationDoesNotDuckOtherAudio() {
        XCTAssertEqual(ComposerVoiceAudioSessionConfiguration.category, .playAndRecord)
        XCTAssertEqual(ComposerVoiceAudioSessionConfiguration.mode, .measurement)
        XCTAssertTrue(ComposerVoiceAudioSessionConfiguration.options.contains(.mixWithOthers))
        XCTAssertTrue(ComposerVoiceAudioSessionConfiguration.options.contains(.allowBluetoothHFP))
        XCTAssertFalse(ComposerVoiceAudioSessionConfiguration.options.contains(.duckOthers))
    }
}
