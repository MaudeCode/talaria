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
            .init(action: .newline, modifierFlags: .shift, title: "New Line", isHidden: true),
            .init(action: .newline, modifierFlags: .alternate, title: "New Line", isHidden: true),
            .init(action: .alternateSend, modifierFlags: .control, title: "Queue Message")
        ])
    }

    /// TAL-445: during a reply, long-pressing Send offers Steer, Queue and Stop and send, in that order. Each sends
    /// the draft through that behavior once; the stored default only marks its item and is never written.
    func testSendMenuDuringAReplySendsThroughEachBehaviorAndChecksTheDefault() {
        for defaultBehavior in StreamingSendBehavior.allCases {
            let options = ComposerSendButton.options(isWaitingForStream: true, carriesFiles: false, defaultBehavior: defaultBehavior)
            XCTAssertEqual(options.map(\.action), [.behavior(.steer), .behavior(.queue), .behavior(.interrupt), .command("background")])
            XCTAssertEqual(options.map(\.title), ["Steer", "Queue", "Stop and send", "Run in background"])
            XCTAssertEqual(options.map(\.subtitle), ["Steer active response", "Send after response", nil, nil])
            XCTAssertEqual(options.filter(\.isDefault).map(\.action), [.behavior(defaultBehavior)])
        }
    }

    /// Steering cannot carry files, so a tap with files queues: the menu drops Steer and checks Queue instead.
    func testSendMenuWithFilesDropsSteerAndChecksWhatATapDoes() {
        let options = ComposerSendButton.options(isWaitingForStream: true, carriesFiles: true, defaultBehavior: .steer)
        XCTAssertEqual(options.map(\.action), [.behavior(.queue), .behavior(.interrupt)])
        XCTAssertEqual(options.filter(\.isDefault).map(\.action), [.behavior(.queue)])
    }

    /// Between replies the ways to send during one, and their VoiceOver actions, are absent.
    func testSendMenuBetweenRepliesOffersNoStreamingBehavior() {
        let options = ComposerSendButton.options(isWaitingForStream: false, carriesFiles: false, defaultBehavior: .queue)
        XCTAssertEqual(options.map(\.action), [.command("btw"), .command("background")])
        XCTAssertFalse(options.contains(where: \.isDefault))
    }

    func testCommandReturnModeSendsOnCommandReturnAndInsertsANewlineOnReturn() {
        let commands = ComposerKeyboardCommand.commands(sendKey: .commandReturn, alternateBehavior: .steer)
        XCTAssertEqual(commands, [
            .init(action: .send, modifierFlags: .command, title: "Send Message"),
            .init(action: .newline, modifierFlags: [], title: "New Line"),
            .init(action: .newline, modifierFlags: .shift, title: "New Line", isHidden: true),
            .init(action: .newline, modifierFlags: .alternate, title: "New Line", isHidden: true),
            .init(action: .alternateSend, modifierFlags: .control, title: "Send Now")
        ])
    }

    @MainActor
    func testTextViewInstallsPriorityReturnCommandsForEachAction() {
        let textView = ComposerTextView.PastingTextView()
        let installed = (textView.keyCommands ?? []).filter { $0.input == ComposerKeyboardCommand.input }
        let newline = ComposerTextView.PastingTextView.selector(for: .newline)
        XCTAssertEqual(installed.map(\.action), [
            ComposerTextView.PastingTextView.selector(for: .send),
            newline,
            newline,
            newline,
            ComposerTextView.PastingTextView.selector(for: .alternateSend)
        ])
        XCTAssertEqual(installed.map(\.modifierFlags), [[], .command, .shift, .alternate, .control])
        XCTAssertEqual(installed.map { $0.attributes.contains(.hidden) }, [false, false, true, true, false])
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
