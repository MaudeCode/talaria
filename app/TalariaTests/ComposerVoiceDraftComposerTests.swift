import AVFoundation
import XCTest
@testable import Talaria
@testable import TalariaKit

// The members of ComposerVoiceDraftComposerTests that need the App host; the rest run in TalariaKitTests (TAL-399).
final class ComposerVoiceDraftComposerTests: XCTestCase {
    func testComposerSendKeyboardCommandIsDiscoverableCommandReturn() {
        XCTAssertEqual(ComposerKeyboardCommand.title, "Send Message")
        XCTAssertEqual(ComposerKeyboardCommand.input, "\r")
        XCTAssertEqual(ComposerKeyboardCommand.modifierFlags, .command)
    }

    func testVoiceInputAudioSessionConfigurationDoesNotDuckOtherAudio() {
        XCTAssertEqual(ComposerVoiceAudioSessionConfiguration.category, .playAndRecord)
        XCTAssertEqual(ComposerVoiceAudioSessionConfiguration.mode, .measurement)
        XCTAssertTrue(ComposerVoiceAudioSessionConfiguration.options.contains(.mixWithOthers))
        XCTAssertTrue(ComposerVoiceAudioSessionConfiguration.options.contains(.allowBluetoothHFP))
        XCTAssertFalse(ComposerVoiceAudioSessionConfiguration.options.contains(.duckOthers))
    }
}
